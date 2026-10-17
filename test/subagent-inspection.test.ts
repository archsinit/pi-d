import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineTask, Harness, MemoryStorage, type Storage, type TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSubagentsExtension, listSubagentJobs, inspectSubagentJob, readSubagentReportPage, requestSubagentStop,
  admitSubagentMessage, type SubagentAccess } from "../src/subagents/index.ts";
import { Control, Jobs, JOB_KIND, WORKER_KIND, type JobInput, type JobCheckpoint, type JobResult } from "../src/subagents/state.ts";
import { SubagentJob, SubagentWorker } from "../src/subagents/tasks.ts";
import { readJob, resultView } from "../src/subagents/view.ts";
import { gate, until, workerName, toolResults } from "./subagent-fixtures.ts";
import { model, testModels } from "./models.ts";

async function fixture(worker: FauxResponseFactory, options: { faultFirst?: boolean; faultCollect?: boolean; sqlite?: boolean; cleanup?: Promise<void> } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-inspection-")));
  let requested = { name: "delegate", args: {} as { [key: string]: JsonValue } };
  const { models, faux } = testModels({ responses: Array.from({ length: 200 }, () => (transcript, ...rest) => workerName(transcript)
    ? worker(transcript, ...rest) : transcript.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("Control retained.")
      : fauxAssistantMessage(fauxToolCall(requested.name, requested.args), { stopReason: "toolUse" })) });
  const registry = createRegistry(), extension = createSubagentsExtension();
  const blocker = defineTask<{}, { phase: "wait" }, null>({ name: "inspection-cleanup", version: 1, initial: () => ({ phase: "wait" }),
    phases: { wait: async (_task, runtime, ctx) => { await gate(options.cleanup!, ctx.abortSignal); await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx); } },
    abort: async (_task, runtime, ctx) => { await options.cleanup; await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: null } }), ctx); },
  });
  registry.install({ ...extension, tasks: [...extension.tasks!.map((task) => {
    if (task.definition.name === WORKER_KIND && options.faultFirst) return defineTask({ ...SubagentWorker.definition,
      phases: { ...SubagentWorker.definition.phases, run: async (task, runtime, ctx) => {
        if (task.input.index === 0) throw new Error("PRIVATE-WORKER-FAULT");
        await SubagentWorker.definition.phases.run(task, runtime, ctx);
      } } });
    if (task.definition.name === JOB_KIND && (options.faultCollect || options.cleanup)) return defineTask<JobInput, JobCheckpoint, JobResult>({ ...SubagentJob.definition,
      phases: { ...SubagentJob.definition.phases,
        ...(options.faultCollect ? { collect: async (task, runtime, ctx) => { await runtime.waitForTask(task.state.checkpoint.workers[0], ctx); throw new Error("PRIVATE-COLLECT-FAULT"); } } : {}),
        ...(options.cleanup ? { finish: async (task, runtime, ctx) => {
          await runtime.commit(async (tx) => { await tx.createTask(blocker, {}, { conversationId: task.conversationId, ownership: { kind: "task", taskId: task.id }, background: false }); }, ctx);
          await SubagentJob.definition.phases.finish(task, runtime, ctx);
        } } : {}),
      } });
    return task;
  }), ...(options.cleanup ? [blocker] : [])] });
  const path = join(directory, "session.sqlite"), storage = options.sqlite ? await openNodeSqliteStorage(path) : new MemoryStorage();
  const open = (storage: Storage) => Harness.open(storage, { models, registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }),
    settings: { retry: { enabled: false }, compaction: { enabled: false } }, onReport: () => {},
  }, context);
  const harness = await open(storage);
  const root = await harness.root(context, { agent: { model, cwd: directory } });
  const invoke = async (name: string, args: { [key: string]: JsonValue }) => {
    requested = { name, args };
    const input = await root.submit({ type: "input", content: `Invoke ${name}.` }, context);
    assert.equal((await input.wait(context)).status, "done");
    const result = toolResults(await root.context(context)).at(-1)!;
    assert.equal(result.toolName, name); return result;
  };
  const start = async (names = ["A", "B"]) => {
    assert(!(await invoke("delegate", { notify: false, tasks: names.map((name) => ({ name, task: `Investigate ${name}.` })) })).isError);
    return (await harness.snapshot(Jobs, root.id, context))!.recent.at(-1)!;
  };
  return { directory, path, open, harness, storage, root, faux, invoke, start, extension,
    close: async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); } };
}
const text = (result: ReturnType<typeof toolResults>[number]) => result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");

test("stop/results reject malformed targets before coercion without changing worker control", { timeout: 15000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = 0;
  const f = await fixture(async (_transcript, options) => { started++; await gate(held.promise, options?.signal); return fauxAssistantMessage("Done."); });
  try {
    const jobId = await f.start(); await until(() => started === 2);
    const before = await f.harness.snapshot(Control, jobId, context);
    const bad: { [key: string]: JsonValue }[] = [
      { jobId, worker: 1.5 }, { jobId, worker: "1" }, { jobId, worker: true }, { jobId, worker: null },
      { jobId, worker: 0 }, { jobId, worker: Number.MAX_SAFE_INTEGER + 1 }, { jobId: jobId + 0.5 },
      { jobId: String(jobId) }, { jobId: true }, { jobId: null }, { worker: 1 }, { jobid: jobId }, { jobId, workr: 1 },
    ];
    for (const args of bad) {
      assert((await f.invoke("agent_stop", args)).isError, JSON.stringify(args));
      assert.deepEqual(await f.harness.snapshot(Control, jobId, context), before);
    }
    for (const badId of [jobId + 0.5, String(jobId), true, null]) assert((await f.invoke("agent_results", { jobId: badId })).isError);
    const running = await readJob(f.harness, f.root.id, jobId, context);
    assert(running.workers.every((worker) => worker.state.status !== "terminal" && !worker.abortRequested));
  } finally { held.resolve(); await f.close(); }
});

test("ready sibling reports are model-readable before the whole job settles", { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = 0;
  const f = await fixture(async (transcript, options) => {
    started++;
    if (workerName(transcript) === "B") await gate(held.promise, options?.signal);
    return fauxAssistantMessage(`READY-${workerName(transcript)}`);
  });
  try {
    const jobId = await f.start(); await until(() => started === 2);
    const saved = await readJob(f.harness, f.root.id, jobId, context);
    await f.harness.waitForTask(saved.workers.find((worker) => worker.input.index === 0)!.id, context);
    const result = await f.invoke("agent_results", { jobId });
    assert(!result.isError); assert.match(text(result), /READY-A/); assert.match(text(result), /running/);
    assert.equal((await f.harness.getTask(jobId, context))?.state.status, "running");
  } finally { held.resolve(); await f.close(); }
});

test("faulted workers count immediately and expose only a generic failure while siblings run", { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = false;
  const f = await fixture(async (_transcript, options) => { started = true; await gate(held.promise, options?.signal); return fauxAssistantMessage("Done."); }, { faultFirst: true });
  try {
    const jobId = await f.start(); await until(() => started);
    const saved = await readJob(f.harness, f.root.id, jobId, context);
    await f.harness.waitForTask(saved.workers.find((worker) => worker.input.index === 0)!.id, context);
    const snapshot = await readJob(f.harness, f.root.id, jobId, context), view = resultView(snapshot.job, snapshot.workers);
    assert.equal(view.status, "running"); assert.equal(view.workers.length, 1); assert.equal(view.workers[0].status, "failed");
    const result = await f.invoke("agent_results", { jobId });
    assert.match(text(result), /faulted/); assert(!text(result).includes("PRIVATE-WORKER-FAULT"));
    const inspected = await inspectSubagentJob(f.harness, f.root.id, jobId, context);
    assert.equal(inspected.workers[0].nativeOutcome, "faulted"); assert(inspected.workers[0].conversationId, "Recover the faulted worker's child through native ownership.");
    const orphaned = { ...snapshot.workers[0], memos: undefined, state: { status: "terminal" as const, outcome: { status: "orphaned" as const, reason: "PRIVATE-ORPHAN" } } };
    const orphanView = resultView(snapshot.job, [orphaned, snapshot.workers[1]]);
    assert.equal(orphanView.workers[0].status, "failed"); assert.match(orphanView.workers[0].error!, /orphaned/); assert(!JSON.stringify(orphanView).includes("PRIVATE-ORPHAN"));
  } finally { held.resolve(); await f.close(); }
});

test("result projection and public inspection keep held cleanup distinct from terminal settlement", { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>();
  const f = await fixture(() => fauxAssistantMessage("Saved before cleanup."), { cleanup: held.promise });
  try {
    const jobId = await f.start(["A"]);
    await until(async () => (await f.harness.getTask(jobId, context))?.state.status === "completing");
    const { job, workers } = await readJob(f.harness, f.root.id, jobId, context);
    assert.equal(resultView(job, workers).status, "completing");
    const snapshot = await inspectSubagentJob(f.harness, f.root.id, jobId, context);
    assert.equal(snapshot.status, "completing"); assert.equal(snapshot.outcome, "completed"); assert.equal(snapshot.settled, false); assert.equal(snapshot.resultsReady, 1);
    assert.equal((await readSubagentReportPage(f.harness, f.root.id, { jobId, worker: 1 }, context)).text, "Saved before cleanup.");
    assert.match(text(await f.invoke("agent_results", { jobId })), /Cleanup pending/);
    held.resolve(); await f.harness.waitForTask(jobId, context);
    assert.equal((await inspectSubagentJob(f.harness, f.root.id, jobId, context)).settled, true);
  } finally { held.resolve(); await f.close(); }
});

for (const all of [false, true]) test(`public stop cancels completing-job cleanup without joining (${all ? "all, unindexed" : "job"})`, { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>();
  const f = await fixture(() => fauxAssistantMessage("Saved before cancellation."), { cleanup: held.promise });
  try {
    const jobId = await f.start(["A"]);
    await until(async () => (await f.harness.getTask(jobId, context))?.state.status === "completing");
    const cleanup = (await f.harness.commit((tx) => tx.scanTasks({ conversationId: f.root.id, kind: "inspection-cleanup" }, 2), context)).items[0];
    assert(cleanup);
    if (all) await f.harness.commit(async (tx) => { const jobs = await tx.doc(Jobs, f.root.id); jobs.active = []; jobs.recent = []; }, context);
    else {
      assert.deepEqual((await requestSubagentStop(f.harness, f.root.id, { jobId, worker: 1 }, context)).jobIds, []);
      assert.equal((await f.harness.getTask(cleanup.id, context))?.abortRequested, false, "A settled worker selection must not cancel unrelated whole-job cleanup.");
    }
    const calls = f.faux.state.callCount, before = JSON.stringify(await f.root.context(context));
    const receipt = await requestSubagentStop(f.harness, f.root.id, all ? {} : { jobId }, context);
    assert.deepEqual(receipt.jobIds, [jobId]);
    await until(async () => !!(await f.harness.getTask(cleanup.id, context))?.abortRequested);
    assert.equal((await f.harness.getTask(jobId, context))?.state.status, "completing", "Admission must not join held cleanup.");
    assert.equal(f.faux.state.callCount, calls); assert.equal(JSON.stringify(await f.root.context(context)), before);
    held.resolve(); await f.harness.waitForTask(jobId, context);
    const child = await f.harness.getTask(cleanup.id, context);
    assert.equal(child?.state.status, "terminal");
    if (child?.state.status === "terminal") assert.equal(child.state.outcome.status, "aborted");
    assert.equal((await readSubagentReportPage(f.harness, f.root.id, { jobId, worker: 1 }, context)).text, "Saved before cancellation.");
    assert.deepEqual((await requestSubagentStop(f.harness, f.root.id, { jobId }, context)).jobIds, []);
  } finally { held.resolve(); await f.close(); }
});

for (const local of [false, true]) test(`stop resumes completing-job cleanup after paused SQLite reopen (${local ? "local command" : "public API"})`, { timeout: 15000 }, async () => {
  const held = Promise.withResolvers<void>();
  const f = await fixture(() => fauxAssistantMessage("Saved before reopening."), { cleanup: held.promise, sqlite: true });
  let resumed: Harness | undefined;
  try {
    const jobId = await f.start(["A"]);
    await until(async () => (await f.harness.getTask(jobId, context))?.state.status === "completing");
    const cleanup = (await f.harness.commit((tx) => tx.scanTasks({ conversationId: f.root.id, kind: "inspection-cleanup" }, 2), context)).items[0];
    assert(cleanup);
    const calls = f.faux.state.callCount, before = JSON.stringify(await f.root.context(context));
    await f.harness.close(context); resumed = await f.open(await openNodeSqliteStorage(f.path));
    assert.equal((await resumed.inspect(context)).scheduling, "paused");
    if (local) {
      const messages: string[] = [], root = await resumed.conversation(f.root.id, context); assert(root);
      await f.extension.piD!.commands!.find((command) => command.name === "agent-stop")!.execute(String(jobId), {
        harness: resumed, conversation: root, context, signal: new AbortController().signal,
        message: (value) => { messages.push(value); }, notify: (value) => { messages.push(value); }, toast: () => {},
      });
      assert.match(messages.join("\n"), /Cancellation requested/);
    } else assert.deepEqual((await requestSubagentStop(resumed, f.root.id, { jobId }, context)).jobIds, [jobId]);
    assert.equal((await resumed.inspect(context)).scheduling, "running", "Stop must wake cleanup before any progress-wait call.");
    const reopened = resumed;
    await until(async () => !!(await reopened.getTask(cleanup.id, context))?.abortRequested);
    assert.equal((await resumed.getTask(jobId, context))?.state.status, "completing");
    assert.equal(f.faux.state.callCount, calls); assert.equal(JSON.stringify(await (await resumed.conversation(f.root.id, context))!.context(context)), before);
    held.resolve(); await resumed.waitForTask(jobId, context);
  } finally { held.resolve(); await resumed?.close(context); await f.close(); }
});

test("stop-all discovers every page of unindexed native jobs without model work", { timeout: 15000 }, async () => {
  const f = await fixture(() => { throw new Error("Stopping pending jobs must not run a model."); });
  try {
    const input: JobInput = { tasks: [{ name: "Pending", role: "worker", task: "Must not start." }], context: "",
      profile: { model, cwd: f.directory, thinkingLevel: "off", instructions: "" } };
    const ids = await f.harness.commit(async (tx) => {
      const ids: TaskId<JobResult>[] = [];
      for (let index = 0; index < 130; index++) ids.push(await tx.createTask(SubagentJob, input, {
        conversationId: f.root.id, ownership: { kind: "conversation" }, background: true,
      }));
      return ids;
    }, context);
    assert.equal(await f.harness.snapshot(Jobs, f.root.id, context), undefined);
    assert.deepEqual((await requestSubagentStop(f.harness, f.root.id, {}, context)).jobIds, ids);
    const settled = await Promise.all(ids.map((id) => f.harness.waitForTask(id, context)));
    assert(settled.every((job) => job.state.outcome.result?.status === "aborted"));
    assert.equal(f.faux.state.callCount, 0); assert.equal((await f.root.context(context)).entries.length, 0);
  } finally { await f.close(); }
});

test("model stop reports unsupported held cleanup and rolls back mixed-batch cancellation", { timeout: 10000 }, async () => {
  const cleanup = Promise.withResolvers<void>(), working = Promise.withResolvers<void>(); let started = false;
  const f = await fixture(async (transcript, options) => {
    if (workerName(transcript) === "B") { started = true; await gate(working.promise, options?.signal); }
    return fauxAssistantMessage("Saved result.");
  }, { cleanup: cleanup.promise });
  try {
    const completing = await f.start(["A"]);
    await until(async () => (await f.harness.getTask(completing, context))?.state.status === "completing");
    const running = await f.start(["B"]); await until(() => started);
    const before = await Promise.all([completing, running].map((jobId) => f.harness.snapshot(Control, jobId, context)));
    const result = await f.invoke("agent_stop", {});
    assert(result.isError); assert.match(text(result), /Cleanup is still pending.*\/agent-stop/);
    assert.deepEqual(await Promise.all([completing, running].map((jobId) => f.harness.snapshot(Control, jobId, context))), before);
    assert.equal((await f.harness.getTask(completing, context))?.abortRequested, false);
    assert((await readJob(f.harness, f.root.id, running, context)).workers.every((worker) => !worker.abortRequested && worker.state.status !== "terminal"));
    assert.equal((await f.harness.getTask(completing, context))?.state.status, "completing");
  } finally { cleanup.resolve(); working.resolve(); await f.close(); }
});

test("public inspection is detached, report-free and read-only without jobs, preflight or provider calls", async (t) => {
  const f = await fixture(() => { throw new Error("Inspection must not run a model."); });
  try {
    const before = JSON.stringify(await f.root.context(context)), commits = t.mock.method(f.storage, "commit");
    assert.deepEqual(await listSubagentJobs(f.harness, f.root.id, context), []);
    await assert.rejects(inspectSubagentJob(f.harness, f.root.id, 99999999, context), /not found/);
    assert.equal(commits.mock.callCount(), 0); assert.equal(f.faux.state.callCount, 0);
    assert.equal(await f.harness.snapshot(Jobs, f.root.id, context), undefined);
    assert.equal(JSON.stringify(await f.root.context(context)), before); assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { await f.close(); }
});

test("public functions validate raw targets, enforce conversation/worker ownership and never mutate rejected controls", { timeout: 10000 }, async (t) => {
  const held = Promise.withResolvers<void>(); let started = 0;
  const f = await fixture(async (_transcript, options) => { started++; await gate(held.promise, options?.signal); return fauxAssistantMessage("Done."); });
  try {
    const jobId = await f.start(); await until(() => started === 2); await f.root.waitForIdle(context);
    const first = await inspectSubagentJob(f.harness, f.root.id, jobId, context), childId = first.workers[0].conversationId!;
    const foreign = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const commits = t.mock.method(f.storage, "commit"), calls = f.faux.state.callCount;
    assert.equal(first.workers[0].worker, 1); assert(first.workers[0].capabilities?.tools.includes("bash"));
    assert(!("report" in first.workers[0]));
    (first.workers[0].capabilities!.tools as string[]).push("MUTATED-COPY");
    assert(!(await inspectSubagentJob(f.harness, f.root.id, jobId, context)).workers[0].capabilities?.tools.includes("MUTATED-COPY"));
    assert.equal((await listSubagentJobs(f.harness, f.root.id, context))[0].jobId, jobId);
    for (const value of [null, true, "1", 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(inspectSubagentJob(f.harness, f.root.id, value as never, context));
      await assert.rejects(requestSubagentStop(f.harness, f.root.id, { jobId: value } as never, context));
      await assert.rejects(readSubagentReportPage(f.harness, f.root.id, { jobId, worker: value } as never, context));
      await assert.rejects(admitSubagentMessage(f.harness, f.root.id, { jobId, worker: value, message: "No.", requestId: "invalid" } as never, context));
    }
    for (const value of [null, [], { worker: 1 }, { jobid: jobId }, { jobId, workr: 1 }]) await assert.rejects(requestSubagentStop(f.harness, f.root.id, value as never, context));
    for (const conversationId of [foreign.id, childId]) {
      const reason = conversationId === childId ? /Only the orchestrator/ : /not found/;
      await assert.rejects(inspectSubagentJob(f.harness, conversationId, jobId, context), reason);
      await assert.rejects(readSubagentReportPage(f.harness, conversationId, { jobId, worker: 1 }, context), reason);
      await assert.rejects(requestSubagentStop(f.harness, conversationId, { jobId }, context), reason);
      await assert.rejects(admitSubagentMessage(f.harness, conversationId, { jobId, worker: 1, message: "No.", requestId: "foreign" }, context), reason);
    }
    await assert.rejects(listSubagentJobs(f.harness, childId, context), /Only the orchestrator/);
    assert.equal(commits.mock.callCount(), 0); assert.equal(f.faux.state.callCount, calls);
  } finally { held.resolve(); await f.close(); }
});

test("API and model pages reconstruct large Unicode reports without byte/line clipping, including FEFF and trailing blanks", { timeout: 15000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = 0;
  const full = "Evidence 🙂\n" + "世界🌍\uFEFF".repeat(9000) + "\n".repeat(3500) + "\uFEFFEND🙂\n\n";
  const f = await fixture(async (transcript, options) => { started++; if (workerName(transcript) === "B") await gate(held.promise, options?.signal); return fauxAssistantMessage(full); });
  try {
    const jobId = await f.start(); await until(() => started === 2);
    const saved = await readJob(f.harness, f.root.id, jobId, context); await f.harness.waitForTask(saved.workers[0].id, context);
    const overview = text(await f.invoke("agent_results", { jobId })); assert.match(overview, /Overview shortened/); assert.match(overview, /"worker":N/);
    let offset: number | undefined = 0, reconstructed = "", pages = 0;
    do {
      const page = await readSubagentReportPage(f.harness, f.root.id, { jobId, worker: 1, offset, maxBytes: 17003 }, context);
      assert.equal(page.totalBytes, Buffer.byteLength(full)); assert.equal(page.historicallyTruncated, false);
      assert(Buffer.byteLength(page.text) <= 17003); assert(!page.text.includes("\ufffd"));
      assert(page.nextOffset === undefined || page.nextOffset > offset!); reconstructed += page.text; offset = page.nextOffset; pages++;
    } while (offset !== undefined);
    assert(pages > 5); assert.equal(reconstructed, full);
    offset = 0; reconstructed = "";
    do {
      const result = await f.invoke("agent_results", { jobId, worker: 1, offset, maxBytes: 17003 }); assert(!result.isError);
      const output = text(result); assert(Buffer.byteLength(output) < 50000); assert(output.split("\n").length < 2000);
      const next = output.match(/\nContinue: agent_results\(([^\n]+)\)$/), marker = next ? "\nContinue:" : "\n[End of saved report.]";
      const body = output.indexOf(":\n", output.indexOf("Report UTF-8 bytes ")) + 2;
      reconstructed += output.slice(body, output.lastIndexOf(marker));
      offset = next ? (JSON.parse(next[1]) as { offset: number }).offset : undefined;
    } while (offset !== undefined);
    assert.equal(reconstructed, full);
    for (const invalid of [1.5, -1, "1", null]) assert((await f.invoke("agent_results", { jobId, worker: 1, offset: invalid })).isError);
    await assert.rejects(readSubagentReportPage(f.harness, f.root.id, { jobId, worker: 1, offset: Buffer.byteLength(full) + 1 }, context), /offset/);
    const emoji = Buffer.byteLength("Evidence ") + 1;
    await assert.rejects(readSubagentReportPage(f.harness, f.root.id, { jobId, worker: 1, offset: emoji }, context), /boundary/);
  } finally { held.resolve(); await f.close(); }
});

test("native collection faults retain successful sibling reports through ownership and hide raw failures", { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>();
  const f = await fixture(async (transcript, options) => { if (workerName(transcript) === "B") await gate(held.promise, options?.signal); return fauxAssistantMessage("SIBLING-EVIDENCE"); }, { faultCollect: true });
  try {
    const jobId = await f.start(); await f.harness.waitForTask(jobId, context);
    const snapshot = await inspectSubagentJob(f.harness, f.root.id, jobId, context);
    assert.equal(snapshot.status, "failed"); assert.equal(snapshot.nativeOutcome, "faulted"); assert.equal(snapshot.workers.length, 2);
    assert.equal(snapshot.workers[0].outcome, "completed"); assert(snapshot.workers[0].conversationId);
    assert.equal((await readSubagentReportPage(f.harness, f.root.id, { jobId, worker: 1 }, context)).text, "SIBLING-EVIDENCE");
    assert(!JSON.stringify(snapshot).includes("PRIVATE-COLLECT-FAULT"));
    assert.match(text(await f.invoke("agent_results", { jobId })), /SIBLING-EVIDENCE/);
  } finally { held.resolve(); await f.close(); }
});

for (const cancelled of [false, true]) test(`public message receipts replay after ${cancelled ? "cancellation" : "settlement"} and reject identity reuse without restarting work`, { timeout: 10000 }, async () => {
  const held = Promise.withResolvers<void>(); let calls = 0;
  const f = await fixture(async (_transcript, options) => { if (++calls === 1) { await gate(held.promise, options?.signal); return fauxAssistantMessage("First."); } return fauxAssistantMessage("Revised."); });
  try {
    const jobId = await f.start(["A"]); await until(() => calls === 1);
    const request = { jobId, worker: 1, message: "Review additional evidence.", mode: "followUp" as const, requestId: "extension:action:one" };
    const receipt = await admitSubagentMessage(f.harness, f.root.id, request, context); assert.equal(receipt.status, "queued");
    assert.deepEqual(await admitSubagentMessage(f.harness, f.root.id, request, context), receipt);
    for (const changed of [{ message: "Different." }, { mode: "steer" }, { worker: 2 }, { jobId: jobId + 1 }]) await assert.rejects(admitSubagentMessage(f.harness, f.root.id, { ...request, ...changed } as never, context), /already used/);
    if (cancelled) assert.deepEqual((await requestSubagentStop(f.harness, f.root.id, { jobId }, context)).jobIds, [jobId]);
    else held.resolve();
    await f.harness.waitForTask(jobId, context); const before = f.faux.state.callCount;
    assert.deepEqual(await admitSubagentMessage(f.harness, f.root.id, request, context), receipt);
    await assert.rejects(admitSubagentMessage(f.harness, f.root.id, { ...request, requestId: "new-after-settlement" }, context), /no longer active/);
    assert.equal(f.faux.state.callCount, before); assert.equal(calls, cancelled ? 1 : 2);
    const native = (await f.storage.scanSubmissions({ conversationId: receipt.conversationId }, 10, undefined, context)).items;
    assert.equal(native.length, 2); assert(native.every((item) => item.status === (cancelled ? "unanswered" : "done")));
  } finally { held.resolve(); await f.close(); }
});

test("public message identity survives a lost caller acknowledgement and SQLite reopen after worker settlement", { timeout: 15000 }, async () => {
  const held = Promise.withResolvers<void>(); let started = false, reopened = false;
  const f = await fixture(async (transcript, options) => {
    if (transcript.messages.some((message) => message.role === "user" && message.content === "RECOVERED-API-MESSAGE")) return fauxAssistantMessage("Recovered final.");
    started = true; if (!reopened) await gate(held.promise, options?.signal); return fauxAssistantMessage("First.");
  }, { sqlite: true });
  let resumed: Harness | undefined;
  try {
    const jobId = await f.start(["A"]); await until(() => started);
    const request = { jobId, worker: 1, message: "RECOVERED-API-MESSAGE", mode: "followUp" as const, requestId: "extension:persisted:one" };
    const lost: SubagentAccess = { snapshot: f.harness.snapshot.bind(f.harness), commit: async (change, ctx) => {
      await f.harness.commit(change, ctx); throw new Error("Lost caller acknowledgement.");
    } };
    await assert.rejects(admitSubagentMessage(lost, f.root.id, request, context), /Lost caller/);
    const receipt = await admitSubagentMessage(f.harness, f.root.id, request, context);
    await f.harness.close(context); reopened = true;
    const storage = await openNodeSqliteStorage(f.path); resumed = await f.open(storage);
    await resumed.waitForTask(jobId, context);
    assert.deepEqual(await admitSubagentMessage(resumed, f.root.id, request, context), receipt);
    assert.equal((await readSubagentReportPage(resumed, f.root.id, { jobId, worker: 1 }, context)).text, "Recovered final.");
    const native = (await storage.scanSubmissions({ conversationId: receipt.conversationId }, 10, undefined, context)).items;
    assert.equal(native.length, 2); assert(native.every((item) => item.status === "done"));
  } finally { held.resolve(); await resumed?.close(context); await f.close(); }
});
