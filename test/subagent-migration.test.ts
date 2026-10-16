import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSubagentsExtension } from "../src/subagents/index.ts";
import { Call, EXTENSION, JOB_KIND, WORKER_KIND, Jobs, Worker, type JobCheckpoint, type JobInput, type JobResult, type WorkerInput, type WorkerResult } from "../src/subagents/state.ts";
import { readJob, resultView } from "../src/subagents/view.ts";
import { gate, until, workerName, toolResults } from "./subagent-fixtures.ts";
import { model, testModels } from "./models.ts";

// Build genuine v1 native records with the original persisted shapes/ownership. This is a fixture, not an alternate runtime.
const oldPolicy = { concurrency: 2, maxTasks: 8, timeoutMs: 10, maxToolCalls: 1, maxReportBytes: 256 };
const OldJobs = defineDoc<{ recent: TaskId<JobResult>[]; active?: TaskId<JobResult> }>({ kind: "pi-d.subagents", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ recent: [] }) });
const OldWorker = defineDoc<{ owner?: { jobId: TaskId; taskId: TaskId; index: number; root: string; maxToolCalls: number }; calls: TaskId[]; limitReached: boolean }>({
  kind: "pi-d.subagent", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ calls: [], limitReached: false }),
});
const oldRead = { ...createReadTool(), name: "agent_read", replay: "safe" as const, deferred: true as const };
type OldCheckpoint = { phase: "prepare" } | { phase: "run"; conversationId: ConversationId; deadline: number };
const oldWorker = defineTask<WorkerInput & { policy: typeof oldPolicy }, OldCheckpoint, WorkerResult>({ name: WORKER_KIND, version: 1, initial: () => ({ phase: "prepare" }), phases: {
  prepare: async (task, runtime, ctx) => { await runtime.commit(async (tx) => {
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
    await configure(tx, child.id, { model: task.input.profile.model, cwd: task.input.profile.cwd, extensions: [runtime.registry.extension(EXTENSION)!],
      tools: [oldRead], modelTools: [oldRead], instructions: "Old read-only worker profile." });
    const state = await tx.doc(OldWorker, child.id); state.owner = { jobId: task.input.jobId, taskId: task.id, index: task.input.index, root: task.input.profile.cwd, maxToolCalls: 1 };
    // Obsolete fields must not constrain recovery, even if a previous budget signal was saved.
    state.calls = [task.id]; state.limitReached = true;
    return { status: "running", checkpoint: { phase: "run", conversationId: child.id, deadline: 110 } };
  }, ctx); },
  run: async (task, runtime, ctx) => { const child = await runtime.conversation(task.state.checkpoint.conversationId, ctx); assert(child);
    const input = await child.submit({ type: "input", content: `Assignment: ${task.input.assignment.name}\nResume the assignment.`, requestId: `subagent:${task.id}` }, ctx);
    await input.wait(ctx); throw new Error("Fixture is closed before the original worker settles."); },
}, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });
const oldJob = defineTask<JobInput & { policy: typeof oldPolicy }, JobCheckpoint, JobResult>({ name: JOB_KIND, version: 1,
  initial: () => ({ phase: "dispatch", next: 0, workers: [], wave: [], results: [] }), phases: {
    dispatch: async (task, runtime, ctx) => { await runtime.commit(async (tx) => {
      const wave = [];
      for (let index = 0; index < 2; index++) wave.push(await tx.createTask(oldWorker, { jobId: task.id, index, assignment: task.input.tasks[index], context: "", profile: task.input.profile, policy: oldPolicy }, { ownership: { kind: "task", taskId: task.id } }));
      return { status: "waiting", on: wave, policy: "allSettled", checkpoint: { phase: "collect", next: 2, workers: wave, wave, results: [] } };
    }, ctx); },
    collect: async () => { throw new Error("Fixture wave must still be waiting when the old Harness closes."); },
    finish: async () => { throw new Error("Unreachable fixture phase."); },
  }, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
});
function legacyExtension(background: boolean) {
  const delegate = defineTool({ name: "delegate", description: "Legacy delegation fixture.", replay: "safe", parameters: Type.Object({}), async execute(_args, api, ctx) {
    const agent = await api.agent(ctx);
    const jobId = await api.commit(async (tx) => { const call = await tx.doc(Call, api.taskId), jobs = await tx.doc(OldJobs, api.conversationId);
      if (call.jobId) return call.jobId;
      const created = await tx.createTask(oldJob, { tasks: ["A", "B", "C"].map((name) => ({ name, role: "researcher", task: "Resume this task." })), context: "",
        profile: { model: agent.model!, thinkingLevel: agent.thinkingLevel, cwd: api.env!.cwd, instructions: "" }, policy: oldPolicy }, background
        ? { conversationId: api.conversationId, ownership: { kind: "conversation" }, background: true } : { ownership: { kind: "task", taskId: api.taskId } });
      call.jobId = created; jobs.active = created; jobs.recent.push(created); return created;
    }, ctx);
    if (!background) await api.waitForTask(jobId, ctx);
    return { output: [{ type: "text", text: `Old job ${jobId}.` }] };
  } });
  return defineExtension({ name: EXTENSION, tools: [delegate, oldRead], tasks: [oldJob, oldWorker] });
}

for (const mode of ["complete", "model stop", "legacy foreground stop"] as const) test(`v1 SQLite migration: ${mode}, without deadlines/budgets or duplicate admission`, { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-agent-v1-"))), file = join(directory, "session.sqlite"), hold = Promise.withResolvers<void>();
  await writeFile(join(directory, "README.md"), "Legacy read fixture."); let reached = 0;
  const first = testModels({ responses: Array.from({ length: 20 }, () => async (transcript, options) => {
    if (workerName(transcript)) { reached++; await gate(hold.promise, options?.signal); return fauxAssistantMessage("Late original report."); }
    return transcript.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("Acknowledged.") : fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" });
  }) });
  const registry = createRegistry(); registry.install(legacyExtension(mode !== "legacy foreground stop"));
  const options = { registry, models: first.models, now: () => 100, env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? directory }), settings: { retry: { enabled: false }, compaction: { enabled: false } } };
  let harness = await Harness.open(await openNodeSqliteStorage(file), options, context);
  try {
    let root = await harness.root(context, { agent: { model, cwd: directory } });
    const original = await root.submit({ type: "input", content: "Create old work.", requestId: "old-root" }, context), originalWait = original.wait(context).catch(() => undefined);
    await until(() => reached === 2); const jobId = (await harness.snapshot(OldJobs, root.id, context))!.recent[0];
    if (mode !== "legacy foreground stop") await originalWait;
    const before = await harness.getTask(jobId, context); assert.equal(before?.state.status, "waiting");
    await harness.close(context); await originalWait;
    const modern = createRegistry(); modern.install(createSubagentsExtension()); let resumed = 0;
    const full = "Recovered full report ".repeat(100);
    const second = testModels({ responses: Array.from({ length: 40 }, () => async (transcript, requestOptions) => {
      if (workerName(transcript)) {
        resumed++;
        if (mode !== "complete") { await gate(hold.promise, requestOptions?.signal); return fauxAssistantMessage("Late."); }
        const count = toolResults(transcript).length;
        if (count < 3) {
          const tool = workerName(transcript) === "C" ? "read" : ["agent_read", "agent_list", "agent_search"][count];
          const call = tool === "agent_search" ? fauxToolCall(tool, { query: "Legacy read", path: "README.md", caseSensitive: true }) : fauxToolCall(tool, { path: tool === "agent_list" ? "." : "README.md" });
          return fauxAssistantMessage(call, { stopReason: "toolUse" });
        }
        assert(toolResults(transcript).every((result) => !result.isError));
        return fauxAssistantMessage(full);
      }
      return transcript.messages.filter((message) => message.role !== "system").at(-1)?.role === "toolResult" ? fauxAssistantMessage("Control retained.") : fauxAssistantMessage(fauxToolCall("agent_stop", {}), { stopReason: "toolUse" });
    }) });
    const storage = await openNodeSqliteStorage(file);
    harness = await Harness.open(storage, { ...options, registry: modern, models: second.models, now: () => 1e12 }, context); root = await harness.root(context);
    if (mode === "model stop") { const stop = await root.submit({ type: "input", content: "Stop old work." }, context); assert.equal((await stop.wait(context)).status, "done"); }
    if (mode === "legacy foreground stop") {
      // Immutable native ownership is preserved, not silently detached or aborted by returning the replayed delegate early.
      harness.resume(); await until(() => resumed >= 2); assert.equal((await harness.getTask(jobId, context))?.owner, before?.owner);
      assert.notEqual((await harness.getTask(jobId, context))?.state.status, "terminal"); await harness.abortTask(jobId, context);
      assert.equal((await (await harness.submission(original.id, context))!.wait(context)).status, "done");
    }
    await harness.waitForTask(jobId, context); const saved = await readJob(harness, root.id, jobId, context), view = resultView(saved.job, saved.workers);
    assert.equal(view.status, mode === "complete" ? "completed" : "aborted"); assert.equal(saved.job.version, 3);
    assert.equal((await storage.scanTasks({ kind: JOB_KIND }, 10, undefined, context)).items.length, 1);
    assert.equal((await storage.scanTasks({ kind: WORKER_KIND }, 10, undefined, context)).items.length, mode === "complete" ? 3 : 2);
    assert.deepEqual((await harness.snapshot(Jobs, root.id, context))?.active, []);
    if (mode === "complete") for (const result of view.workers) {
      assert.equal(result.report, full); const meta = await harness.snapshot(Worker, result.conversationId!, context); assert(meta?.owner); assert(!("maxToolCalls" in meta.owner));
      const requests = await storage.scanSubmissions({ conversationId: result.conversationId }, 10, undefined, context); assert.equal(requests.items.length, 1);
    }
    assert.equal((await harness.inspect(context)).tasks.length, 0);
  } finally { hold.resolve(); await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});
