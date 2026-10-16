import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, Harness, InboxDoc, MemoryStorage, ROOT_CONVERSATION_ID,
  type Conversation, type Storage, type TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Transcript } from "../src/transcript.ts";
import { createSubagentsExtension } from "../src/subagents/index.ts";
import { SubagentJob } from "../src/subagents/tasks.ts";
import { SubagentCompletion } from "../src/subagents/completion.ts";
import { COMPLETION_ENTRY, COMPLETION_KIND, JOB_KIND, Jobs, Worker, type JobResult } from "../src/subagents/state.ts";
import { readJob, resultView } from "../src/subagents/view.ts";
import { completionJob, gate, until, userText, workerName, toolResults } from "./subagent-fixtures.ts";
import { model, testModels } from "./models.ts";

const call = (name: string, args: { [key: string]: JsonValue }) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const lastUser = (transcript: TranscriptContext) => {
  const message = transcript.messages.findLast((message) => message.role === "user");
  return !message ? "" : typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
};
const resultJob = (message: ReturnType<typeof toolResults>[number]) => Number(message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").match(/^Subagent job (\d+)/)?.[1]);
type Admission = { jobId: TaskId<JobResult>; completionTaskId?: TaskId };
async function fixture(options: { worker?: FauxResponseFactory; faultedJob?: boolean; faultedAbort?: boolean; callbackFailure?: boolean; storage?: Storage } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-completion-"))), storage = options.storage ?? new MemoryStorage();
  const actions = new Map<string, FauxResponseFactory>(), rootRequests: TranscriptContext[] = [];
  const { models, faux } = testModels({ responses: Array.from({ length: 500 }, () => async (transcript, ...rest) => {
    if (workerName(transcript)) return options.worker?.(transcript, ...rest) ?? fauxAssistantMessage(`SAVED-REPORT-${workerName(transcript)}`);
    rootRequests.push(transcript);
    if (completionJob(transcript) !== undefined) {
      if (options.callbackFailure) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "PRIVATE-CALLBACK-PROVIDER-ERROR" });
      // Native follow-up admission can batch several job events into one run. Retrieve each, not just the last event.
      const ids = transcript.messages.flatMap((message) => {
        if (message.role !== "user") return [];
        const text = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        const match = text.match(/^\[Subagent completion\]\nJob ID: (\d+)\n/); return match ? [Number(match[1])] : [];
      });
      const read = new Set(toolResults(transcript).filter((message) => message.toolName === "agent_results").map(resultJob));
      const next = ids.find((id) => !read.has(id));
      return next === undefined ? fauxAssistantMessage(`AUTO-UPDATE ${ids.join(",")}`) : call("agent_results", { jobId: next });
    }
    if (transcript.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Coordinator retains control.");
    return actions.get(lastUser(transcript))?.(transcript, ...rest) ?? fauxAssistantMessage("Ordinary coordinator answer.");
  }) });
  const registry = createRegistry(), extension = createSubagentsExtension();
  registry.install(options.faultedJob || options.faultedAbort ? { ...extension, tasks: extension.tasks!.map((task) => task.definition.name === JOB_KIND ? defineTask({
    ...SubagentJob.definition,
    ...(options.faultedJob ? { phases: { ...SubagentJob.definition.phases, dispatch: async () => { throw new Error("PRIVATE-JOB-FAULT"); } } }
      : { abort: async () => { throw new Error("PRIVATE-ABORT-FAULT"); } }),
  }) : task) } : extension);
  const harness = await Harness.open(storage, { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }),
    settings: { retry: { enabled: false }, compaction: { enabled: false } }, onReport: () => {} }, context);
  const root = await harness.root(context, { agent: { model, cwd: directory } });
  const submit = (content: string, conversation: Conversation = root) => conversation.submit({ type: "input", content }, context);
  let serial = 0;
  const start = async (names = ["A"], notify?: boolean): Promise<Admission> => {
    const content = `START-${++serial}`;
    actions.set(content, () => call("delegate", { tasks: names.map((name) => ({ name, task: `Complete ${name}.` })), ...(notify === undefined ? {} : { notify }) }));
    const input = await submit(content); assert.equal((await input.wait(context)).status, "done");
    const result = toolResults(await root.context(context)).filter((message) => message.toolName === "delegate").at(-1)!;
    assert(!result.isError); return result.details as Admission;
  };
  const delivered = async (admission: Admission) => {
    assert(admission.completionTaskId); await harness.waitForTask(admission.completionTaskId, context); await root.waitForIdle(context);
    return harness.commit((tx) => tx.submissionByRequest(root.id, `subagent-completion:${admission.jobId}`), context);
  };
  return { directory, storage, harness, root, registry, models, faux, actions, rootRequests, submit, start, delivered,
    close: async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); } };
}

test("default completion wakes an idle coordinator once, retrieves full saved reports, and labels a host event rather than user text", { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = false;
  const report = "PRIVATE-WORKER-REPORT " + "🙂 evidence ".repeat(1000);
  const f = await fixture({ worker: async (_transcript, options) => { started = true; await gate(held.promise, options?.signal); return fauxAssistantMessage(report); } });
  try {
    const admission = await f.start(); await until(() => started);
    assert(admission.completionTaskId); assert.equal(f.faux.state.callCount, 3);
    const callback = await f.harness.getTask(admission.completionTaskId, context);
    assert(callback?.background); assert.equal(callback.owner, undefined); assert.equal(callback.conversationId, f.root.id);
    assert.equal(callback.state.status, "waiting");
    assert.equal(resultView((await readJob(f.harness, f.root.id, admission.jobId, context)).job, []).status, "running");
    held.resolve(); const receipt = await f.delivered(admission); assert.equal(receipt?.status, "done");
    assert.equal(f.faux.state.callCount, 5); assert.equal((await f.harness.inspect(context)).tasks.length, 0);
    const parent = await f.root.context(context), entries = parent.entries.filter((entry) => entry.kind === COMPLETION_ENTRY);
    assert.equal(entries.length, 1); assert.deepEqual(entries[0].data, { jobId: admission.jobId, status: "completed" });
    assert(!JSON.stringify(entries[0]).includes("PRIVATE-WORKER-REPORT"));
    const firstEventRequest = f.rootRequests.find((request) => completionJob(request) === admission.jobId)!;
    assert(!JSON.stringify(firstEventRequest).includes("PRIVATE-WORKER-REPORT"), "The host notice is a status/reference, not a report injection.");
    const result = toolResults(parent).find((message) => message.toolName === "agent_results")!;
    assert(JSON.stringify(result.content).includes(report));
    const view = await f.root.viewState(context), transcript = new Transcript(); transcript.view = view.value; view.dispose();
    const display = transcript.render(120).map(stripTerminalSequences).join("\n");
    assert.match(display, /◇ Subagent completion/); assert.equal((display.match(/❯ You/g) ?? []).length, 1);
    const nativeTasks = await f.storage.scanTasks({ kind: COMPLETION_KIND }, 10, undefined, context); assert.equal(nativeTasks.items.length, 1);
    const saved = await readJob(f.harness, f.root.id, admission.jobId, context), child = await f.harness.conversation(saved.workers[0].state.status === "terminal" ? saved.workers[0].state.outcome.result!.conversationId! : ROOT_CONVERSATION_ID, context);
    assert(child); assert.equal((await child.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 0);
    assert((await child.agent(context)).tools.every((tool) => !["delegate", "agent_results", "agent_stop", "agent_message"].includes(tool.name)));
  } finally { held.resolve(); await f.close(); }
});

test("a busy coordinator receives a native follow-up only after its final boundary", { timeout: 10000 }, async () => {
  const worker = Promise.withResolvers<void>(), busy = Promise.withResolvers<void>(); let rootStarted = false;
  const f = await fixture({ worker: async (_transcript, options) => { await gate(worker.promise, options?.signal); return fauxAssistantMessage("BUSY-WORKER-REPORT"); } });
  try {
    const admission = await f.start();
    f.actions.set("HOLD-ROOT", async (_transcript, options) => { rootStarted = true; await gate(busy.promise, options?.signal); return fauxAssistantMessage("CURRENT-TURN-FINAL"); });
    const current = await f.submit("HOLD-ROOT"); await until(() => rootStarted);
    worker.resolve(); await f.harness.waitForTask(admission.completionTaskId!, context);
    const receipt = await f.harness.commit((tx) => tx.submissionByRequest(f.root.id, `subagent-completion:${admission.jobId}`), context);
    assert.equal(receipt?.status, "queued");
    assert.equal((await f.harness.snapshot(InboxDoc, f.root.id, context))?.items[0].mode, "followUp");
    assert(!f.rootRequests.some((request) => completionJob(request) !== undefined));
    const settled = await f.harness.getTask(admission.jobId, context); assert.equal(settled?.state.status, "terminal");
    busy.resolve(); assert.equal((await current.wait(context)).status, "done"); await f.delivered(admission);
    const entries = (await f.root.context(context)).entries;
    assert(entries.findIndex((entry) => entry.kind === COMPLETION_ENTRY) > entries.findIndex((entry) => JSON.stringify(entry.model).includes("CURRENT-TURN-FINAL")));
  } finally { worker.resolve(); busy.resolve(); await f.close(); }
});

test("completion survives an ordinary coordinator abort while its background job is running", { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>();
  const f = await fixture({ worker: async (_transcript, options) => { await gate(held.promise, options?.signal); return fauxAssistantMessage("SURVIVED-INTERRUPT"); } });
  try {
    const admission = await f.start(); await f.root.abort(context);
    assert.equal((await f.harness.getTask(admission.jobId, context))?.abortRequested, false);
    assert.equal((await f.harness.getTask(admission.completionTaskId!, context))?.abortRequested, false);
    held.resolve(); assert.equal((await f.delivered(admission))?.status, "done");
    assert.match(JSON.stringify((await f.root.context(context)).messages), /SURVIVED-INTERRUPT/);
  } finally { held.resolve(); await f.close(); }
});

for (const scenario of ["partial", "failed", "native fault", "abort fault", "aborted", "model stop"] as const) test(`one settled callback reports ${scenario} without leaking raw failures`, { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = false;
  const f = await fixture({ faultedJob: scenario === "native fault", faultedAbort: scenario === "abort fault", worker: async (transcript, options) => {
    started = true;
    if (["aborted", "model stop", "abort fault"].includes(scenario)) await gate(held.promise, options?.signal);
    return scenario === "partial" && workerName(transcript) === "B" ? fauxAssistantMessage("SUCCESS-B") : fauxAssistantMessage("", { stopReason: "error", errorMessage: "PRIVATE-WORKER-ERROR" });
  } });
  try {
    const admission = await f.start(scenario === "partial" ? ["A", "B"] : ["A"]);
    if (["aborted", "model stop", "abort fault"].includes(scenario)) {
      await until(() => started);
      if (scenario !== "model stop") await f.harness.abortTask(admission.jobId, context);
      else { f.actions.set("STOP", () => call("agent_stop", { jobId: admission.jobId })); await (await f.submit("STOP")).wait(context); }
    }
    await f.delivered(admission);
    const expected = scenario === "native fault" || scenario === "abort fault" ? "failed" : scenario === "model stop" ? "aborted" : scenario;
    const events = (await f.root.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY);
    assert.equal(events.length, 1); assert.equal((events[0].data as { status: string }).status, expected);
    assert(!JSON.stringify(events).includes("PRIVATE-")); assert.deepEqual((await f.harness.snapshot(Jobs, f.root.id, context))?.active, []);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { held.resolve(); await f.close(); }
});

test("no callback precedes cooperative cleanup, even after a worker's final report was saved", { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(), cleanup = Promise.withResolvers<void>(); let started = false, cleaning = false;
  const f = await fixture({ worker: async (_transcript, options) => { started = true; await gate(held.promise, options?.signal); return fauxAssistantMessage("FINAL-BEFORE-CLEANUP"); } });
  const background = defineTask<{}, { phase: "hold" }, {}>({ name: "fixture.completion-drain", version: 1, initial: () => ({ phase: "hold" }),
    phases: { hold: async (_task, runtime, taskContext) => { await runtime.sleep(runtime.now() + 3600000, taskContext); await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), taskContext); } },
    abort: async (_task, runtime, taskContext) => { cleaning = true; await gate(cleanup.promise, taskContext.abortSignal); await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext); },
  }); f.registry.install(defineExtension({ name: "completion-drain", tasks: [background] }));
  try {
    const admission = await f.start(); await until(() => started);
    const saved = await readJob(f.harness, f.root.id, admission.jobId, context), state = saved.workers[0].state;
    assert(state.status !== "terminal" && state.status !== "completing" && state.checkpoint.phase === "run");
    const conversationId = state.checkpoint.conversationId;
    await f.harness.commit((tx) => tx.createTask(background, {}, { ownership: { kind: "conversation" }, conversationId, background: true }), context);
    held.resolve(); await until(() => cleaning);
    assert.equal((await f.harness.getTask(admission.completionTaskId!, context))?.state.status, "waiting");
    assert(!f.rootRequests.some((request) => completionJob(request) !== undefined));
    cleanup.resolve(); assert.equal((await f.delivered(admission))?.status, "done");
  } finally { held.resolve(); cleanup.resolve(); await f.close(); }
});

test("35 overlapping jobs retain one durable callback each, including jobs outside the recent-reference window", { timeout: 20000 }, async () => {
  const held = Promise.withResolvers<void>();
  const f = await fixture({ worker: async (transcript, options) => { await gate(held.promise, options?.signal); return fauxAssistantMessage(`REPORT-${workerName(transcript)}`); } });
  try {
    const admissions: Admission[] = []; for (let index = 0; index < 35; index++) admissions.push(await f.start([`Worker-${index}`]));
    assert.equal((await f.harness.snapshot(Jobs, f.root.id, context))?.active.length, 35);
    assert.equal((await f.harness.snapshot(Jobs, f.root.id, context))?.recent.length, 30);
    held.resolve(); await Promise.all(admissions.map((admission) => f.delivered(admission))); await f.root.waitForIdle(context);
    const entries = (await f.root.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY);
    assert.equal(entries.length, 35); assert.equal(new Set(entries.map((entry) => (entry.data as { jobId: number }).jobId)).size, 35);
    const results = toolResults(await f.root.context(context)).filter((message) => message.toolName === "agent_results");
    assert.equal(new Set(results.map(resultJob)).size, 35);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { held.resolve(); await f.close(); }
});

test("notify:false is deliberately silent and does not create a completion task or coordinator request", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const admission = await f.start(["Silent"], false); assert.equal(admission.completionTaskId, undefined);
    await f.harness.waitForTask(admission.jobId, context); await f.root.waitForIdle(context);
    assert.equal(f.faux.state.callCount, 3); assert.equal((await f.storage.scanTasks({ kind: COMPLETION_KIND }, 10, undefined, context)).items.length, 0);
    assert.equal((await f.root.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 0);
  } finally { await f.close(); }
});

test("an unanswered completion input is not silently resubmitted or retried", { timeout: 10000 }, async () => {
  const f = await fixture({ callbackFailure: true });
  try {
    const admission = await f.start(); const receipt = await f.delivered(admission); assert.equal(receipt?.status, "unanswered");
    assert.equal(f.faux.state.callCount, 4);
    const replay = await f.root.submit({ type: "input", content: "Ignored replay body.", requestId: `subagent-completion:${admission.jobId}`, whenBusy: "followUp" }, context);
    assert.equal(replay.id, receipt.id); assert.equal((await replay.status(context)).status, "unanswered");
    await f.root.waitForIdle(context); assert.equal(f.faux.state.callCount, 4);
    assert.equal((await f.root.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 1);
  } finally { await f.close(); }
});

test("an emergency background abort suppresses an unadmitted callback without restarting workers", { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = false;
  const f = await fixture({ worker: async (_transcript, options) => { started = true; await gate(held.promise, options?.signal); return fauxAssistantMessage("Too late."); } });
  try {
    const admission = await f.start(); await until(() => started);
    await f.root.abort(context, { background: true }); await f.harness.waitForTask(admission.completionTaskId!, context); await f.harness.waitForTask(admission.jobId, context);
    assert.equal((await f.harness.getTask(admission.completionTaskId!, context))?.state.status, "terminal");
    assert.equal(await f.harness.commit((tx) => tx.submissionByRequest(f.root.id, `subagent-completion:${admission.jobId}`), context), undefined);
    assert(!f.rootRequests.some((request) => completionJob(request) !== undefined));
  } finally { held.resolve(); await f.close(); }
});

test("callback ownership guards reject foreign conversations, worker parents and foreground jobs without admitting input", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const admission = await f.start(["Guarded"], false); await f.harness.waitForTask(admission.jobId, context);
    const saved = await readJob(f.harness, f.root.id, admission.jobId, context), report = resultView(saved.job, saved.workers).workers[0];
    const foreign = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context), child = await f.harness.conversation(report.conversationId!, context); assert(child);
    const calls = f.faux.state.callCount;
    const foreignCallback = await f.harness.commit((tx) => tx.createTask(SubagentCompletion, { jobId: admission.jobId }, { conversationId: foreign.id, ownership: { kind: "conversation" }, background: true }), context);
    const input = { ...saved.job.input, tasks: [] };
    const workerJob = await f.harness.commit((tx) => tx.createTask(SubagentJob, input, { conversationId: child.id, ownership: { kind: "conversation" }, background: true }), context);
    const workerCallback = await f.harness.commit((tx) => tx.createTask(SubagentCompletion, { jobId: workerJob }, { conversationId: child.id, ownership: { kind: "conversation" }, background: true }), context);
    const foreground = await f.harness.commit((tx) => tx.createTask(SubagentJob, input, { conversationId: f.root.id, ownership: { kind: "conversation" } }), context);
    const foregroundCallback = await f.harness.commit((tx) => tx.createTask(SubagentCompletion, { jobId: foreground }, { conversationId: f.root.id, ownership: { kind: "conversation" }, background: true }), context);
    for (const id of [foreignCallback, workerCallback, foregroundCallback]) assert.equal((await f.harness.waitForTask(id, context)).state.outcome.status, "faulted");
    assert.equal(f.faux.state.callCount, calls);
    for (const conversation of [f.root, foreign, child]) assert.equal((await conversation.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 0);
  } finally { await f.close(); }
});

test("a native follow-up queued behind a failed parent remains queued until another ordinary turn reaches its final boundary", { timeout: 10000 }, async () => {
  const worker = Promise.withResolvers<void>(), busy = Promise.withResolvers<void>(); let parentStarted = false;
  const f = await fixture({ worker: async (_transcript, options) => { await gate(worker.promise, options?.signal); return fauxAssistantMessage("QUEUED-REPORT"); } });
  try {
    const admission = await f.start();
    f.actions.set("FAIL-PARENT", async (_transcript, options) => { parentStarted = true; await gate(busy.promise, options?.signal); return fauxAssistantMessage("", { stopReason: "error", errorMessage: "PRIVATE-PARENT-ERROR" }); });
    const parent = await f.submit("FAIL-PARENT"); await until(() => parentStarted); worker.resolve(); await f.harness.waitForTask(admission.completionTaskId!, context);
    busy.resolve(); assert.equal((await parent.wait(context)).status, "unanswered"); await f.root.waitForIdle(context);
    const receipt = await f.harness.commit((tx) => tx.submissionByRequest(f.root.id, `subagent-completion:${admission.jobId}`), context); assert.equal(receipt?.status, "queued");
    assert.equal((await f.root.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 0);
    const next = await f.submit("Ordinary next turn"); await next.wait(context); await f.root.waitForIdle(context);
    const delivered = await f.delivered(admission); assert.equal(delivered?.id, receipt.id); assert.equal(delivered.status, "done");
    assert.equal((await f.root.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 1);
  } finally { worker.resolve(); busy.resolve(); await f.close(); }
});
