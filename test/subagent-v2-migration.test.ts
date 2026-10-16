import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSubagentsExtension } from "../src/subagents/index.ts";
import { Call, EXTENSION, JOB_KIND, WORKER_KIND, Jobs, Worker, type JobCheckpoint, type JobInput, type JobResult, type WorkerInput, type WorkerResult } from "../src/subagents/state.ts";
import { workerTools } from "../src/subagents/tools.ts";
import { readJob, resultView } from "../src/subagents/view.ts";
import { gate, until, workerName, toolResults } from "./subagent-fixtures.ts";
import { model, testModels } from "./models.ts";

// Genuine stock-native v2 records: unlimited background work, explicit baseline tools, no capability selections.
const OldWorker = defineDoc<{ owner?: { jobId: number; taskId: number; index: number; root: string } }>({ kind: "pi-d.subagent", version: 2,
  scope: "conversation", history: "latest", fork: "initial", initial: () => ({}) });
const oldWorker = defineTask<WorkerInput, { phase: "prepare" } | { phase: "run"; conversationId: ConversationId }, WorkerResult>({
  name: WORKER_KIND, version: 2, initial: () => ({ phase: "prepare" }), phases: {
    prepare: async (task, runtime, ctx) => { await runtime.commit(async (tx) => {
      const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
      await configure(tx, child.id, { model: task.input.profile.model, thinkingLevel: task.input.profile.thinkingLevel, cwd: task.input.profile.cwd,
        extensions: [runtime.registry.extension(EXTENSION)!], tools: workerTools, modelTools: workerTools, instructions: "Old normal coding profile." });
      (await tx.doc(OldWorker, child.id)).owner = { jobId: task.input.jobId, taskId: task.id, index: task.input.index, root: task.input.profile.cwd };
      return { status: "running", checkpoint: { phase: "run", conversationId: child.id } };
    }, ctx); },
    run: async (task, runtime, ctx) => {
      const child = await runtime.conversation(task.state.checkpoint.conversationId, ctx); assert(child);
      const request = await child.submit({ type: "input", content: "Assignment: V2 worker\nContinue the saved assignment.", requestId: `subagent:${task.id}` }, ctx);
      await request.wait(ctx); throw new Error("The v2 fixture must close while the worker is running.");
    },
  }, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
});
const oldJob = defineTask<JobInput, JobCheckpoint, JobResult>({ name: JOB_KIND, version: 2,
  initial: () => ({ phase: "dispatch", next: 0, workers: [], wave: [], results: [] }), phases: {
    dispatch: async (task, runtime, ctx) => { await runtime.commit(async (tx) => {
      const worker = await tx.createTask(oldWorker, { jobId: task.id, index: 0, assignment: task.input.tasks[0], context: "", profile: task.input.profile }, { ownership: { kind: "task", taskId: task.id } });
      return { status: "running", checkpoint: { phase: "collect", next: 1, workers: [worker], wave: [worker], results: [] } };
    }, ctx); },
    collect: async (task, runtime, ctx) => { await runtime.waitForTask(task.state.checkpoint.workers[0], ctx); throw new Error("Close before the v2 job settles."); },
    finish: async () => { throw new Error("Unreachable fixture phase."); },
  }, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
});
const oldDelegate = defineTool({ name: "delegate", replay: "safe", parameters: Type.Object({}), description: "Original v2 fixture", async execute(_args, api, ctx) {
  const agent = await api.agent(ctx);
  const jobId = await api.commit(async (tx) => {
    const call = await tx.doc(Call, api.taskId), jobs = await tx.doc(Jobs, api.conversationId);
    if (call.jobId) return call.jobId;
    const created = await tx.createTask(oldJob, { tasks: [{ name: "V2 worker", role: "worker", task: "Continue saved work." }], context: "",
      profile: { model: agent.model!, thinkingLevel: agent.thinkingLevel, cwd: api.env!.cwd, instructions: "" } },
      { conversationId: api.conversationId, ownership: { kind: "conversation" }, background: true });
    call.jobId = created; jobs.active.push(created); jobs.recent.push(created); return created;
  }, ctx);
  return { output: [{ type: "text", text: `Background job ${jobId}.` }] };
} });

test("v2 background jobs migrate without inheriting newly available extensions or duplicating their existing child/request", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-v2-assignment-"))), path = join(directory, "session.sqlite"), hold = Promise.withResolvers<void>(); let reached = false;
  const first = testModels({ responses: Array.from({ length: 10 }, () => async (transcript, options) => {
    if (workerName(transcript)) { reached = true; await gate(hold.promise, options?.signal); return fauxAssistantMessage("Late old worker."); }
    return toolResults(transcript).length ? fauxAssistantMessage("Background admitted.") : fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" });
  }) });
  const registry = createRegistry(); registry.install(defineExtension({ name: EXTENSION, tools: [...workerTools, oldDelegate], tasks: [oldJob, oldWorker] }));
  const env = ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? directory });
  const settings = { compaction: { enabled: false }, retry: { enabled: false } };
  let harness = await Harness.open(await openNodeSqliteStorage(path), { registry, models: first.models, env, settings }, context);
  try {
    let root = await harness.root(context, { agent: { model, cwd: directory } });
    const input = await root.submit({ type: "input", content: "Start v2 background work." }, context); assert.equal((await input.wait(context)).status, "done"); await until(() => reached);
    const jobId = (await harness.snapshot(Jobs, root.id, context))!.recent[0]; await harness.close(context);
    const modern = createRegistry(); modern.install(createSubagentsExtension());
    modern.install(defineExtension({ name: "new-unassigned-extension", tools: [defineTool({ name: "parent_only_v2", description: "Must not reach old workers", parameters: Type.Object({}), async execute() { assert.fail("Unassigned tool ran."); } })] }));
    const second = testModels({ responses: Array.from({ length: 10 }, () => (transcript) => toolResults(transcript).length ? fauxAssistantMessage("Recovered v2 report.")
      : fauxAssistantMessage(fauxToolCall("write", { path: "v2-recovered.txt", content: "Normal tools retained." }), { stopReason: "toolUse" })) });
    const storage = await openNodeSqliteStorage(path); harness = await Harness.open(storage, { registry: modern, models: second.models, env, settings }, context); root = await harness.root(context);
    await harness.waitForTask(jobId, context); const saved = await readJob(harness, root.id, jobId, context), view = resultView(saved.job, saved.workers);
    assert.equal(view.status, "completed"); assert.equal(saved.job.version, 3); assert.equal(saved.workers[0].version, 3); assert.equal(view.workers[0].report, "Recovered v2 report.");
    assert.equal(saved.workers[0].input.legacy, undefined); assert.equal(saved.job.input.tasks[0].capabilities, undefined);
    const child = await harness.conversation(view.workers[0].conversationId!, context); assert(child);
    assert.deepEqual((await child.agent(context)).tools.map((tool) => tool.name).sort(), ["bash", "edit", "read", "write"]);
    const metadata = (await harness.snapshot(Worker, child.id, context))!; assert(metadata.owner); assert.deepEqual(metadata.capabilities!.skills, []); assert.deepEqual(metadata.capabilities!.extensions, []);
    assert.equal((await storage.scanSubmissions({ conversationId: child.id }, 10, undefined, context)).items.length, 1);
    assert.equal((await storage.scanTasks({ kind: JOB_KIND }, 10, undefined, context)).items.length, 1); assert.equal((await storage.scanTasks({ kind: WORKER_KIND }, 10, undefined, context)).items.length, 1);
    assert.equal(await readFile(join(directory, "v2-recovered.txt"), "utf8"), "Normal tools retained."); assert.deepEqual((await harness.snapshot(Jobs, root.id, context))!.active, []);
  } finally { hold.resolve(); await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});
