import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type StorageWrite } from "@earendil-works/pi-durable";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { mountChat } from "../src/chat.ts";
import { openDemo } from "../src/demo.ts";
import { model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;

test("composer admits one input, protects the next draft while busy, Escape cancels and Ctrl+N never resets", async () => {
  const terminal = new TestTerminal(100, 30);
  const demo = await openDemo(50);
  const app = await mountChat(demo, terminal, false);
  try {
    terminal.send("first input"); terminal.send("\r");
    terminal.send("next draft"); terminal.send("\r");
    await terminal.flush();
    assert.equal(app.ui.composer.editor.getText(), "next draft");
    const entries = (await demo.conversation.context(context)).entries;
    assert.equal(entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "user").length, 1);
    assert(app.ui.busy);
    terminal.send("\x0e"); await terminal.flush();
    assert(!terminal.text().includes("Stop the response"));
    assert.deepEqual((await demo.conversation.context(context)).entries, entries);
    assert.equal(app.ui.composer.editor.getText(), "next draft");
    terminal.send("\x1b");
    for (let i = 0; i < 30 && app.ui.busy; i++) await terminal.flush();
    assert.equal(app.ui.busy, false);
    const settled = (await demo.conversation.context(context)).entries;
    terminal.send("\x0e"); await terminal.flush();
    assert.deepEqual((await demo.conversation.context(context)).entries, settled);
    assert.equal(app.ui.composer.editor.getText(), "next draft");
    terminal.send("\x03"); await app.closed;
  } finally { await app.close(); terminal.dispose(); }
});

test("storage failure restores the unadmitted input without overwriting a newer draft or rendering phantom history", async () => {
  class FailingStorage extends MemoryStorage {
    fail = false;
    override async commit(writes: readonly StorageWrite[], context: Context) {
      if (this.fail) { await delay(60); throw new Error("simulated disk full"); }
      return super.commit(writes, context);
    }
  }
  const storage = new FailingStorage();
  const { models } = testModels();
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, { agent: { model } });
  const terminal = new TestTerminal(100, 30);
  const app = await mountChat({ harness, conversation, label: "test", close: () => harness.close(context) }, terminal, false);
  try {
    storage.fail = true;
    const nextDraft = "new draft\n" + "large pasted content\n".repeat(50);
    terminal.send("original input"); terminal.send("\r");
    terminal.send(`\x1b[200~${nextDraft}\x1b[201~`);
    await delay(150); await terminal.flush();
    assert.equal(app.ui.composer.editor.getExpandedText(), `original input\n\n${nextDraft}`);
    assert.equal(app.ui.unavailable, true);
    assert.equal(app.ui.composer.editor.disableSubmit, true);
    assert.match(terminal.text(), /disk full/);
    assert(!app.ui.transcript.render(90).map(stripTerminalSequences).join("\n").includes("original input"));
  } finally { await app.close(); terminal.dispose(); }
});

test("an admitted provider failure is visible and does not restore or duplicate the accepted input", async () => {
  const { models } = testModels({ responses: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "Missing API key\nSet it in the environment.\x1b[2J" })] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, { agent: { model } });
  const terminal = new TestTerminal(100, 30);
  const app = await mountChat({ harness, conversation, label: "test", close: () => harness.close(context) }, terminal, false);
  try {
    terminal.send("accepted input"); terminal.send("\r");
    await delay(120); await terminal.flush();
    assert.equal(app.ui.composer.editor.getText(), "");
    assert.equal(app.ui.busy, false);
    assert.match(terminal.text(), /Missing API key/);
    assert(app.ui.transcript.render(80).every((line) => !line.includes("\n") && !line.includes("\r")));
    assert.equal((await conversation.context(context)).entries.flatMap((entry) => entry.model ?? []).filter((m) => m.role === "user").length, 1);
  } finally { await app.close(); terminal.dispose(); }
});

test("terminal drain failure cannot skip native shutdown", async () => {
  class BrokenDrain extends TestTerminal {
    override async drainInput(): Promise<void> { throw new Error("drain failed"); }
  }
  const terminal = new BrokenDrain();
  const demo = await openDemo();
  const app = await mountChat(demo, terminal, false);
  const closed = assert.rejects(app.closed, /drain failed/);
  await assert.rejects(app.close(), /drain failed/);
  await closed;
  assert(terminal.stopped);
  assert.equal((await demo.harness.closed).reason, "closed");
  terminal.dispose();
});

test("partial terminal startup failure restores state and closes native resources", async () => {
  class BrokenStart extends TestTerminal {
    override start(): void { throw new Error("start failed"); }
  }
  const terminal = new BrokenStart();
  const demo = await openDemo();
  await assert.rejects(mountChat(demo, terminal, false), /start failed/);
  assert(terminal.stopped);
  assert.equal((await demo.harness.closed).reason, "closed");
  terminal.dispose();
});

test("CLI rejects noninteractive runs and demo/storage combinations without opening user data", () => {
  for (const [args, message] of [
    [[], "interactive terminal"], [["--demo", "--session", "never-created.sqlite"], "cannot be combined"],
    [["--demo", "--thinking", "max"], "cannot be combined"], [["--login"], "interactive terminal"],
    [["--login", "--model", "openai-codex/gpt-6.1-sol"], "on its own"], [["--login", "--logout"], "on its own"],
    [["--logout", "--session", "never-created.sqlite"], "on its own"], [["--thinking", "maximum"], "Thinking must be"],
  ] as const) {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.ts", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert(result.stderr.includes(message), result.stderr);
  }
  const help = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli.ts", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  for (const text of ["--session", "--login", "--thinking", "/new", "/clear", "/help", "openai-codex/gpt-6.1-sol", "max reasoning", "never OPENAI_API_KEY"]) assert(help.stdout.includes(text));
  assert(!help.stdout.includes("Ctrl+N"));
});
