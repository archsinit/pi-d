import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { mountChat, type ChatHandle } from "../src/chat.ts";
import { codingRegistry } from "../src/coding.ts";
import { chatCommands } from "../src/commands.ts";
import { commandCompletion } from "../src/completion.ts";
import { validateChatExtensions, watchExtensionFooter } from "../src/extension-ui.ts";
import { defineChatExtension, type ChatCommandContext, type ChatExtension, type ChatExtensionContext, type FooterStatus } from "../src/extensions.ts";
import { ChatUI } from "../src/ui.ts";
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

const presenter = defineChatExtension({ name: "presenter", piD: { commands: [{
  name: "present-local", description: "Present UI-only output", execute: (argument, api) => {
    api.notify("LOCAL-NOTICE");
    api.message(`LOCAL-MESSAGE ${argument}`, { type: "success" });
    api.toast(`LOCAL-TOAST ${argument}`, { timeoutMs: 0 });
  },
}] } });
const transcript = (ui: import("../src/ui.ts").ChatUI) => ui.transcript.render(106).map(stripTerminalSequences).join("\n");

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
  const storage = new MemoryStorage(), harness = await Harness.open(storage, { models, registry }, context);
  const conversation = await harness.root(context, { agent: { model } });
  const chat = controls({ harness, conversation, models, label: "fixture", close: () => harness.close(context) }, models);
  const terminal = new TestTerminal(110, 30), app = await mountChat(chat, terminal, false);
  const send = async (text: string) => { app.ui.composer.editor.setText(text); terminal.send("\r"); await terminal.flush(); };
  return { chat, terminal, app, send, models, faux, storage };
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
    for (const name of ["help", "interrupt", "model", "session-new", "extensions", "notifications", "skill:manual", "Bad", "with space", "/slash"]) {
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
    assert.match(f.terminal.text(), /\/badge \[on\|off\]/); assert.match(f.terminal.text(), /\/notifications/);
    f.terminal.send("\r"); await until(() => !f.app.ui.busy);
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

for (const [key, data] of [["Escape", "\x1b"], ["Ctrl+C", "\x03"]]) {
  test(`${key} cancellation reaches commands/native contexts, preserves prior output and suppresses all late presentation`, async (t) => {
    const entered = Promise.withResolvers<ChatCommandContext>(), release = Promise.withResolvers<void>();
    const extension = defineChatExtension({ name: "waiting", piD: { commands: [{ name: "wait-local", description: "Wait locally", execute: async (_args, api) => {
      api.message("BEFORE-CANCEL-MESSAGE"); api.toast("BEFORE-CANCEL-TOAST", { timeoutMs: 0 });
      entered.resolve(api); await release.promise;
      api.notify("LATE-NOTICE"); api.message("LATE-MESSAGE"); api.toast("LATE-TOAST");
      api.context.abortSignal!.throwIfAborted();
    } }] } });
    const f = await memory([extension]);
    try {
      const toasts = t.mock.method(f.app.ui, "addExtensionToast");
      await f.send("/wait-local"); const invocation = await entered.promise;
      assert.equal(invocation.signal, invocation.context.abortSignal);
      f.app.ui.composer.editor.setText("new draft"); f.terminal.send(data);
      assert(invocation.signal.aborted); release.resolve(); await until(() => !f.app.ui.busy); await f.terminal.flush();
      assert.equal(f.app.ui.composer.editor.getExpandedText(), "/wait-local\n\nnew draft");
      assert(!f.terminal.text().includes("LATE-")); assert.match(f.terminal.text(), /BEFORE-CANCEL-TOAST/);
      assert.equal(toasts.mock.callCount(), 1, "Late toasts must not enter the queue behind the visible card.");
      assert.match(transcript(f.app.ui), /BEFORE-CANCEL-MESSAGE/); assert.equal(f.faux.state.callCount, 0);
      assert.equal((await f.chat.conversation.context(context)).entries.length, 0);
    } finally { release.resolve(); await f.app.close(); f.terminal.dispose(); }
  });
}

test("a completed synchronous handler cannot retain presentation callbacks, even through a queued microtask", async (t) => {
  let retained: ChatCommandContext | undefined;
  const extension = defineChatExtension({ name: "retained", piD: { commands: [{ name: "retain-local", description: "Retain callbacks", execute: (_args, api) => {
    retained = api; api.notify("INITIAL-NOTICE"); api.message("INITIAL-MESSAGE"); api.toast("INITIAL-TOAST", { timeoutMs: 0 });
    queueMicrotask(() => { api.notify("MICROTASK-NOTICE"); api.message("MICROTASK-MESSAGE"); api.toast("MICROTASK-TOAST"); });
  } }] } });
  const f = await memory([extension]);
  try {
    const toasts = t.mock.method(f.app.ui, "addExtensionToast");
    await f.send("/retain-local"); await until(() => !f.app.ui.busy);
    retained!.notify("STALE-NOTICE"); retained!.message("STALE-MESSAGE"); retained!.toast("STALE-TOAST"); await f.terminal.flush();
    assert.match(f.terminal.text(), /INITIAL-NOTICE/); assert.match(f.terminal.text(), /INITIAL-TOAST/);
    assert.match(transcript(f.app.ui), /INITIAL-MESSAGE/);
    assert(!f.terminal.text().includes("STALE-")); assert(!f.terminal.text().includes("MICROTASK-"));
    assert.equal(toasts.mock.callCount(), 1);
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

test("sparse/malformed/throwing footer results stay inside their provider boundary while healthy output keeps refreshing", async () => {
  let value: unknown = Array(1), version = 1, throwing = true, lookupThrows = false;
  const registry = createRegistry(), { models, faux } = testModels();
  registry.install(defineChatExtension({ name: "malformed", piD: { get footer() {
    if (lookupThrows) throw new Error("PRIVATE-PROVIDER-LOOKUP");
    return () => value as readonly FooterStatus[];
  } } }));
  registry.install(defineChatExtension({ name: "throwing", piD: { footer() { if (throwing) throw new Error("PRIVATE-DETAIL"); return []; } } }));
  registry.install(defineChatExtension({ name: "healthy", piD: { footer: () => [{ text: `GOOD-${version}`, tone: "green" }] } }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context), conversation = await harness.root(context, { agent: { model } });
  const terminal = new TestTerminal(110, 30), ui = new ChatUI(terminal, { animate: false }), errors: Error[] = [];
  ui.start();
  const binding = watchExtensionFooter({ harness, conversation }, ui, (error) => { errors.push(error as Error); ui.setNotice((error as Error).message); });
  const refresh = async () => { await binding.refresh(); await terminal.flush(); assert.match(terminal.text().split("\n").at(-1) ?? "", new RegExp(`GOOD-${version}(?:\\s|$)`)); };
  try {
    await refresh(); assert.deepEqual(errors.map((error) => error.message), ["Extension malformed: footer failed.", "Extension throwing: footer failed."]);
    assert(!terminal.text().includes("PRIVATE-DETAIL")); assert.equal(ui.unavailable, false);
    const inherited = Array(1); Object.setPrototypeOf(inherited, { 0: { text: "INHERITED" } });
    for (const malformed of [Array(2), [{ text: "PARTIAL" }, ,], inherited, [undefined], [null], ["string"], { 0: { text: "ARRAY-LIKE" }, length: 1 },
      [{ text: 1 }], [{ text: "bad", tone: "invalid" }], [{ text: "bad", bold: "true" }], [{ text: "bad", strikethrough: 1 }],
      [{ get text() { throw new Error("PRIVATE-GETTER"); } }], [{ text: "bad", get tone() { throw new Error("PRIVATE-TONE"); } }],
      new Proxy([{ text: "bad" }], { getOwnPropertyDescriptor() { throw new Error("PRIVATE-PROXY"); } })]) {
      value = malformed; version++; await refresh();
      assert(!terminal.text().includes("PARTIAL")); assert(!terminal.text().includes("PRIVATE-"));
    }
    assert.equal(errors.length, 2, "Repeated failures retain existing diagnostic deduplication.");
    let reads = 0;
    value = [{ get text() { if (reads++) throw new Error("READ-TWICE"); return "SNAPSHOT\x1b[2J\nOK"; }, bold: true, strikethrough: false }];
    version++; await refresh(); assert.equal(reads, 1); assert.match(terminal.text(), /SNAPSHOT OK/);
    const customIterator = [{ text: "DENSE" }];
    Object.defineProperty(customIterator, Symbol.iterator, { value: function* () { yield undefined; } });
    value = customIterator; version++; await refresh(); assert.match(terminal.text(), /DENSE/);
    value = [{ text: "KNOWN-FIELDS", get extra() { throw new Error("SPREAD-OUTSIDE-BOUNDARY"); } }];
    version++; await refresh(); assert.match(terminal.text(), /KNOWN-FIELDS/);
    value = undefined; throwing = false; version++; await refresh();
    value = Array(1); throwing = true; version++; await refresh();
    assert.equal(errors.length, 4, "A recovered provider reports a later failure again.");
    value = []; throwing = false; version++; await refresh();
    lookupThrows = true; version++; await refresh();
    assert.equal(errors.length, 5); assert.equal(errors.at(-1)?.message, "Extension malformed: footer failed.");
    assert.equal(faux.state.callCount, 0);
  } finally { await binding.stop(); ui.stop(); await harness.close(context); terminal.dispose(); }
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

test("/notifications is completable, read-only and keyboard usable, with zero model/preflight/admission/storage/transcript effects", async (t) => {
  const f = await memory([]);
  try {
    const before = await f.chat.conversation.context(context), beforeTranscript = transcript(f.app.ui);
    const commits = t.mock.method(f.storage, "commit"), submit = t.mock.method(f.chat.conversation, "submit");
    let preflights = 0;
    f.chat.beforeModel = async () => { preflights++; throw new Error("Model access forbidden."); };
    assert((await suggest(f.chat, "/not"))?.items.some((item) => item.value === "notifications"));
    await f.send("/notifications unexpected"); await until(() => !f.app.ui.busy);
    assert.match(f.terminal.text(), /Use \/notifications without arguments/);
    await f.send("/notifications"); assert.match(f.terminal.text(), /No notifications pending/);
    f.terminal.send("\r"); await until(() => !f.app.ui.busy); assert(f.app.ui.composer.focused);
    f.app.ui.addExtensionToast("fixture", "ACTIVE-NOTIFICATION", { timeoutMs: 0 });
    f.app.ui.addExtensionToast("fixture", "QUEUED-NOTIFICATION\n" + "long detail\n".repeat(100) + "END-NOTIFICATION", { timeoutMs: 0 });
    await f.send("/notifications"); assert.match(f.terminal.text(), /2 pending/);
    f.app.ui.composer.editor.setText("newer draft");
    f.terminal.send("\x1b[B"); f.terminal.send("\x1b[F"); await f.terminal.flush();
    assert.match(f.terminal.text(), /END-NOTIFICATION/); assert.match(f.terminal.text(), /Queued · #2 · info/);
    f.terminal.send("\x1b[3~"); await f.terminal.flush(); assert.match(f.terminal.text(), /selection removed/);
    f.terminal.send("d"); await f.terminal.flush(); assert.match(f.terminal.text(), /ACTIVE-NOTIFICATION/);
    f.terminal.send("\x04"); await f.terminal.flush(); assert.match(f.terminal.text(), /No notifications pending/);
    f.terminal.send("\r"); await until(() => !f.app.ui.busy);
    assert(f.app.ui.composer.focused); assert.equal(f.app.ui.composer.editor.getText(), "newer draft");
    assert.equal(commits.mock.callCount(), 0); assert.equal(submit.mock.callCount(), 0);
    assert.equal(preflights, 0); assert.equal(f.faux.state.callCount, 0);
    assert.equal(transcript(f.app.ui), beforeTranscript); assert.deepEqual(await f.chat.conversation.context(context), before);
    await f.send("/notifications"); await f.app.close(); assert(!f.app.ui.tui.hasOverlay());
  } finally { await f.app.close(); f.terminal.dispose(); }
});

for (const [key, data] of [["Escape", "\x1b"], ["Ctrl+C", "\x03"]]) {
  test(`${key} closes /notifications without interrupting generation or dismissing a notification`, async () => {
    const f = await memory([], { tokensPerSecond: 30, responses: [fauxAssistantMessage("Slow fixture response. ".repeat(100))] });
    try {
      await f.send("ORIGINAL-INPUT"); await until(() => f.faux.state.callCount === 1);
      f.app.ui.addExtensionToast("fixture", "RETAINED-NOTIFICATION", { timeoutMs: 0 });
      const run = (await f.chat.harness.snapshot(LiveDoc, f.chat.conversation.id, context))?.run;
      assert(run);
      await f.send("/notifications"); assert(f.app.ui.tui.hasOverlay());
      f.terminal.send(data); await until(() => !f.app.ui.tui.hasOverlay()); await f.terminal.flush();
      assert.deepEqual((await f.chat.harness.snapshot(LiveDoc, f.chat.conversation.id, context))?.run, run);
      assert(f.app.ui.composer.focused); assert.equal(f.app.ui.composer.editor.getText(), "/notifications");
      assert.match(f.terminal.text(), /RETAINED-NOTIFICATION/); assert(!f.terminal.stopped); assert.equal(f.faux.state.callCount, 1);
      await f.chat.conversation.abort(context); await f.chat.conversation.waitForIdle(context);
      assert(!(await f.chat.conversation.context(context)).messages.some((message) => JSON.stringify(message).includes("NOTIFICATION")));
    } finally { await f.app.close(); f.terminal.dispose(); }
  });
}

test("successful presentation commands leave visible output with zero admissions, preflights, model calls, context changes or storage writes", async (t) => {
  const f = await memory([presenter]);
  try {
    const before = await f.chat.conversation.context(context);
    const commits = t.mock.method(f.storage, "commit"), submissions = t.mock.method(f.chat.conversation, "submit");
    let preflights = 0;
    f.chat.beforeModel = async () => { preflights++; throw new Error("No model access allowed."); };
    await f.send("/present-local offline"); await until(() => !f.app.ui.busy); await f.terminal.flush();
    assert.match(f.terminal.text(), /LOCAL-MESSAGE offline/); assert.match(f.terminal.text(), /LOCAL-TOAST offline/);
    assert.match(f.terminal.text().split("\n").at(-1) ?? "", /LOCAL-NOTICE/);
    assert.match(transcript(f.app.ui), /◇ Extension · success · presenter \/present-local/);
    assert(!transcript(f.app.ui).includes("Assistant"));
    assert.equal(commits.mock.callCount(), 0); assert.equal(submissions.mock.callCount(), 0);
    assert.equal(preflights, 0); assert.equal(f.faux.state.callCount, 0);
    assert.deepEqual(await f.chat.conversation.context(context), before);
    // Neither an unrelated native commit nor a transcript redraw replaces mounted UI output.
    await f.chat.conversation.configure({ thinkingLevel: "high" }, context); await f.terminal.flush();
    f.terminal.resize(80, 24); await f.terminal.flush();
    assert.match(transcript(f.app.ui), /LOCAL-MESSAGE offline/); assert.match(f.terminal.text(), /LOCAL-TOAST offline/);
  } finally { await f.app.close(); f.terminal.dispose(); }
});

test("messages stay anchored as later native transcript entries arrive and survive reset without entering model context", async () => {
  const f = await memory([presenter], { responses: [fauxAssistantMessage("FIRST-ANSWER"), fauxAssistantMessage("SECOND-ANSWER")] });
  try {
    await f.send("FIRST-INPUT"); await f.chat.conversation.waitForIdle(context); await f.terminal.flush();
    await f.send("/present-local BETWEEN"); await until(() => !f.app.ui.busy);
    await f.send("SECOND-INPUT"); await f.chat.conversation.waitForIdle(context); await f.terminal.flush();
    const text = transcript(f.app.ui);
    assert(text.indexOf("FIRST-ANSWER") < text.indexOf("LOCAL-MESSAGE BETWEEN"));
    assert(text.indexOf("LOCAL-MESSAGE BETWEEN") < text.indexOf("SECOND-INPUT"));
    assert.equal((text.match(/LOCAL-MESSAGE BETWEEN/g) ?? []).length, 1);
    assert.equal(f.faux.state.callCount, 2);
    const modelContext = JSON.stringify((await f.chat.conversation.context(context)).messages);
    assert(!modelContext.includes("LOCAL-")); assert(!modelContext.includes("Extension"));
    await f.send("/new"); await until(() => !f.app.ui.busy); await f.terminal.flush();
    assert.match(transcript(f.app.ui), /LOCAL-MESSAGE BETWEEN/); assert(!transcript(f.app.ui).includes("FIRST-ANSWER"));
    assert.match(f.terminal.text(), /LOCAL-TOAST BETWEEN/);
    assert(!(await f.chat.conversation.context(context)).messages.some((message) => JSON.stringify(message).includes("LOCAL-")));
  } finally { await f.app.close(); f.terminal.dispose(); }
});

test("presentation during streaming does not add a model call and survives live-to-committed view replacement", async (t) => {
  const done = Promise.withResolvers<void>();
  let retained: ChatCommandContext | undefined;
  const extension = defineChatExtension({ name: "async-presentation", piD: { commands: [{ name: "async-local", description: "Present after an await", execute: async (_argument, api) => {
    await Promise.resolve(); retained = api;
    api.message("STREAM-MESSAGE"); api.toast("STREAM-TOAST", { timeoutMs: 0 }); done.resolve();
  } }] } });
  const f = await memory([extension], { tokensPerSecond: 1000, responses: [fauxAssistantMessage("Streaming fixture text. ".repeat(20))] });
  try {
    const toasts = t.mock.method(f.app.ui, "addExtensionToast");
    await f.send("ORIGINAL-INPUT"); await until(() => f.faux.state.callCount === 1);
    await f.send("/async-local"); await done.promise;
    await f.terminal.flush();
    retained!.message("ASYNC-LATE-MESSAGE"); retained!.toast("ASYNC-LATE-TOAST"); retained!.notify("ASYNC-LATE-NOTICE");
    await f.chat.conversation.waitForIdle(context); await f.terminal.flush();
    assert.match(transcript(f.app.ui), /STREAM-MESSAGE/); assert.match(f.terminal.text(), /STREAM-TOAST/);
    assert(!transcript(f.app.ui).includes("ASYNC-LATE")); assert(!f.terminal.text().includes("ASYNC-LATE"));
    assert.equal(toasts.mock.callCount(), 1);
    assert.equal(f.faux.state.callCount, 1);
    assert(!(await f.chat.conversation.context(context)).messages.some((message) => JSON.stringify(message).includes("STREAM-")));
  } finally { await f.app.close(); f.terminal.dispose(); }
});

test("copying toast URLs with Ctrl+C neither closes chat nor steals composer focus", async () => {
  const url = "https://example.invalid/offline", f = await memory([presenter]);
  try {
    await f.send(`/present-local ${url}`); await until(() => !f.app.ui.busy); await f.terminal.flush();
    const row = f.terminal.text().split("\n").findIndex((line) => line.includes(`LOCAL-TOAST ${url}`));
    assert(row >= 0);
    const start = 2 + "LOCAL-TOAST ".length, end = start + url.length - 1;
    f.app.ui.tui.setCopyOnSelect(false);
    f.terminal.send(`\x1b[<0;${start + 1};${row + 1}M`);
    f.terminal.send(`\x1b[<32;${end + 1};${row + 1}M`);
    f.terminal.send(`\x1b[<0;${end + 1};${row + 1}m`);
    f.terminal.send("\x03"); await f.terminal.flush();
    assert(!f.terminal.stopped); assert(f.app.ui.composer.focused);
    assert(f.terminal.output.includes(`\x1b]52;c;${Buffer.from(url).toString("base64")}\x07`));
    assert.equal(f.faux.state.callCount, 0);
  } finally { await f.app.close(); f.terminal.dispose(); }
});

test("session handoff clears UI-only messages/toasts, and reopening never restores them from the temporary store", { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-presentation-session-")));
  const first = join(directory, "first.sqlite"), second = join(directory, "second.sqlite");
  const { models, faux } = testModels(), registry = createRegistry(); registry.install(presenter);
  registry.install(defineChatExtension({ name: "timed", piD: { commands: [{ name: "timed-local", description: "A timer owned by the first session", execute: (_argument, api) => api.toast("FIRST-TIMED", { timeoutMs: 500 }) }] } }));
  const make = async (file: string): Promise<ChatHandle> => {
    const chat = controls(await openPersistentChat(file, models, { defaults: { model }, registry, onLockLost: lockLost }), models);
    chat.sessions = { newFile: async () => second, list: async () => ({ choices: [], diagnostics: [] }), open: make };
    return chat;
  };
  const terminal = new TestTerminal(110, 30);
  let app = await mountChat(await make(first), terminal, false);
  const send = async (text: string) => { app.ui.composer.editor.setText(text); terminal.send("\r"); await terminal.flush(); await until(() => !app.ui.busy); };
  try {
    await send("/timed-local"); await send("/present-local FIRST-SESSION");
    assert.match(transcript(app.ui), /FIRST-SESSION/); assert.match(terminal.text(), /FIRST-TIMED/);
    assert.equal((await app.chat.conversation.context(context)).entries.length, 0);
    await send("/session-new"); await until(() => app.chat.file === second); await terminal.flush();
    assert(!transcript(app.ui).includes("FIRST-SESSION")); assert(!terminal.text().includes("LOCAL-TOAST"));
    app.ui.composer.editor.setText("/notifications"); terminal.send("\r"); await terminal.flush();
    assert.match(terminal.text(), /No notifications pending/); terminal.send("\r"); await until(() => !app.ui.busy);
    await send("/present-local SECOND-SESSION"); await delay(550); await terminal.flush();
    assert.match(terminal.text(), /LOCAL-TOAST SECOND-SESSION/, "The old session's timer must not dismiss its successor's card.");
    await app.close();
    app = await mountChat(await make(first), terminal, false); await terminal.flush();
    assert(!transcript(app.ui).includes("LOCAL-MESSAGE")); assert(!terminal.text().includes("LOCAL-TOAST"));
    app.ui.composer.editor.setText("/notifications"); terminal.send("\r"); await terminal.flush();
    assert.match(terminal.text(), /No notifications pending/); terminal.send("\r"); await until(() => !app.ui.busy);
    assert.equal((await app.chat.conversation.context(context)).entries.length, 0); assert.equal(faux.state.callCount, 0);
  } finally { await app.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("shutdown immediately clears presentation timers/state, aborts and joins the command, and ignores its late UI calls", async (t) => {
  const entered = Promise.withResolvers<ChatCommandContext>(), release = Promise.withResolvers<void>();
  const extension = defineChatExtension({ name: "shutdown-presentation", piD: { commands: [{ name: "shutdown-local", description: "Wait for shutdown", execute: async (_argument, api) => {
    api.message("BEFORE-SHUTDOWN"); api.toast("TIMED-SHUTDOWN", { timeoutMs: 100 });
    api.toast("QUEUED-SHUTDOWN", { timeoutMs: 0 }); entered.resolve(api); await release.promise;
    api.message("LATE-SHUTDOWN"); api.toast("LATE-SHUTDOWN"); api.notify("LATE-SHUTDOWN");
  } }] } });
  const f = await memory([extension]);
  try {
    const toasts = t.mock.method(f.app.ui, "addExtensionToast");
    await f.send("/shutdown-local"); const invocation = await entered.promise;
    const closing = f.app.close(); assert(invocation.signal.aborted);
    await f.terminal.flush();
    const renders = t.mock.method(f.app.ui.tui, "requestRender");
    await delay(120);
    assert.equal(renders.mock.callCount(), 0, "No presentation timer may fire while shutdown joins the command.");
    assert(!transcript(f.app.ui).includes("SHUTDOWN")); assert(!f.terminal.stopped);
    release.resolve(); await closing;
    assert(f.terminal.stopped); assert(!transcript(f.app.ui).includes("LATE-SHUTDOWN"));
    assert.equal(toasts.mock.callCount(), 2);
    assert.equal((await f.chat.harness.closed).reason, "closed"); assert.equal(f.faux.state.callCount, 0);
  } finally { release.resolve(); await f.app.close(); f.terminal.dispose(); }
});
