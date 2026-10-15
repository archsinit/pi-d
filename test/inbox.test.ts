import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, InboxDoc, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { mountChat, type ChatHandle } from "../src/chat.ts";
import { chatCommands } from "../src/commands.ts";
import { openPersistentChat } from "../src/session.ts";
import { lockLost, model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 250; i++) { if (await predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for native inbox/run.");
}
async function setup(file?: string, failRun = false) {
  const gate = Promise.withResolvers<void>();
  let toolCalls = 0;
  const registry = createRegistry();
  registry.install(defineExtension({ name: "inbox-fixture", tools: [defineTool({
    name: "wait_fixture", description: "Offline cancellable gate", parameters: Type.Object({}),
    async execute(_args, api, callContext) {
      toolCalls++; api.output("INBOX-TOOL-RUNNING");
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("Gate cancelled."));
        callContext.abortSignal?.addEventListener("abort", abort, { once: true });
        gate.promise.then(() => { callContext.abortSignal?.removeEventListener("abort", abort); resolve(); });
        if (callContext.abortSignal?.aborted) abort();
      });
      return { output: [fauxText("GATE-RELEASED")] };
    },
  })] }));
  const requests: string[] = [];
  const { models, faux } = testModels({ responses: [
    fauxAssistantMessage(fauxToolCall("wait_fixture", {}), { stopReason: "toolUse" }),
    (transcript) => { requests.push(JSON.stringify(transcript.messages)); return failRun ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "Offline provider failure." }) : fauxAssistantMessage("First run done."); },
    (transcript) => { requests.push(JSON.stringify(transcript.messages)); return fauxAssistantMessage("Follow-up done."); },
  ] });
  let chat: ChatHandle;
  if (file) chat = await openPersistentChat(file, models, { model, registry, onLockLost: lockLost });
  else {
    const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { enabled: false } } }, context);
    const conversation = await harness.root(context, { agent: { model } });
    chat = { harness, conversation, models, label: "inbox", close: () => harness.close(context) };
  }
  chat.command = chatCommands(chat, models);
  const terminal = new TestTerminal(100, 30), app = await mountChat(chat, terminal, false);
  const send = async (text: string) => { app.ui.composer.editor.setText(text); terminal.send("\r"); await terminal.flush(); };
  const items = async () => (await chat.harness.snapshot(InboxDoc, chat.conversation.id, context))?.items ?? [];
  const running = async () => !!(await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))?.tools?.some((tool) => tool.output?.includes("INBOX-TOOL-RUNNING"));
  return { chat, models, faux, registry, requests, gate, terminal, app, send, items, running, toolCalls: () => toolCalls };
}

test("/steer joins after tools, /followup starts the next run, and /queue reflects only Durable's persisted inbox", { timeout: 10000 }, async () => {
  const f = await setup();
  try {
    await f.send("Initial input."); await until(f.running);
    await f.send("/steer Use pnpm, not npm.");
    await f.send("/followup Also run the tests.");
    const items = await f.items(); assert.deepEqual(items.map((item) => item.mode), ["steer", "followUp"]);
    await f.terminal.flush(); assert.match(f.terminal.text().split("\n").at(-1) ?? "", /·q2/);
    await f.send("/queue"); assert.match(f.terminal.text(), /Use pnpm/); assert.match(f.terminal.text(), /Also run the tests/);
    f.terminal.send("\r"); await f.terminal.flush();
    f.app.ui.composer.editor.setText("A newer draft."); f.terminal.send("\r");
    assert.equal(f.app.ui.composer.editor.getExpandedText(), "A newer draft.");
    assert.equal(f.faux.state.callCount, 1);
    f.gate.resolve(); await f.chat.conversation.waitForIdle(context); await f.terminal.flush();
    assert.equal(f.faux.state.callCount, 3); assert.equal(f.toolCalls(), 1);
    assert.match(f.requests[0], /Use pnpm/); assert(!f.requests[0].includes("Also run the tests"));
    assert.match(f.requests[1], /Also run the tests/);
    assert.equal(f.app.ui.composer.editor.getExpandedText(), "A newer draft.");
    assert.deepEqual(await f.items(), []);
    const users = (await f.chat.conversation.context(context)).messages.filter((message) => message.role === "user");
    assert.deepEqual(users.map((message) => message.content), ["Initial input.", "Use pnpm, not npm.", "Also run the tests."]);
    assert(!JSON.stringify(users).includes("/queue"));
  } finally { f.gate.resolve(); await f.app.close(); f.terminal.dispose(); }
});

test("/withdraw removes only a selected queued input; invalid IDs and arguments cannot interrupt a run", { timeout: 10000 }, async () => {
  const f = await setup();
  try {
    await f.send("Initial input."); await until(f.running);
    await f.send("/followup This must be withdrawn.");
    const item = (await f.items())[0]; assert(item);
    await f.send("/withdraw 999999"); assert.match(f.terminal.text(), /Choose an ID/); assert.equal((await f.items()).length, 1);
    await f.send("/interrupt extra"); assert.match(f.terminal.text(), /without arguments/); assert(await f.running());
    await f.send(`/withdraw ${item.id}`);
    assert.deepEqual(await f.items(), []); assert(await f.running());
    const receipt = await (await f.chat.harness.submission(item.id, context))!.status(context);
    assert.equal(receipt.status, "unanswered"); assert.equal(receipt.reason, "aborted");
    f.gate.resolve(); await f.chat.conversation.waitForIdle(context);
    assert.equal(f.faux.state.callCount, 2); assert(!f.requests[0].includes("This must be withdrawn"));
  } finally { f.gate.resolve(); await f.app.close(); f.terminal.dispose(); }
});

test("/interrupt durably cancels foreground work and queued inputs without admitting a command or losing a newer draft", { timeout: 10000 }, async (t) => {
  const f = await setup();
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  try {
    await f.send("Initial input."); await until(f.running);
    await f.send("/steer Never place this steer."); await f.send("/followup Never start this follow-up.");
    const items = await f.items(); assert.equal(items.length, 2);
    const abort = f.chat.conversation.abort.bind(f.chat.conversation);
    t.mock.method(f.chat.conversation, "abort", async (...args: Parameters<typeof abort>) => { entered.resolve(); await gate.promise; return abort(...args); });
    await f.send("/interrupt"); await entered.promise;
    f.app.ui.composer.editor.setText("Preserve my next draft."); gate.resolve();
    await until(() => !f.app.ui.busy); await f.terminal.flush();
    assert.deepEqual(await f.items(), []); assert.equal(f.faux.state.callCount, 1);
    assert.equal(f.app.ui.composer.editor.getExpandedText(), "Preserve my next draft.");
    for (const item of items) assert.equal((await (await f.chat.harness.submission(item.id, context))!.status(context)).status, "unanswered");
    const users = (await f.chat.conversation.context(context)).messages.filter((message) => message.role === "user");
    assert.equal(users.length, 1); assert(!JSON.stringify(users).includes("/interrupt"));
  } finally { gate.resolve(); f.gate.resolve(); await f.app.close(); f.terminal.dispose(); }
});

test("steer/follow-up admission rejects blank input, and session reset refuses surviving queued work after a provider failure", { timeout: 10000 }, async () => {
  const f = await setup(undefined, true);
  try {
    for (const command of ["/steer", "/followup"]) { await f.send(command); assert.match(f.terminal.text(), /followed by the input/); }
    assert.equal(f.faux.state.callCount, 0);
    await f.send("Initial input."); await until(f.running);
    await f.send("/followup Keep this queued.");
    f.gate.resolve(); await until(async () => !(await f.chat.harness.snapshot(LiveDoc, f.chat.conversation.id, context))?.run);
    assert.equal((await f.items()).length, 1);
    await f.send("/new"); assert.match(f.terminal.text(), /Unfinished work/);
    assert.equal((await f.items()).length, 1);
    await f.chat.conversation.abort(context);
  } finally { f.gate.resolve(); await f.app.close(); f.terminal.dispose(); }
});

test("/interrupt can clear paused recovery and its inbox without starting another model request", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-paused-inbox-")), file = join(directory, "chat.sqlite");
  const f = await setup(file), terminal = new TestTerminal(100, 30);
  let reopened: ChatHandle | undefined, app: Awaited<ReturnType<typeof mountChat>> | undefined;
  try {
    await f.send("Initial input."); await until(f.running);
    await f.send("/followup Never recover this input."); await f.app.close();
    reopened = await openPersistentChat(file, f.models, { registry: f.registry, onLockLost: lockLost });
    reopened.beforeModel = async () => { throw new Error("Offline authentication gate."); };
    reopened.command = chatCommands(reopened, f.models); app = await mountChat(reopened, terminal, false);
    assert.equal((await reopened.harness.inspect(context)).scheduling, "paused");
    app.ui.composer.editor.setText("/interrupt"); terminal.send("\r"); await until(() => !app!.ui.busy);
    assert.equal((await reopened.harness.snapshot(InboxDoc, reopened.conversation.id, context))?.items.length, 0);
    assert.equal((await reopened.harness.inspect(context)).tasks.length, 0);
    assert.equal(f.faux.state.callCount, 1); assert.equal(f.toolCalls(), 1);
  } finally { f.gate.resolve(); await app?.close(); await reopened?.close(); await f.app.close(); f.terminal.dispose(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("native queued inputs survive SQLite close/reopen, and interrupted unsafe tools are not executed twice", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-inbox-reopen-")), file = join(directory, "chat.sqlite");
  const f = await setup(file);
  let reopened: ChatHandle | undefined, app: Awaited<ReturnType<typeof mountChat>> | undefined;
  const terminal = new TestTerminal(100, 30);
  try {
    await f.send("Initial input."); await until(f.running);
    await f.send("/steer Recovered steer."); await f.send("/followup Recovered follow-up.");
    const before = await f.items(); assert.equal(before.length, 2);
    await f.app.close();
    reopened = await openPersistentChat(file, f.models, { registry: f.registry, onLockLost: lockLost });
    assert.deepEqual((await reopened.harness.snapshot(InboxDoc, reopened.conversation.id, context))?.items, before);
    assert.equal((await reopened.harness.inspect(context)).scheduling, "paused"); assert.equal(f.faux.state.callCount, 1);
    reopened.command = chatCommands(reopened, f.models);
    app = await mountChat(reopened, terminal, false);
    await reopened.conversation.waitForIdle(context);
    assert.equal(f.faux.state.callCount, 3); assert.equal(f.toolCalls(), 1);
    assert.match(f.requests[0], /Recovered steer/); assert.match(f.requests[0], /interrupted/);
    assert(!f.requests[0].includes("Recovered follow-up")); assert.match(f.requests[1], /Recovered follow-up/);
    assert.equal((await reopened.harness.snapshot(InboxDoc, reopened.conversation.id, context))?.items.length, 0);
  } finally { f.gate.resolve(); await app?.close(); await reopened?.close(); await f.app.close(); f.terminal.dispose(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});
