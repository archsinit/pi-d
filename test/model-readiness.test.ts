import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { CompactionTask, createRegistry, defineExtension, defineTask, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { modelReadinessGate, modelReadinessPending } from "../src/model-readiness.ts";
import { openPersistentChat } from "../src/session.ts";
import { lockLost, model, testModels } from "./models.ts";
import { until } from "./subagent-fixtures.ts";

// No subagent extension: authorization must apply at the host model API boundary, not a selected task hook.
test("per-Harness readiness guards stream/complete APIs without mutating shared models or gating local auth/catalog reads", async () => {
  const { models, faux } = testModels({ responses: Array.from({ length: 5 }, () => fauxAssistantMessage("AUTHORIZED")) });
  const a = modelReadinessGate(models), b = modelReadinessGate(models), selected = models.getModel(model.provider, model.modelId)!;
  const first = a.models.streamSimple(selected, { messages: [] }), second = b.models.completeSimple(selected, { messages: [] });
  try {
    await a.models.checkAuth(model.provider); assert.equal(a.models.getModel(model.provider, model.modelId), selected);
    await delay(20); assert.equal(faux.state.callCount, 0);
    a.allow(); assert.equal((await first.result()).stopReason, "stop"); assert.equal(faux.state.callCount, 1);
    await delay(20); assert.equal(faux.state.callCount, 1, "Authorizing one Harness cannot authorize another.");
    b.allow(); assert.equal((await second).stopReason, "stop"); assert.equal(faux.state.callCount, 2);
    a.close(); assert.equal((await models.completeSimple(selected, { messages: [] })).stopReason, "stop"); assert.equal(faux.state.callCount, 3);
    assert.equal((await b.models.complete(selected, { messages: [] })).stopReason, "stop");
    assert.equal((await b.models.stream(selected, { messages: [] }).result()).stopReason, "stop");
    assert.equal(faux.state.callCount, 5);
  } finally { a.close(); b.close(); }
});

test("cancelling/closing a permission wait settles without provider work, and a late approval cannot revive it", async (t) => {
  const { models, faux } = testModels({ responses: [fauxAssistantMessage("Unreachable")] }), selected = models.getModel(model.provider, model.modelId)!;
  const readiness = modelReadinessGate(models), controller = new AbortController();
  const stream = readiness.models.streamSimple(selected, { messages: [] }, { signal: controller.signal });
  controller.abort(new Error("Cancelled before approval.")); readiness.allow();
  assert.equal((await stream.result()).stopReason, "error"); assert.equal(faux.state.callCount, 0); readiness.close();
  const closing = modelReadinessGate(models), pending = closing.models.completeSimple(selected, { messages: [] });
  const images = t.mock.method(models, "generateImages"), classify = t.mock.method(models, "classify");
  const imageModel = { ...selected, type: "image" as const, output: ["image" as const] }, classifierModel = { ...selected, type: "classifier" as const };
  const image = closing.models.generateImages(imageModel, { input: [] }), classification = closing.models.classify(classifierModel, { state: {}, questions: {} });
  const deferred = closing.models.streamDeferred(selected, { provider: model.provider, modelId: model.modelId, api: selected.api, id: "unissued" });
  closing.close(); closing.allow(); const answer = await pending; assert.equal(answer.stopReason, "error"); assert.match(answer.errorMessage!, /readiness closed/);
  assert.equal((await deferred.result()).stopReason, "error"); assert.equal(faux.state.deferredFetchCount, 0);
  assert.equal((await image).stopReason, "aborted"); assert.equal((await classification).stopReason, "aborted");
  assert.equal(images.mock.callCount(), 0); assert.equal(classify.mock.callCount(), 0); assert.equal(faux.state.callCount, 0);
  const authorized = modelReadinessGate(models); authorized.allow();
  try {
    assert.equal((await authorized.models.generateImages(imageModel, { input: [] })).stopReason, "error");
    assert.equal((await authorized.models.classify(classifierModel, { state: {}, questions: {} })).stopReason, "error");
    assert.equal(images.mock.callCount(), 1); assert.equal(classify.mock.callCount(), 1);
  } finally { authorized.close(); }
});

test("cancelled complete/completeSimple/fetchDeferred waits preserve stock assistant-result semantics without provider work", async () => {
  const { models, faux } = testModels({ deferred: { pollAfterMs: 0 } }), selected = models.getModel(model.provider, model.modelId)!;
  const readiness = modelReadinessGate(models), controller = new AbortController(); controller.abort(new Error("Cancelled before approval."));
  try {
    for (const method of ["complete", "completeSimple", "fetchDeferred"] as const) {
      const input = method === "fetchDeferred" ? { ...model, api: selected.api, id: "unissued" } : { messages: [] };
      const original = await models[method](selected, input as never, { signal: controller.signal });
      const guarded = await readiness.models[method](selected, input as never, { signal: controller.signal });
      assert.equal(guarded.stopReason, original.stopReason); assert.equal(guarded.errorMessage, original.errorMessage);
    }
    readiness.allow(); assert.equal(faux.state.callCount, 0); assert.equal(faux.state.deferredFetchCount, 0);
  } finally { readiness.close(); }
});

for (const streaming of [false, true]) test(`host close seals readiness before joining an extension's ${streaming ? "stream" : "complete"} call without an optional request signal`, { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-ready-close-"))), path = join(directory, "session.sqlite");
  const { models, faux } = testModels({ responses: [fauxAssistantMessage("Unreachable")] }); let requested = false, settled = false;
  const request = defineTask<Record<string, never>, { phase: "request" }, Record<string, never>>({ name: "ready-close-probe", version: 1, initial: () => ({ phase: "request" }), phases: {
    request: async (_task, runtime, ctx) => {
      const selected = runtime.models.getModel(model.provider, model.modelId)!; requested = true;
      // The request signal is optional in the public Models API; the host must still close this wait.
      const answer = await (streaming ? runtime.models.streamSimple(selected, { messages: [] }).result() : runtime.models.completeSimple(selected, { messages: [] }));
      settled = true; assert.equal(answer.stopReason, "error");
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), ctx);
    },
  }, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });
  const registry = createRegistry(); registry.install(defineExtension({ name: "ready-close-probe", tasks: [request] }));
  const chat = await openPersistentChat(path, models, { registry, defaults: { model }, gateModelWork: true, onLockLost: lockLost });
  try {
    const conversationId = chat.conversation.id;
    await chat.harness.commit((tx) => tx.createTask(request, {}, { conversationId, ownership: { kind: "conversation" }, background: true }), context);
    chat.harness.resume(); await until(() => requested); assert.equal(faux.state.callCount, 0);
    const closed = chat.close(); chat.allowModel?.(); await closed;
    assert(settled); assert.equal(faux.state.callCount, 0); assert.equal((await chat.harness.closed).reason, "closed");
  } finally { await chat.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a recovered prepared background compaction cannot spend quota through local abort before host approval, even without subagents", { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-ready-compaction-"))), path = join(directory, "session.sqlite");
  const first = testModels({ responses: Array.from({ length: 4 }, () => fauxAssistantMessage("Seed history. " + "x".repeat(800))) });
  const options = { registry: createRegistry(), settings: { compaction: { enabled: false, keepRecentTokens: 100 }, retry: { enabled: false } } };
  let harness = await Harness.open(await openNodeSqliteStorage(path), { ...options, models: first.models }, context);
  let readiness: ReturnType<typeof modelReadinessGate> | undefined;
  try {
    let root = await harness.root(context, { agent: { model } });
    for (let index = 0; index < 4; index++) { const input = await root.submit({ type: "input", content: `History ${index}. ` + "h".repeat(800) }, context); await input.wait(context); }
    await harness.close(context);
    const next = testModels({ responses: [fauxAssistantMessage("## Goal\nRecover the native summary.\n## Progress\nSummary finished.")] });
    readiness = modelReadinessGate(next.models);
    harness = await Harness.open(await openNodeSqliteStorage(path), { ...options, models: readiness.models }, context); readiness.attach(harness); root = await harness.root(context);
    const conversationId = root.id;
    const id = await harness.commit(async (tx) => {
      // Public native task/document surfaces seed the same background compaction metadata as threshold admission.
      const live = await tx.doc(LiveDoc, conversationId);
      const taskId = await tx.createTask(CompactionTask, { reason: "threshold" }, { conversationId, ownership: { kind: "conversation" }, background: true });
      live.compactions = [{ taskId, reason: "threshold", blocking: false, attempt: 1 }]; return taskId;
    }, context);
    await root.abort(context);
    await until(async () => { const task = await harness.getTask(id, context); return task?.state.status === "running" && (task.state.checkpoint as { phase: string }).phase === "summarize"; });
    await delay(20); assert.equal(next.faux.state.callCount, 0); assert(await modelReadinessPending(harness));
    await harness.close(context); readiness.close();
    readiness = modelReadinessGate(next.models);
    harness = await Harness.open(await openNodeSqliteStorage(path), { ...options, models: readiness.models }, context); readiness.attach(harness); root = await harness.root(context);
    await root.abort(context); await delay(30); assert.equal(next.faux.state.callCount, 0);
    readiness.allow(); assert.equal((await harness.waitForTask(id, context)).state.outcome.status, "completed");
    assert.equal(next.faux.state.callCount, 1); assert(!await modelReadinessPending(harness));
  } finally { await harness.close(context); readiness?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("recovered native deferred polling stays behind readiness when local root cancellation resumes scheduling", { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-ready-deferred-"))), path = join(directory, "session.sqlite");
  const { models, faux } = testModels({ deferred: { pollAfterMs: 60000 }, responses: [fauxAssistantMessage("DEFERRED-RECOVERED")] });
  const options = { registry: createRegistry(), models, settings: { stream: { deferred: true }, retry: { enabled: false }, compaction: { enabled: false } } };
  let harness = await Harness.open(await openNodeSqliteStorage(path), { ...options, now: () => 100 }, context);
  let readiness: ReturnType<typeof modelReadinessGate> | undefined;
  try {
    await harness.root(context, { agent: { model } });
    // Independent ordinary scope survives cancellation of root, as background worker scopes also do.
    const other = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    const input = await other.submit({ type: "input", content: "Deferred fixture" }, context);
    await until(async () => !!(await harness.snapshot(LiveDoc, other.id, context))?.generation?.deferred);
    assert.equal(faux.state.callCount, 1); assert.equal(faux.state.deferredFetchCount, 0); await harness.close(context);
    readiness = modelReadinessGate(models);
    harness = await Harness.open(await openNodeSqliteStorage(path), { ...options, models: readiness.models, now: () => 1000000 }, context); readiness.attach(harness);
    await (await harness.root(context)).abort(context); await delay(30);
    assert.equal(faux.state.deferredFetchCount, 0); assert.equal(faux.state.callCount, 1); assert(await modelReadinessPending(harness));
    readiness.allow(); const original = await harness.submission(input.id, context); assert(original); assert.equal((await original.wait(context)).status, "done");
    assert.equal(faux.state.deferredFetchCount, 1); assert.equal(faux.state.callCount, 1);
  } finally { await harness.close(context); readiness?.close(); await rm(directory, { recursive: true, force: true }); }
});
