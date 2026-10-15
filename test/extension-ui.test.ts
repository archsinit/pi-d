import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { mountChat, type ChatHandle } from "../src/chat.ts";
import { codingRegistry } from "../src/coding.ts";
import { chatCommands } from "../src/commands.ts";
import { commandCompletion } from "../src/completion.ts";
import { validateChatExtensions, watchExtensionFooter } from "../src/extension-ui.ts";
import { defineChatExtension, type ChatExtension, type ChatExtensionContext } from "../src/extensions.ts";
import { Resources } from "../src/resources.ts";
import { openPersistentChat } from "../src/session.ts";
import { lockLost, model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;
const Badge = defineDoc<{ active: boolean }>({ kind: "fixture.badge", version: 1, scope: "session", initial: () => ({ active: true }) });
const badge = defineChatExtension({ name: "badge", piD: {
  commands: [{ name: "badge", description: "Set the fixture badge", argumentHint: "[on|off]",
    complete: (prefix) => ["on", "off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    execute: async (argument, api) => {
      if (argument !== "on" && argument !== "off") throw new Error("Use /badge on|off.");
      await api.harness.commit(async (tx) => { (await tx.doc(Badge)).active = argument === "on"; }, api.context);
      api.notify(`Badge ${argument}.`);
    },
  }],
  footer: async (api) => {
    const active = (await api.harness.snapshot(Badge, api.context))?.active !== false;
    return [{ text: active ? "ACTIVE" : "QUIET", tone: active ? "green" : "dim", strikethrough: !active }];
  },
} });

async function until(predicate: () => boolean, detail: () => string = () => "") {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for extension UI.\n" + detail());
}

function controls(chat: ChatHandle, models: ReturnType<typeof testModels>["models"]) {
  chat.command = chatCommands(chat, models); chat.completion = commandCompletion(chat, models);
  return chat;
}

async function memory(extensions: ChatExtension[] = [badge], options: Parameters<typeof testModels>[0] = {}) {
  const { models, faux } = testModels(options), registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const conversation = await harness.root(context, { agent: { model } });
  const chat = controls({ harness, conversation, models, label: "fixture", close: () => harness.close(context) }, models);
  const terminal = new TestTerminal(110, 30), app = await mountChat(chat, terminal, false);
  const send = async (text: string) => { app.ui.composer.editor.setText(text); terminal.send("\r"); await terminal.flush(); };
  return { chat, terminal, app, send, models, faux };
}

const suggest = (chat: ChatHandle, text: string, signal = new AbortController().signal) => chat.completion!.getSuggestions([text], 0, text.length, { signal, force: true });

test("external TypeScript can import the host UI helper; old Durable exports remain unchanged and collisions fail at load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-ui-loader-")), path = join(directory, "outside extension.ts");
  const resources = new Resources(join(directory, "config"), [], directory);
  try {
    await writeFile(path, `import { defineChatExtension } from "pi-d-chat/extensions";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
export default defineChatExtension({ name: "external-ui", tools: [defineTool({ name: "probe", description: "Probe", parameters: Type.Object({}), execute: async () => ({ output: [] }) })], piD: { commands: [{ name: "external-ui", description: "External UI", execute: async (_args, ctx) => ctx.notify("loaded") }], footer: () => [{ text: "EXT", tone: "cyan" }] } });`);
    const registry = await codingRegistry(resources, [path]);
    const loaded = registry.snapshot().extension("external-ui") as ChatExtension;
    assert.equal(loaded.tools?.[0].name, "probe"); assert.equal(loaded.piD?.commands?.[0].name, "external-ui");
    const javascript = join(directory, "javascript.mjs");
    await writeFile(javascript, 'import { defineChatExtension } from "pi-d-chat/extensions"; export default defineChatExtension({ name: "external-esm", piD: { footer: () => [{ text: "ESM" }] } });');
    assert((await codingRegistry(resources, [javascript])).snapshot().extension("external-esm"));
    const other = join(directory, "other.mjs");
    await writeFile(other, 'export default { name: "other", piD: { commands: [{ name: "external-ui", description: "Duplicate", execute() {} }] } };');
    await assert.rejects(codingRegistry(resources, [path, other]), /Duplicate or reserved command \/external-ui/);
    let index = 0;
    for (const name of ["help", "interrupt", "model", "session-new", "extensions", "skill:manual", "Bad", "with space", "/slash"]) {
      const invalid = join(directory, `invalid-${index++}.mjs`);
      await writeFile(invalid, `export default { name: "other", piD: { commands: [{ name: ${JSON.stringify(name)}, description: "Reserved", execute() {} }] } };`);
      await assert.rejects(codingRegistry(resources, [invalid]), /reserved command|invalid piD/);
    }
    for (const piD of [null, [], { commands: {} }, { footer: "not a function" }, { commands: [{ name: "ok", description: "Missing handler" }] }]) {
      const invalid = join(directory, `invalid-${index++}.mjs`);
      await writeFile(invalid, `export default { name: "other", piD: ${JSON.stringify(piD)} };`);
      await assert.rejects(codingRegistry(resources, [invalid]), /invalid piD/);
    }
    assert.throws(() => validateChatExtensions([{ name: "repeat", piD: { commands: [badge.piD!.commands![0], badge.piD!.commands![0]] } } as ChatExtension]), /reserved command/);
    const old = join(directory, "old.mjs");
    await writeFile(old, 'export default { name: "old-durable" };');
    assert((await codingRegistry(resources, [old])).snapshot().extension("old-durable"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("extension commands, help and completions are local and selected-only; native document commits refresh the footer", async () => {
  const f = await memory();
  let preflights = 0;
  f.chat.beforeModel = async () => { preflights++; throw new Error("No model admission permitted."); };
  try {
    await until(() => f.terminal.text().includes("ACTIVE"), () => f.terminal.text());
    assert.equal(await f.chat.harness.snapshot(Badge, context), undefined, "Rendering must not create state.");
    assert((await suggest(f.chat, "/bad"))?.items.some((item) => item.value === "badge"));
    assert.deepEqual((await suggest(f.chat, "/badge of"))?.items.map((item) => item.value), ["off"]);
    await f.send("/badge off"); await until(() => !f.app.ui.busy); await f.terminal.flush();
    assert.equal((await f.chat.harness.snapshot(Badge, context))?.active, false);
    assert.match(f.terminal.text().split("\n").at(-1) ?? "", /Badge off.*QUIET/);
    await f.send("/help"); await until(() => f.terminal.text().includes("Set the fixture badge"));
    assert.match(f.terminal.text(), /\/badge \[on\|off\]/); f.terminal.send("\r"); await until(() => !f.app.ui.busy);
    await f.send("/extensions"); await until(() => f.terminal.text().includes("badge: /badge, footer"));
    f.terminal.send("\r"); await until(() => !f.app.ui.busy);
    await f.send("/badge invalid"); await until(() => !f.app.ui.busy);
    assert.equal(f.app.ui.composer.editor.getText(), "/badge invalid"); assert.match(f.terminal.text(), /Use \/badge on\|off/);
    f.app.ui.composer.editor.setText(""); f.app.ui.setNotice("");
    await f.chat.harness.commit(async (tx) => { (await tx.doc(Badge)).active = true; }, context);
    await until(() => f.terminal.text().includes("ACTIVE"));
    await f.chat.conversation.configure({ extensions: [] }, context); await f.terminal.flush();
    assert(!(await suggest(f.chat, "/bad"))?.items.some((item) => item.value === "badge"));
    assert(!f.terminal.text().includes("ACTIVE"));
    await f.send("/badge off"); await until(() => !f.app.ui.busy); assert.match(f.terminal.text(), /Unknown command \/badge/);
    await f.chat.conversation.configure({ extensions: [badge] }, context); await until(() => f.terminal.text().includes("ACTIVE"));
    assert.equal((await f.chat.conversation.context(context)).entries.length, 0); assert.equal(f.faux.state.callCount, 0);
    assert.equal(preflights, 0, "Local UI commands never run the model/authentication preflight.");
  } finally { await f.app.close(); f.terminal.dispose(); }
});

test("a local command is usable during generation and cannot implicitly submit its return value; // remains literal input", async () => {
  const untyped = { name: "untyped", piD: { commands: [{ name: "local-only", description: "Local only", execute: () => "NEVER-ADMIT-THIS" }] } } as unknown as ChatExtension;
  const f = await memory([badge, untyped], { tokensPerSecond: 30, responses: [fauxAssistantMessage("Slow reply. ".repeat(100)), fauxAssistantMessage("Literal reply.")] });
  try {
    await f.send("Original input."); await until(() => f.faux.state.callCount === 1);
    await f.send("/badge off"); await until(() => f.terminal.text().includes("QUIET"));
    assert((await f.chat.harness.snapshot(LiveDoc, f.chat.conversation.id, context))?.run);
    await f.send("/local-only"); await f.terminal.flush();
    assert.equal(f.faux.state.callCount, 1);
    await f.chat.conversation.abort(context); await f.chat.conversation.waitForIdle(context); await f.terminal.flush();
    await f.send("//badge off"); await until(() => f.faux.state.callCount === 2); await f.chat.conversation.waitForIdle(context);
    const users = (await f.chat.conversation.context(context)).messages.filter((message) => message.role === "user");
    assert.deepEqual(users.map((message) => message.content), ["Original input.", "/badge off"]);
  } finally { await f.app.close(); f.terminal.dispose(); }
});

test("request cancellation reaches commands and native contexts, restores the draft and suppresses late notices", async () => {
  const entered = Promise.withResolvers<ChatExtensionContext>(), release = Promise.withResolvers<void>();
  const extension = defineChatExtension({ name: "waiting", piD: { commands: [{ name: "wait-local", description: "Wait locally", execute: async (_args, api) => {
    entered.resolve(api); await release.promise;
    api.notify("LATE-NOTICE-MUST-NOT-SHOW"); api.context.abortSignal!.throwIfAborted();
  } }] } });
  const f = await memory([extension]);
  try {
    await f.send("/wait-local"); const invocation = await entered.promise;
    assert.equal(invocation.signal, invocation.context.abortSignal);
    f.app.ui.composer.editor.setText("new draft"); f.terminal.send("\x1b");
    assert(invocation.signal.aborted); release.resolve(); await until(() => !f.app.ui.busy); await f.terminal.flush();
    assert.equal(f.app.ui.composer.editor.getExpandedText(), "/wait-local\n\nnew draft");
    assert(!f.terminal.text().includes("LATE-NOTICE")); assert.equal(f.faux.state.callCount, 0);
    assert.equal((await f.chat.conversation.context(context)).entries.length, 0);
  } finally { release.resolve(); await f.app.close(); f.terminal.dispose(); }
});

test("a completed command cannot use a retained notify callback to change a later screen", async () => {
  let notify: (message: string) => void = () => assert.fail("Command did not run.");
  const extension = defineChatExtension({ name: "retained", piD: { commands: [{ name: "retain-local", description: "Retain a callback", execute: (_args, api) => { notify = api.notify; api.notify("INITIAL-NOTICE"); } }] } });
  const f = await memory([extension]);
  try {
    await f.send("/retain-local"); await until(() => !f.app.ui.busy);
    notify("STALE-NOTICE"); await f.terminal.flush();
    assert.match(f.terminal.text(), /INITIAL-NOTICE/); assert(!f.terminal.text().includes("STALE-NOTICE"));
  } finally { await f.app.close(); f.terminal.dispose(); }
});

test("extension argument completion sanitizes output, contains failures and drops cancelled reads", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let mode = "normal";
  const extension = defineChatExtension({ name: "completion", piD: { commands: [{ name: "complete-local", description: "Safe\x1b[2J\ncompletion", argumentHint: "[value]", execute() {}, complete: async (_prefix, api) => {
    if (mode === "error") throw new Error("PRIVATE-COMPLETION-ERROR");
    if (mode === "wait") { entered.resolve(); await release.promise; assert(api.signal.aborted); }
    return [{ value: "hello\x1b]52;c;secret\x07", label: "hello\x1b[2J\nthere", description: "safe\ntext" }];
  } }] } });
  const f = await memory([extension]);
  try {
    assert.match((await suggest(f.chat, "/complete-l"))!.items[0].description ?? "", /Safe completion/);
    const items = (await suggest(f.chat, "/complete-local "))!.items;
    assert.deepEqual(items, [{ value: "hello", label: "hello there", description: "safe text" }]);
    mode = "error"; assert.equal(await suggest(f.chat, "/complete-local "), null);
    assert((await suggest(f.chat, "/rea"))?.items.some((item) => item.value === "reasoning"));
    mode = "wait"; const controller = new AbortController();
    const pending = suggest(f.chat, "/complete-local ", controller.signal); await entered.promise;
    controller.abort(); release.resolve(); assert.equal(await pending, null);
    assert.equal(f.faux.state.callCount, 0);
  } finally { release.resolve(); await f.app.close(); f.terminal.dispose(); }
});

test("session-scoped UI state survives reset/reopen and remains independent across session handoffs", { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-ui-session-"))), first = join(directory, "first.sqlite"), second = join(directory, "second.sqlite");
  const { models, faux } = testModels(), registry = createRegistry(); registry.install(badge);
  const make = async (file: string): Promise<ChatHandle> => {
    const chat = controls(await openPersistentChat(file, models, { defaults: { model }, registry, onLockLost: lockLost }), models);
    chat.sessions = { newFile: async () => second, list: async () => ({ choices: [], diagnostics: [] }), open: make };
    return chat;
  };
  const terminal = new TestTerminal(110, 30);
  let app = await mountChat(await make(first), terminal, false);
  const send = async (text: string) => { app.ui.composer.editor.setText(text); terminal.send("\r"); await terminal.flush(); await until(() => !app.ui.busy); };
  try {
    await send("/badge off"); await until(() => terminal.text().includes("QUIET"));
    await send("/new"); assert.equal((await app.chat.harness.snapshot(Badge, context))?.active, false);
    await send("/session-new"); await until(() => app.chat.file === second && terminal.text().includes("ACTIVE"));
    assert.equal(await app.chat.harness.snapshot(Badge, context), undefined);
    await app.close();
    app = await mountChat(await make(first), terminal, false); await until(() => terminal.text().includes("QUIET"));
    assert.equal((await app.chat.harness.snapshot(Badge, context))?.active, false);
    assert.equal(faux.state.callCount, 0);
  } finally { await app.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("footer callbacks are serialized, coalesce commits, isolate bad providers and refresh even for custom session docs", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let blocked = false, running = 0, maxRunning = 0, calls = 0;
  const extension = defineChatExtension({ name: "serial", piD: { footer: async (api) => {
    running++; calls++; maxRunning = Math.max(maxRunning, running);
    try {
      if (blocked) { entered.resolve(); await release.promise; }
      return [{ text: (await api.harness.snapshot(Badge, api.context))?.active === false ? "LATEST" : "INITIAL" }];
    } finally { running--; }
  } } });
  const f = await memory([
    defineChatExtension({ name: "broken", piD: { footer() { throw new Error("PRIVATE-FOOTER-ERROR"); } } }),
    { name: "invalid", piD: { footer: () => [{ text: "bad", tone: "invalid" }] } } as unknown as ChatExtension,
    extension,
  ]);
  try {
    await until(() => f.terminal.text().includes("INITIAL"));
    assert.match(f.terminal.text(), /footer failed/); assert(!f.terminal.text().includes("PRIVATE-FOOTER"));
    assert.equal(f.app.ui.unavailable, false);
    blocked = true;
    await f.chat.harness.commit(async (tx) => { await tx.doc(Badge); }, context); await entered.promise;
    const before = calls;
    for (let i = 0; i < 8; i++) await f.chat.harness.commit(async (tx) => { (await tx.doc(Badge)).active = i % 2 === 0; }, context);
    release.resolve(); await until(() => f.terminal.text().includes("LATEST"));
    assert.equal(maxRunning, 1); assert(calls <= before + 1, `Expected one coalesced refresh, got ${calls - before}.`);
    assert.equal(f.faux.state.callCount, 0);
  } finally { release.resolve(); await f.app.close(); f.terminal.dispose(); }
});

test("shutdown aborts and joins a slow footer without rendering stale results or retaining commit subscriptions", async (t) => {
  const entered = Promise.withResolvers<ChatExtensionContext>(), release = Promise.withResolvers<void>();
  let slow = false;
  const extension = defineChatExtension({ name: "slow-footer", piD: { footer: async (api) => {
    if (slow) { entered.resolve(api); await release.promise; }
    return [{ text: slow ? "STALE" : "INITIAL" }];
  } } });
  const f = await memory([extension]);
  try {
    await until(() => f.terminal.text().includes("INITIAL"));
    const updates = t.mock.method(f.app.ui, "setExtensionStatus");
    slow = true;
    await f.chat.harness.commit(async (tx) => { await tx.doc(Badge); }, context); const invocation = await entered.promise;
    const closing = f.app.close(); await delay(20);
    assert(invocation.signal.aborted); assert(!f.terminal.stopped);
    release.resolve(); await closing;
    assert(f.terminal.stopped);
    assert(updates.mock.calls.every((call) => !JSON.stringify(call.arguments).includes("STALE")));
    assert.equal((await f.chat.harness.closed).reason, "closed");
  } finally { release.resolve(); await f.app.close(); f.terminal.dispose(); }
});

test("a slow initial footer does not block startup or local commands", async () => {
  const entered = Promise.withResolvers<ChatExtensionContext>(), release = Promise.withResolvers<void>();
  const extension = defineChatExtension({ name: "slow-initial", piD: {
    commands: [{ name: "ping-local", description: "Local ping", execute: (_args, api) => api.notify("LOCAL-PONG") }],
    footer: async (api) => { entered.resolve(api); await release.promise; return [{ text: "TOO-LATE" }]; },
  } });
  const f = await memory([extension]);
  try {
    const invocation = await entered.promise;
    await f.send("/ping-local"); await until(() => !f.app.ui.busy); await f.terminal.flush();
    assert.match(f.terminal.text(), /LOCAL-PONG/);
    const closing = f.app.close(); assert(invocation.signal.aborted);
    release.resolve(); await closing; assert(!f.terminal.text().includes("TOO-LATE"));
  } finally { release.resolve(); await f.app.close(); f.terminal.dispose(); }
});

test("shutdown during handoff also detaches the newly mounted session's footer", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-ui-handoff-"));
  const oldEntered = Promise.withResolvers<ChatExtensionContext>(), oldRelease = Promise.withResolvers<void>();
  let subscriptions = 0, subscribed = 0;
  const { models } = testModels(), registry = createRegistry();
  let first: ChatHandle, next: ChatHandle | undefined, slow = false;
  registry.install(defineChatExtension({ name: "handoff-footer", piD: { footer: async (api) => {
    if (slow && api.harness === first.harness) { oldEntered.resolve(api); await oldRelease.promise; }
    return [{ text: "SESSION" }];
  } } }));
  const make = async (file: string) => controls(await openPersistentChat(file, models, { defaults: { model }, registry, onLockLost: lockLost }), models);
  first = await make(join(directory, "first.sqlite"));
  first.sessions = { newFile: async () => join(directory, "next.sqlite"), list: async () => ({ choices: [], diagnostics: [] }), open: async (file) => {
    next = await make(file);
    const subscribe = next.harness.subscribeCommits.bind(next.harness);
    t.mock.method(next.harness, "subscribeCommits", (...args: Parameters<typeof subscribe>) => {
      const unsubscribe = subscribe(...args); subscriptions++; subscribed++;
      return () => { subscriptions--; unsubscribe(); };
    });
    return next;
  } };
  const terminal = new TestTerminal(110, 30), app = await mountChat(first, terminal, false);
  try {
    await until(() => terminal.text().includes("SESSION")); slow = true;
    await first.harness.commit(async (tx) => { await tx.doc(Badge); }, context); const oldInvocation = await oldEntered.promise;
    app.ui.composer.editor.setText("/session-new"); terminal.send("\r");
    await until(() => oldInvocation.signal.aborted);
    const closing = app.close(); oldRelease.resolve(); await closing;
    assert.equal(subscribed, 1); assert.equal(subscriptions, 0);
    assert.equal((await first.harness.closed).reason, "closed"); assert.equal((await next!.harness.closed).reason, "closed");
    assert(terminal.stopped);
  } finally {
    oldRelease.resolve(); await app.close(); terminal.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a detached footer stops observing commits while its Harness can remain open", async () => {
  const f = await memory([]);
  let calls = 0;
  // A separate owner/UI binding is enough to exercise resource release before the Harness closes.
  const registry = createRegistry(); registry.install(defineChatExtension({ name: "count", piD: { footer: () => { calls++; return []; } } }));
  const harness = await Harness.open(new MemoryStorage(), { models: f.models, registry }, context), conversation = await harness.root(context);
  const binding = watchExtensionFooter({ harness, conversation }, f.app.ui, () => {});
  try {
    await binding.refresh(); const before = calls; await binding.stop();
    await harness.commit(async (tx) => { await tx.doc(Badge); }, context); await delay(20);
    assert.equal(calls, before);
  } finally { await binding.stop(); await harness.close(context); await f.app.close(); f.terminal.dispose(); }
});
