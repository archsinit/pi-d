import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, InboxDoc, MemoryStorage, ROOT_CONVERSATION_ID, wrapTool,
  type Conversation, type HarnessOptions, type Storage, type StorageWrite, type TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSubagentsExtension } from "../src/subagents/index.ts";
import { messageTool } from "../src/subagents/messaging.ts";
import { MessageCall, Messages, Jobs, Worker, WORKER_KIND, type JobResult, type MessageReceipt } from "../src/subagents/state.ts";
import { readJob, resultView } from "../src/subagents/view.ts";
import { gate, until, userText, workerName, toolResults } from "./subagent-fixtures.ts";
import { model, testModels } from "./models.ts";

const call = (name: string, args: { [key: string]: JsonValue }) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const results = (view: { messages: readonly TranscriptContext["messages"][number][] }) => view.messages.filter((message) => message.role === "toolResult");
const afterTool = (transcript: TranscriptContext) => transcript.messages.filter((message) => message.role !== "system").at(-1)?.role === "toolResult";
const tasks = (names = ["A"], assigned = false) => names.map((name) => ({ name, task: `Complete ${name}.`, ...(assigned ? { extensions: ["message-fixture"] } : {}) }));
async function fixture(worker: FauxResponseFactory, options: Partial<HarnessOptions> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-messaging-")));
  let requested = { name: "delegate", args: { tasks: tasks() } as { [key: string]: JsonValue } };
  const respond: FauxResponseFactory = (transcript, ...rest) => workerName(transcript) ? worker(transcript, ...rest)
    : afterTool(transcript) ? fauxAssistantMessage("Coordinator retains control.") : call(requested.name, requested.args);
  const { models, faux } = testModels({ tokenSize: { min: 4096, max: 4096 }, responses: Array.from({ length: 150 }, () => respond) });
  const registry = createRegistry(); registry.install(createSubagentsExtension());
  const storage = new MemoryStorage(), harness = await Harness.open(storage, { models, registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }), settings: { retry: { enabled: false }, compaction: { enabled: false } }, ...options }, context);
  const root = await harness.root(context, { agent: { model, cwd: directory } });
  const invoke = async (name: string, args: { [key: string]: JsonValue }, conversation: Conversation = root) => {
    requested = { name, args };
    const input = await conversation.submit({ type: "input", content: `Invoke ${name}.` }, context);
    assert.equal((await input.wait(context)).status, "done");
    const result = results(await conversation.context(context)).at(-1)!; assert.equal(result.toolName, name); return result;
  };
  const start = async (names = ["A"], assigned = false) => {
    assert(!(await invoke("delegate", { tasks: tasks(names, assigned) })).isError);
    return (await harness.snapshot(Jobs, root.id, context))!.recent.at(-1)!;
  };
  const message = (jobId: TaskId, message: string, mode?: string, worker = 1) => invoke("agent_message", { jobId, worker, message, ...(mode ? { mode } : {}) });
  return { directory, models, faux, registry, storage, harness, root, invoke, start, message,
    close: async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); } };
}
function receipt(result: ReturnType<typeof toolResults>[number]): MessageReceipt {
  assert(!result.isError, JSON.stringify(result)); const value = result.details as MessageReceipt;
  assert.equal(value.status, "queued"); assert.match(value.requestId, /^subagent-message:\d+$/); return value;
}

test("native worker inbox admits promptly while a tool is busy; steering/follow-ups use stock boundaries and the last report", { timeout: 15000 }, async () => {
  const held = Promise.withResolvers<void>(); let toolStarted = false, toolFinished = false;
  const requests: string[] = [];
  const f = await fixture((transcript) => {
    const text = userText(transcript); requests.push(text);
    if (!toolResults(transcript).length) return call("hold_fixture", {});
    return fauxAssistantMessage(text.includes("FOLLOW-TWO") ? "LATEST-REPORT" : text.includes("FOLLOW-ONE") ? "INTERMEDIATE-REPORT" : "FIRST-REPORT");
  });
  f.registry.install(defineExtension({ name: "message-fixture", tools: [defineTool({ name: "hold_fixture", description: "Offline gate", parameters: Type.Object({}),
    async execute(_args, _api, ctx) { toolStarted = true; await gate(held.promise, ctx.abortSignal); toolFinished = true; return { output: [{ type: "text", text: "Released." }] }; },
  })] }));
  try {
    const jobId = await f.start(["A"], true); await until(() => toolStarted);
    const sent = [receipt(await f.message(jobId, "FOLLOW-ONE", "followUp")), receipt(await f.message(jobId, "STEER-ONE")),
      receipt(await f.message(jobId, "STEER-TWO", "steer")), receipt(await f.message(jobId, "FOLLOW-TWO", "followUp"))];
    assert.equal(toolFinished, false); assert.equal(requests.length, 1, "Acknowledgements cannot wait for the busy worker.");
    const childId = sent[0].conversationId;
    const inbox = (await f.harness.snapshot(InboxDoc, childId, context))!.items;
    assert.deepEqual(inbox.map((item) => item.mode), ["followUp", "steer", "steer", "followUp"]);
    assert.deepEqual(inbox.map((item) => item.id), sent.map((item) => item.submissionId));
    assert.equal(new Set(sent.map((item) => item.requestId)).size, 4);
    for (const item of sent) assert.equal((await (await f.harness.submission(item.submissionId, context))!.status(context)).status, "queued");
    const before = (await f.root.context(context)).messages.length, running = await readJob(f.harness, f.root.id, jobId, context);
    assert.deepEqual((await f.harness.snapshot(Messages, running.workers[0].id, context))?.requests, sent.map((item) => item.requestId));
    assert.equal((await f.harness.snapshot(Messages, running.workers[0].id, context))?.closed, false);
    held.resolve(); await f.harness.waitForTask(jobId, context);
    assert.equal(requests.length, 4);
    assert.match(requests[1], /STEER-ONE/); assert(!requests[1].includes("STEER-TWO")); assert(!requests[1].includes("FOLLOW-ONE"));
    assert.match(requests[2], /STEER-TWO/); assert.match(requests[2], /FOLLOW-ONE/); assert(!requests[2].includes("FOLLOW-TWO"));
    assert.match(requests[3], /FOLLOW-TWO/);
    const saved = await readJob(f.harness, f.root.id, jobId, context), view = resultView(saved.job, saved.workers);
    assert.equal(view.status, "completed"); assert.equal(view.workers[0].report, "LATEST-REPORT");
    assert.equal((await f.root.context(context)).messages.length, before, "Completion must not inject parent input.");
    assert.equal(await f.harness.snapshot(Messages, saved.workers[0].id, context), undefined, "Native task-scoped references retire at settlement.");
    for (const item of sent) {
      const native = await (await f.harness.submission(item.submissionId, context))!.status(context);
      assert.equal(native.status, "done"); assert.equal(native.requestId, item.requestId);
    }
    assert.deepEqual((await f.harness.snapshot(InboxDoc, childId, context))?.items, []);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { held.resolve(); await f.close(); }
});

test("messaging during an in-flight provider request is queued, not a forced interruption or stale first-answer completion", { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(); let firstStarted = false, firstFinished = false;
  const f = await fixture(async (transcript, options) => {
    if (userText(transcript).includes("LATE-STEER")) return fauxAssistantMessage("REVISED-REPORT");
    firstStarted = true; await gate(held.promise, options?.signal); firstFinished = true; return fauxAssistantMessage("STALE-FIRST-REPORT");
  });
  try {
    const jobId = await f.start(); await until(() => firstStarted);
    const ack = receipt(await f.message(jobId, "LATE-STEER")); assert.equal(firstFinished, false);
    held.resolve(); await f.harness.waitForTask(jobId, context);
    const saved = await readJob(f.harness, f.root.id, jobId, context);
    assert.equal(resultView(saved.job, saved.workers).workers[0].report, "REVISED-REPORT");
    assert.equal((await (await f.harness.submission(ack.submissionId, context))!.status(context)).status, "done");
  } finally { held.resolve(); await f.close(); }
});

test("a running follow-up accepts further input after the original assignment settled and survives coordinator interruption", { timeout: 10000 }, async () => {
  const first = Promise.withResolvers<void>(), follow = Promise.withResolvers<void>(); let phase = 0;
  const f = await fixture(async (transcript, options) => {
    const text = userText(transcript);
    if (text.includes("DURING-FOLLOW-UP")) return fauxAssistantMessage("LAST-REPORT");
    if (text.includes("FIRST-FOLLOW-UP")) { phase = 2; await gate(follow.promise, options?.signal); return fauxAssistantMessage("FOLLOW-UP-REPORT"); }
    phase = 1; await gate(first.promise, options?.signal); return fauxAssistantMessage("ASSIGNMENT-REPORT");
  });
  try {
    const jobId = await f.start(); await until(() => phase === 1);
    const initial = receipt(await f.message(jobId, "FIRST-FOLLOW-UP", "followUp")); first.resolve(); await until(() => phase === 2);
    const native = (await f.storage.scanSubmissions({ conversationId: initial.conversationId }, 10, undefined, context)).items;
    assert.equal(native[0].status, "done");
    const later = receipt(await f.message(jobId, "DURING-FOLLOW-UP"));
    await f.root.abort(context); assert.notEqual((await f.harness.getTask(jobId, context))?.state.status, "terminal");
    const before = (await f.root.context(context)).messages.length; follow.resolve(); await f.harness.waitForTask(jobId, context);
    const saved = await readJob(f.harness, f.root.id, jobId, context); assert.equal(resultView(saved.job, saved.workers).workers[0].report, "LAST-REPORT");
    assert.equal((await (await f.harness.submission(later.submissionId, context))!.status(context)).status, "done");
    assert.equal((await f.root.context(context)).messages.length, before);
  } finally { first.resolve(); follow.resolve(); await f.close(); }
});

test("native all queue modes retain complete Unicode messages without an extension size cap", { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(), payload = "你好👩🏽‍💻".repeat(16000); let started = false, requests = 0;
  const f = await fixture(async (transcript, options) => {
    requests++;
    if (userText(transcript).includes("FOLLOW-ALL")) {
      const users = transcript.messages.filter((message) => message.role === "user").map((message) => message.content);
      assert(users.includes(payload)); assert(users.includes("STEER-ALL")); assert(users.includes("FOLLOW-ALL")); assert(users.includes("FOLLOW-ALSO"));
      return fauxAssistantMessage("ALL-REPORT");
    }
    started = true; await gate(held.promise, options?.signal); return fauxAssistantMessage("FIRST-REPORT");
  }, { settings: { retry: { enabled: false }, compaction: { enabled: false }, steeringMode: "all", followUpMode: "all" } });
  try {
    const jobId = await f.start(); await until(() => started);
    receipt(await f.message(jobId, payload)); receipt(await f.message(jobId, "STEER-ALL"));
    receipt(await f.message(jobId, "FOLLOW-ALL", "followUp")); receipt(await f.message(jobId, "FOLLOW-ALSO", "followUp"));
    held.resolve(); await f.harness.waitForTask(jobId, context); assert.equal(requests, 2);
    const saved = await readJob(f.harness, f.root.id, jobId, context); assert.equal(resultView(saved.job, saved.workers).workers[0].report, "ALL-REPORT");
  } finally { held.resolve(); await f.close(); }
});

test("an assigned native extension cannot use nested calls to let a worker message itself or another worker", { timeout: 10000 }, async () => {
  let nestedCalls = 0;
  const f = await fixture((transcript) => toolResults(transcript).length ? fauxAssistantMessage("Nested orchestration rejected.") : call("try_nested_message", {}));
  f.registry.install(defineExtension({ name: "message-fixture", tools: [defineTool({ name: "try_nested_message", description: "Attempt nested orchestration", replay: "safe", parameters: Type.Object({}),
    async execute(_args, api, ctx) {
      const owner = (await api.snapshot(Worker, api.conversationId, ctx))!.owner!;
      for (const worker of [1, 2]) {
        const nested = await api.executeTool("agent_message", { jobId: owner.jobId, worker, message: "FORBIDDEN-NESTED-MESSAGE" }, ctx);
        nestedCalls++; assert(nested.isError); assert.match(JSON.stringify(nested), /not available|Only the main orchestrator/);
      }
      return { output: [{ type: "text", text: "Blocked." }] };
    },
  })] }));
  try {
    const assignments = tasks(["A", "B"], true).map((task) => ({ ...task, extensions: ["message-fixture", "pi-d-subagents"] }));
    assert(!(await f.invoke("delegate", { tasks: assignments })).isError);
    const jobId = (await f.harness.snapshot(Jobs, f.root.id, context))!.recent.at(-1)!; await f.harness.waitForTask(jobId, context);
    const saved = await readJob(f.harness, f.root.id, jobId, context); assert.equal(nestedCalls, 4);
    assert.equal(resultView(saved.job, saved.workers).status, "completed");
    for (const worker of resultView(saved.job, saved.workers).workers) {
      const submissions = (await f.storage.scanSubmissions({ conversationId: worker.conversationId! }, 10, undefined, context)).items;
      assert.equal(submissions.length, 1);
    }
  } finally { await f.close(); }
});

test("message validation and conversation ownership cannot affect another worker or enqueue rejected input", { timeout: 15000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = 0;
  const f = await fixture(async (_transcript, options) => { started++; await gate(held.promise, options?.signal); return fauxAssistantMessage("Done."); });
  try {
    const jobId = await f.start(["A", "B"]); await until(() => started === 2);
    const foreign = await f.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: f.directory } }, context);
    const bad: { [key: string]: JsonValue }[] = [
      { jobId, worker: 0, message: "Invalid." }, { jobId, worker: -1, message: "Invalid." }, { jobId, worker: 1.5, message: "Invalid." },
      { jobId, worker: 3, message: "Invalid." }, { jobId, worker: "1", message: "Invalid." }, { jobId: jobId + 0.5, worker: 1, message: "Invalid." },
      { jobId, worker: Number.MAX_SAFE_INTEGER + 1, message: "Invalid." }, { jobId, message: "Missing worker." }, { jobId, worker: 1, message: "  \n\t" },
      { jobId, worker: 1, message: "" }, { jobId, worker: 1, message: "Invalid mode.", mode: "interrupt" }, { jobId: 999999, worker: 1, message: "Unknown job." },
    ];
    for (const args of bad) assert((await f.invoke("agent_message", args)).isError, JSON.stringify(args));
    const rejected = await f.invoke("agent_message", { jobId, worker: 1, message: "FOREIGN-MESSAGE" }, foreign);
    assert(rejected.isError); assert.match(JSON.stringify(rejected), /not found in this conversation/);
    const ack = receipt(await f.message(jobId, "ONLY-B", undefined, 2));
    const saved = await readJob(f.harness, f.root.id, jobId, context);
    for (const worker of saved.workers) {
      assert(worker.state.status !== "terminal" && worker.state.status !== "completing" && worker.state.checkpoint.phase === "run");
      const id = worker.state.checkpoint.conversationId;
      const native = (await f.storage.scanSubmissions({ conversationId: id }, 30, undefined, context)).items;
      assert.equal(native.length, worker.input.index === 1 ? 2 : 1);
      assert.equal((await f.harness.snapshot(InboxDoc, id, context))?.items.length ?? 0, worker.input.index === 1 ? 1 : 0);
    }
    assert.equal(ack.worker, 2); assert.equal(started, 2);
    await f.invoke("agent_stop", { jobId }); await f.harness.waitForTask(jobId, context);
  } finally { held.resolve(); await f.close(); }
});

test("an unprepared worker rejects messages promptly rather than buffering or starting its assignment early", { timeout: 10000 }, async () => {
  const preparing = Promise.withResolvers<void>(), held = Promise.withResolvers<void>(); let requests = 0;
  const f = await fixture(() => { requests++; return fauxAssistantMessage("Report."); }, { env: ({ cwd }) => {
    const env = new NodeExecutionEnv({ cwd: cwd! }), canonicalPath = env.canonicalPath.bind(env);
    env.canonicalPath = async (...args) => { preparing.resolve(); await gate(held.promise, args[1]?.abortSignal); return canonicalPath(...args); }; return env;
  } });
  try {
    const jobId = await f.start(); await preparing.promise;
    const rejected = await f.message(jobId, "TOO-EARLY"); assert(rejected.isError); assert.match(JSON.stringify(rejected), /not ready|not started/);
    assert.equal(requests, 0);
    assert.equal((await f.storage.scanConversations({ ownerConversationId: f.root.id }, 10, undefined, context)).items.length, 0);
    held.resolve(); await f.harness.waitForTask(jobId, context); assert.equal(requests, 1);
  } finally { held.resolve(); await f.close(); }
});

for (const stopFirst of [false, true]) test(`native cancellation ${stopFirst ? "before" : "after"} message admission rejects/withdraws without resuming the worker`, { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = 0;
  const f = await fixture(async (_transcript, options) => { started++; await gate(held.promise, options?.signal); return fauxAssistantMessage("Late."); });
  try {
    const jobId = await f.start(); await until(() => started === 1);
    const ack = stopFirst ? undefined : receipt(await f.message(jobId, "NEVER-CONSUMED", "followUp"));
    await f.invoke("agent_stop", { jobId, worker: 1 });
    const rejected = await f.message(jobId, "AFTER-STOP"); assert(rejected.isError); assert.match(JSON.stringify(rejected), /cancellation|no longer active|not accepting/);
    await f.harness.waitForTask(jobId, context);
    if (ack) {
      const native = await (await f.harness.submission(ack.submissionId, context))!.status(context);
      assert.equal(native.status, "unanswered"); assert.equal(native.reason, "aborted");
    }
    assert.equal(started, 1); assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { held.resolve(); await f.close(); }
});

test("completion winning an admission race cannot restart a finished worker while its sibling remains active", { timeout: 10000 }, async () => {
  const a = Promise.withResolvers<void>(), b = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), admit = Promise.withResolvers<void>();
  let started = 0;
  const f = await fixture(async (transcript, options) => { started++; await gate(workerName(transcript) === "A" ? a.promise : b.promise, options?.signal); return fauxAssistantMessage("Final."); });
  f.registry.install(defineExtension({ name: "admission-race", wraps: [wrapTool(messageTool, (original) => ({ ...original,
    async execute(args, api, ctx) { entered.resolve(); await gate(admit.promise, ctx.abortSignal); return original.execute(args, api, ctx); },
  }))] }));
  try {
    const jobId = await f.start(["A", "B"]); await until(() => started === 2);
    const pending = f.message(jobId, "AFTER-COMPLETION"); await entered.promise;
    const saved = await readJob(f.harness, f.root.id, jobId, context); a.resolve(); await f.harness.waitForTask(saved.workers[0].id, context);
    admit.resolve(); const rejected = await pending; assert(rejected.isError); assert.match(JSON.stringify(rejected), /no longer active/);
    assert.equal(started, 2);
    const ended = (await f.harness.getTask(saved.workers[0].id, context))!; assert.equal(ended.state.status, "terminal");
    const native = (await f.storage.scanSubmissions({ conversationId: ended.state.outcome!.result!.conversationId! }, 10, undefined, context)).items;
    assert.equal(native.length, 1);
    b.resolve(); await f.harness.waitForTask(jobId, context);
    assert((await f.message(jobId, "TERMINAL-JOB")).isError); assert.equal(started, 2);
  } finally { admit.resolve(); a.resolve(); b.resolve(); await f.close(); }
});

for (const failFollowUp of [false, true]) test(`provider failure ${failFollowUp ? "after" : "before"} the first answer cannot strand queued messages or claim successful completion`, { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = false;
  const f = await fixture(async (transcript, options) => {
    if (!userText(transcript).includes("FOLLOW-FAILURE")) { started = true; await gate(held.promise, options?.signal); if (failFollowUp) return fauxAssistantMessage("FIRST-SUCCESS"); }
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "PRIVATE-PROVIDER-FAILURE" });
  });
  try {
    const jobId = await f.start(); await until(() => started); const ack = receipt(await f.message(jobId, "FOLLOW-FAILURE", "followUp"));
    held.resolve(); await f.harness.waitForTask(jobId, context);
    const saved = await readJob(f.harness, f.root.id, jobId, context), view = resultView(saved.job, saved.workers);
    assert.equal(view.status, "failed"); assert.match(view.workers[0].error!, /unanswered/); assert(!JSON.stringify(view).includes("PRIVATE-PROVIDER-FAILURE"));
    assert.equal((await (await f.harness.submission(ack.submissionId, context))!.status(context)).status, "unanswered");
    assert.deepEqual((await f.harness.snapshot(InboxDoc, ack.conversationId, context))?.items, []);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { held.resolve(); await f.close(); }
});

const cutpoints = ["close", "queue admission", "cancel after queue", "placement", "first answer", "follow-up answer", "worker receipt"] as const;
for (const cut of cutpoints) test(`SQLite messaging recovery at ${cut} preserves one input/receipt and the final report`, { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-message-recovery-"))), path = join(directory, "session.sqlite");
  const held = Promise.withResolvers<void>(); let started = false, tripped = false, reopened = false, recoveredRequests = 0;
  const original = await openNodeSqliteStorage(path);
  const storage: Storage = new Proxy(original, { get(target, key) {
    if (key === "commit") return async (writes: readonly StorageWrite[], ctx: typeof context) => {
      const seq = await target.commit(writes, ctx);
      const hit = writes.some((write) => cut === "queue admission" || cut === "cancel after queue" || cut === "placement"
        ? write.type === "submission" && write.value.requestId?.startsWith("subagent-message:") && write.value.status === (cut === "placement" ? "placed" : "queued")
        : cut === "worker receipt" ? write.type === "task" && write.value.kind === WORKER_KIND && write.value.state.status === "terminal"
          : write.type === "entry" && write.value.conversationId !== ROOT_CONVERSATION_ID && write.value.kind === "pi.assistant"
            && JSON.stringify(write.value.model).includes(cut === "first answer" ? "FIRST-REPORT" : "FINAL-REPORT"));
      if (cut !== "close" && !tripped && hit) { tripped = true; throw new Error("Injected lost messaging commit acknowledgement."); }
      return seq;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  let jobId: TaskId<JobResult>;
  const respond: FauxResponseFactory = async (transcript, options) => {
    if (workerName(transcript)) {
      if (reopened) recoveredRequests++;
      if (userText(transcript).includes("RECOVERED-FOLLOW-UP")) return fauxAssistantMessage("FINAL-REPORT");
      if (!reopened) { started = true; await gate(held.promise, options?.signal); }
      return fauxAssistantMessage("FIRST-REPORT");
    }
    if (afterTool(transcript)) return fauxAssistantMessage("Coordinator acknowledgement.");
    return userText(transcript).includes("SEND-MESSAGE") ? call("agent_message", { jobId, worker: 1, message: "RECOVERED-FOLLOW-UP", mode: "followUp" })
      : call("delegate", { tasks: tasks() });
  };
  const open = async (store: Storage) => {
    const { models } = testModels({ responses: Array.from({ length: 30 }, () => respond) });
    const registry = createRegistry(); registry.install(createSubagentsExtension());
    if (reopened && (cut === "queue admission" || cut === "cancel after queue")) registry.install(defineExtension({ name: "replay-after-settlement", wraps: [wrapTool(messageTool, (original) => ({ ...original,
      async execute(args, api, ctx) { await api.waitForTask(args.jobId as TaskId, ctx); return original.execute(args, api, ctx); },
    }))] }));
    return Harness.open(store, { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }),
      settings: { retry: { enabled: false }, compaction: { enabled: false } }, onReport: () => {} }, context);
  };
  let harness = await open(storage);
  try {
    let root = await harness.root(context, { agent: { model, cwd: directory } });
    const initial = await root.submit({ type: "input", content: "Start worker." }, context); assert.equal((await initial.wait(context)).status, "done");
    jobId = (await harness.snapshot(Jobs, root.id, context))!.recent.at(-1)!; await until(() => started);
    const sent = await root.submit({ type: "input", content: "SEND-MESSAGE", requestId: "message-parent" }, context);
    const waiting = sent.wait(context).catch((error: unknown) => error);
    if (cut === "queue admission" || cut === "cancel after queue") { await until(() => tripped); await harness.closed; await waiting; }
    else {
      assert.equal((await waiting as { status: string }).status, "done");
      if (cut === "close") await harness.close(context);
      else { held.resolve(); await until(() => tripped); await harness.closed; }
    }
    reopened = true;
    const resumedStorage = await openNodeSqliteStorage(path); harness = await open(resumedStorage); root = await harness.root(context);
    if (cut === "cancel after queue") await harness.abortTask(jobId, context);
    const same = await root.submit({ type: "input", content: "SEND-MESSAGE", requestId: "message-parent" }, context);
    assert.equal(same.id, sent.id); assert.equal((await same.wait(context)).status, "done");
    await harness.waitForTask(jobId, context);
    const saved = await readJob(harness, root.id, jobId, context), view = resultView(saved.job, saved.workers);
    assert.equal(view.status, cut === "cancel after queue" ? "aborted" : "completed", JSON.stringify(view));
    assert.equal(view.workers[0].report, cut === "cancel after queue" ? "" : "FINAL-REPORT");
    if (cut === "cancel after queue") assert.equal(recoveredRequests, 0, "Cancellation must not resume model work.");
    const children = (await resumedStorage.scanConversations({ ownerConversationId: root.id }, 10, undefined, context)).items; assert.equal(children.length, 1);
    const native = (await resumedStorage.scanSubmissions({ conversationId: children[0].id }, 10, undefined, context)).items;
    assert.equal(native.length, 2); assert(native.every((item) => item.status === (cut === "cancel after queue" ? "unanswered" : "done")));
    const message = native.find((item) => item.requestId?.startsWith("subagent-message:"))!; assert(message);
    const callId = Number(message.requestId!.split(":")[1]) as TaskId;
    const ack = receipt(results(await root.context(context)).find((item) => item.toolName === "agent_message")!);
    assert.equal(await harness.snapshot(MessageCall, callId, context), undefined, "The durable result replaces the task-scoped replay memo after settlement.");
    assert.equal(ack.submissionId, message.id); assert.equal(ack.requestId, message.requestId); assert.equal(ack.status, "queued", "Replay returns admission, not a new consumption claim.");
    const transcript = await (await harness.conversation(children[0].id, context))!.context(context);
    assert.equal(transcript.messages.filter((item) => item.role === "user" && item.content === "RECOVERED-FOLLOW-UP").length, cut === "cancel after queue" ? 0 : 1);
    assert.equal(results(await root.context(context)).filter((item) => item.toolName === "agent_message").length, 1);
    assert.equal((await harness.inspect(context)).tasks.length, 0);
  } finally { held.resolve(); await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});
