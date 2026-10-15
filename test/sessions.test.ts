import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { mountChat, type ChatHandle } from "../src/chat.ts";
import { chatCommands } from "../src/commands.ts";
import { commandCompletion } from "../src/completion.ts";
import { openPersistentChat } from "../src/session.ts";
import { SessionCatalog, startupSessionPicker } from "../src/sessions.ts";
import { lockLost, model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;
async function until(predicate: () => boolean, detail: () => string = () => "") {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for session selection.\n" + detail());
}

test("managed stores are private, unique and grouped by workspace; picker filters saved cwd without running models or stealing a live lock", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-session-catalog-"))), home = join(directory, "data");
  const cwd = join(directory, "project"), other = join(directory, "other");
  await mkdir(cwd); await mkdir(other);
  const catalog = new SessionCatalog(home), { models, faux } = testModels();
  const files = [await catalog.newFile(cwd, "Investigation / ../ one"), await catalog.newFile(cwd, "Second"), await catalog.newFile(other, "Other")];
  let active: ChatHandle | undefined;
  try {
    assert.notEqual(files[0], files[1]); assert.equal(files[0].split("/").at(-2), files[1].split("/").at(-2));
    assert.notEqual(files[0].split("/").at(-2), files[2].split("/").at(-2));
    for (const [index, file] of files.entries()) {
      const chat = await openPersistentChat(file, models, { model, defaultCwd: index === 2 ? other : cwd, onLockLost: lockLost }); await chat.close();
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    const legacy = await openPersistentChat(join(home, "default.sqlite"), models, { model, defaultCwd: cwd, onLockLost: lockLost }); await legacy.close();
    const corrupt = join(files[0], "..", "corrupt.sqlite"); await writeFile(corrupt, "not a database");
    const listed = await catalog.list(cwd, lockLost);
    assert.deepEqual(new Set(listed.choices.map((item) => item.file)), new Set([files[0], files[1], join(home, "default.sqlite")]));
    assert(listed.diagnostics.some((text) => text.includes("corrupt.sqlite")));
    assert.equal(faux.state.callCount, 0);
    active = await openPersistentChat(files[0], models, { onLockLost: lockLost });
    assert(!(await catalog.list(cwd, lockLost)).choices.some((item) => item.file === active!.file));
    assert((await catalog.list(cwd, lockLost, active)).choices.some((item) => item.file === active!.file && item.description.includes("current")));
    assert.equal((await active.harness.inspect(context)).scheduling, "paused");
    // Rebinding changes the actual saved workspace; the old project picker must not offer it.
    await active.conversation.configure({ cwd: other }, context); await active.close(); active = undefined;
    assert(!(await catalog.list(cwd, lockLost)).choices.some((item) => item.file === files[0]));
    assert((await catalog.list(other, lockLost)).choices.some((item) => item.file === files[0]));
    assert.equal(faux.state.callCount, 0);
    for (const file of [...files, join(home, "default.sqlite"), corrupt]) await assert.rejects(access(`${file}.lock`), { code: "ENOENT" });
  } finally { await active?.close(); await rm(directory, { recursive: true, force: true }); }
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-session-switch-")));
  const catalog = new SessionCatalog(join(directory, "data"));
  const { models, faux } = testModels({ models: [{ id: "faux-1", reasoning: true }], responses: [fauxAssistantMessage("Old session answer."), fauxAssistantMessage("New session answer.")] });
  const make = async (file: string, fresh = false, previous?: ChatHandle): Promise<ChatHandle> => {
    const agent = previous && await previous.conversation.agent(context);
    const chat = await openPersistentChat(file, models, {
      ...(fresh ? { model: agent?.model ?? model, thinkingLevel: agent?.thinkingLevel ?? "high", defaultCwd: agent?.cwd ?? directory } : {}),
      onLockLost: lockLost,
    });
    chat.command = chatCommands(chat, models); chat.completion = commandCompletion(chat, models);
    chat.sessions = {
      newFile: (name) => catalog.newFile(directory, name),
      list: (signal) => catalog.list(directory, lockLost, chat, signal),
      open: (path, fresh) => make(path, fresh, chat),
    };
    return chat;
  };
  const first = await make(await catalog.newFile(directory, "first"), true);
  const terminal = new TestTerminal(110, 36), app = await mountChat(first, terminal, false);
  const send = async (text: string) => { app.ui.composer.editor.setText(text); terminal.send("\r"); await terminal.flush(); };
  return { directory, catalog, models, faux, make, first, terminal, app, send };
}

test("/session-new hands off ownership without resetting old history/settings or dropping the newer draft; /resume selects the saved project session", { timeout: 10000 }, async (t) => {
  const f = await fixture();
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    await f.send("Old input."); await f.first.conversation.waitForIdle(context); await f.terminal.flush();
    const original = f.first.sessions!.open;
    t.mock.method(f.first.sessions!, "open", async (...args: Parameters<typeof original>) => { reached.resolve(); await release.promise; return original(...args); });
    await f.send("/session-new investigation"); await reached.promise;
    f.app.ui.composer.editor.setText("Keep this newer draft."); release.resolve();
    await until(() => f.app.chat !== f.first && !f.app.ui.busy); await f.terminal.flush();
    const second = f.app.chat;
    assert.equal(f.app.ui.composer.editor.getExpandedText(), "Keep this newer draft.");
    assert.equal((await second.conversation.agent(context)).thinkingLevel, "high");
    assert.equal((await second.conversation.agent(context)).cwd, f.directory);
    assert.equal((await second.conversation.context(context)).messages.length, 0);
    await assert.rejects(access(`${f.first.file}.lock`), { code: "ENOENT" });
    assert.match(f.terminal.text(), /investigation/); assert(!f.terminal.text().includes("Old session answer"));
    const old = await openPersistentChat(f.first.file!, f.models, { onLockLost: lockLost });
    assert.match(JSON.stringify((await old.conversation.context(context)).messages), /Old session answer/); await old.close();
    await f.send("/resume"); await until(() => f.terminal.text().includes("Resume a session"), () => f.terminal.text());
    f.terminal.send("first"); f.terminal.send("\r");
    await until(() => f.app.chat.file === f.first.file && !f.app.ui.busy); await f.terminal.flush();
    assert.match(f.terminal.text(), /Old session answer/);
    assert.equal(f.faux.state.callCount, 1);
    assert.equal((await f.app.chat.conversation.agent(context)).thinkingLevel, "high");
    await assert.rejects(access(`${second.file}.lock`), { code: "ENOENT" });
  } finally { release.resolve(); await f.app.close(); f.terminal.dispose(); await rm(f.directory, { recursive: true, force: true }); }
});

test("cancellation or failed opening leaves the current session observed, restores command/draft, and closes any unused store", { timeout: 10000 }, async (t) => {
  const f = await fixture();
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let unused: ChatHandle | undefined;
  try {
    t.mock.method(f.first.sessions!, "open", async (file: string) => {
      unused = await f.make(file, true, f.first); reached.resolve(); await release.promise; return unused;
    });
    await f.send("/session-new cancelled"); await reached.promise;
    f.app.ui.composer.editor.setText("A draft after cancellation."); f.terminal.send("\x1b"); release.resolve();
    await until(() => !f.app.ui.busy);
    assert.equal(f.app.chat, f.first);
    assert.equal(f.app.ui.composer.editor.getExpandedText(), "/session-new cancelled\n\nA draft after cancellation.");
    assert.equal((await unused!.harness.closed).reason, "closed"); await assert.rejects(access(`${unused!.file}.lock`), { code: "ENOENT" });
    t.mock.method(f.first.sessions!, "open", async () => { throw new Error("Session is already open: fixture"); });
    await f.send("/session-new unavailable"); await until(() => !f.app.ui.busy); await f.terminal.flush();
    assert.equal(f.app.chat, f.first); assert.equal(f.app.ui.unavailable, false); assert.match(f.terminal.text(), /already open/);
    assert.equal(f.app.ui.composer.editor.getExpandedText(), "/session-new unavailable");
    await f.send("Old input."); await f.first.conversation.waitForIdle(context); await f.terminal.flush();
    assert.match(f.terminal.text(), /Old session answer/);
  } finally { release.resolve(); await f.app.close(); await unused?.close(); f.terminal.dispose(); await rm(f.directory, { recursive: true, force: true }); }
});

test("failed observation after handoff disables admission and shutdown still releases the installed store", { timeout: 10000 }, async (t) => {
  const f = await fixture();
  try {
    const original = f.first.sessions!.open;
    t.mock.method(f.first.sessions!, "open", async (...args: Parameters<typeof original>) => {
      const next = await original(...args);
      t.mock.method(next.conversation, "context", async () => { throw new Error("Observation initialization failed."); });
      return next;
    });
    await f.send("/session-new failed-watch"); await until(() => f.app.ui.unavailable); await f.terminal.flush();
    assert.match(f.terminal.text(), /Reopen the session/);
    assert.notEqual(f.app.chat, f.first); assert.equal(f.faux.state.callCount, 0);
    await assert.rejects(access(`${f.first.file}.lock`), { code: "ENOENT" });
    const installed = f.app.chat; await f.app.close();
    await assert.rejects(access(`${installed.file}.lock`), { code: "ENOENT" });
    assert.equal((await installed.harness.closed).reason, "closed");
  } finally { await f.app.close(); f.terminal.dispose(); await rm(f.directory, { recursive: true, force: true }); }
});

test("shutdown joins an in-flight session open and releases both ownership locks", { timeout: 10000 }, async (t) => {
  const f = await fixture(), reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let unused: ChatHandle | undefined;
  try {
    t.mock.method(f.first.sessions!, "open", async (file: string) => { unused = await f.make(file, true, f.first); reached.resolve(); await release.promise; return unused; });
    await f.send("/session-new waiting"); await reached.promise;
    let closed = false; const closing = f.app.close().then(() => { closed = true; });
    await delay(20); assert.equal(closed, false); assert.equal(f.terminal.stopped, false);
    release.resolve(); await closing;
    assert.equal((await unused!.harness.closed).reason, "closed"); assert.equal((await f.first.harness.closed).reason, "closed");
    for (const chat of [unused!, f.first]) await assert.rejects(access(`${chat.file}.lock`), { code: "ENOENT" });
  } finally { release.resolve(); await f.app.close(); await unused?.close(); f.terminal.dispose(); await rm(f.directory, { recursive: true, force: true }); }
});

for (const key of ["\x1b", "\x03", "SIGTERM"]) {
  test(`startup resume cancellation ${JSON.stringify(key)} restores the terminal without creating a conversation`, async () => {
    const terminal = new TestTerminal(100, 30);
    try {
      const picker = startupSessionPicker(terminal, [{ file: "/unused/session.sqlite", label: "Fixture session", description: "Never opened" }], [], false);
      await terminal.flush(); assert.match(terminal.text(), /Fixture session/);
      if (key === "SIGTERM") process.emit("SIGTERM"); else terminal.send(key);
      assert.equal(await picker, undefined); assert(terminal.stopped);
      assert(terminal.output.includes("\x1b[?1049l")); assert(terminal.output.includes("\x1b[?25h"));
    } finally { terminal.dispose(); }
  });
}
