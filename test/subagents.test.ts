import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, Harness, MemoryStorage, ProviderDoc, UsageDoc, ToolTask, hook, type Conversation, type HarnessOptions, type TaskId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createSubagentsExtension } from "../src/subagents/index.ts";
import { bounded, Control, DEFAULT_POLICY, Jobs, Worker, type JobInput, type JobResult, type SubagentPolicy } from "../src/subagents/state.ts";
import { SubagentJob } from "../src/subagents/tasks.ts";
import { readJob, resultView } from "../src/subagents/view.ts";
import { model, testModels } from "./models.ts";
import { gate, until, userText, workerName, toolResults } from "./subagent-fixtures.ts";

const context = BACKGROUND_CONTEXT;
const assignments = (names: string[]) => names.map((name) => ({ name, task: `Investigate ${name} and cite evidence.` }));
const call = (name: string, args: { [key: string]: JsonValue }) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const delegate = (names = ["A"]) => call("delegate", { tasks: assignments(names), background: false, context: "SHARED-BRIEF" });
const afterTool = (transcript: TranscriptContext) => transcript.messages.filter((message) => message.role !== "system").at(-1)?.role === "toolResult";
async function fixture(respond: FauxResponseFactory, options: Partial<SubagentPolicy> = {}, harnessOptions: Partial<HarnessOptions> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-subagents-")));
  const { models, faux } = testModels({ responses: Array.from({ length: 500 }, () => respond) });
  const extension = createSubagentsExtension(options), registry = createRegistry(); registry.install(extension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }),
    settings: { retry: { enabled: false }, compaction: { enabled: false } }, ...harnessOptions }, context);
  const root = await harness.root(context, { agent: { model, cwd: directory } });
  return { directory, models, faux, extension, registry, storage, harness, root,
    close: async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); } };
}
async function ask(root: Conversation, content = "ROOT-PRIVATE-HISTORY") {
  const input = await root.submit({ type: "input", content }, context); assert.equal((await input.wait(context)).status, "done");
}
async function latest(harness: Harness, root: Conversation, settle = false) {
  const jobId = (await harness.snapshot(Jobs, root.id, context))?.recent.at(-1); assert(jobId);
  if (settle) await harness.waitForTask(jobId, context);
  return readJob(harness, root.id, jobId, context);
}

test("native background delegation isolates history/extensions, selects normal tools, and accounts usage once", { timeout: 10000 }, async () => {
  const workerRequests: TranscriptContext[] = [], rootRequests: TranscriptContext[] = [];
  const f = await fixture((transcript) => {
    const name = workerName(transcript);
    if (name) {
      workerRequests.push(transcript);
      if (!toolResults(transcript).length) return call("read", { path: "README.md" });
      assert.match(JSON.stringify(toolResults(transcript)), /FILE-PAYLOAD/);
      return fauxAssistantMessage([fauxThinking("WORKER-THINKING-PRIVATE"), fauxText(`FINDING-${name}: README.md:1 explains the fixture.`)]);
    }
    rootRequests.push(transcript); return afterTool(transcript) ? fauxAssistantMessage("Workers started; I retain control.") : delegate(["A", "B", "C"]);
  });
  f.registry.install(defineExtension({ name: "parent-only", hooks: [hook(ToolTask, { beforeTool: (tool) => tool.name === "read" ? { block: "Must not reach workers" } : undefined })] }));
  try {
    await writeFile(join(f.directory, "README.md"), "FILE-PAYLOAD: workspace evidence.\n");
    await f.root.configure({ instructions: "EXPLICIT-PARENT-INSTRUCTION: report evidence and uncertainty." }, context);
    const parent = await f.root.agent(context);
    assert.deepEqual(parent.tools.map((tool) => tool.name).toSorted(), ["agent_message", "agent_results", "agent_stop", "bash", "delegate", "edit", "read", "write"]);
    await ask(f.root); const { job, workers } = await latest(f.harness, f.root, true), view = resultView(job, workers);
    assert.equal(view.status, "completed"); assert(job.background); assert.equal(job.owner, undefined);
    assert.deepEqual(view.workers.map((worker) => worker.name), ["A", "B", "C"]);
    assert.equal(workerRequests.length, 6); assert.equal(rootRequests.length, 2); assert.equal(f.faux.state.callCount, 8);
    assert(workerRequests.every((request) => !JSON.stringify(request).includes("ROOT-PRIVATE-HISTORY")));
    assert(rootRequests.every((request) => !JSON.stringify(request).includes("FILE-PAYLOAD") && !JSON.stringify(request).includes("WORKER-THINKING-PRIVATE")));
    const identities = new Set([(await f.harness.snapshot(ProviderDoc, f.root.id, context))!.sessionId]), conversations = [f.root];
    let expectedOutput = (await f.harness.usage(context)).models["faux/faux-1"].output;
    for (const worker of view.workers) {
      const child = await f.harness.conversation(worker.conversationId!, context); assert(child); const agent = await child.agent(context);
      assert.deepEqual(agent.model, parent.model); assert.equal(agent.thinkingLevel, parent.thinkingLevel); assert.equal(agent.cwd, f.directory);
      assert.match(agent.instructions!, /EXPLICIT-PARENT-INSTRUCTION/); assert.match(agent.instructions!, /Do not spawn/);
      assert.deepEqual(agent.tools.map((tool) => tool.name).toSorted(), ["bash", "edit", "read", "write"]);
      assert.deepEqual(agent.extensions.map((extension) => extension.name), ["pi-d-subagents"]);
      identities.add((await f.harness.snapshot(ProviderDoc, child.id, context))!.sessionId); conversations.push(child);
    }
    assert.equal(identities.size, 4);
    for (const conversation of conversations) expectedOutput -= (await f.harness.snapshot(UsageDoc, conversation.id, context))!.models["faux/faux-1"].output;
    assert.equal(expectedOutput, 0); assert.deepEqual((await f.harness.snapshot(Jobs, f.root.id, context))?.active, []);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { await f.close(); }
});

test("70 workers exceed even the admission transaction chunk without a concurrency cap; coordinator retains control", { timeout: 15000 }, async () => {
  const names = Array.from({ length: 70 }, (_, index) => `W${index}`), gates = new Map(names.map((name) => [name, Promise.withResolvers<void>()]));
  const started: string[] = []; let active = 0, peak = 0;
  const f = await fixture(async (transcript, options) => {
    const name = workerName(transcript);
    if (!name) return afterTool(transcript) ? fauxAssistantMessage("I can still coordinate.") : delegate(names);
    started.push(name); active++; peak = Math.max(peak, active);
    try { await gate(gates.get(name)!.promise, options?.signal); return fauxAssistantMessage(`REPORT-${name}`); } finally { active--; }
  }, { concurrency: 1, maxTasks: 1 });
  try {
    await ask(f.root); await until(() => started.length === 70); assert.equal(peak, 70);
    const { job } = await latest(f.harness, f.root); assert.equal(job.input.tasks.length, 70);
    for (const name of names.toReversed()) { gates.get(name)!.resolve(); await until(() => active === names.indexOf(name)); }
    const snapshot = await latest(f.harness, f.root, true);
    assert.deepEqual(resultView(snapshot.job, snapshot.workers).workers.map((worker) => worker.name), names);
  } finally { for (const value of gates.values()) value.resolve(); await f.close(); }
});

for (const allFail of [false, true]) test(`model failures preserve ${allFail ? "failed" : "partial"} results and successful siblings`, { timeout: 10000 }, async () => {
  const f = await fixture((transcript) => {
    const name = workerName(transcript);
    if (name) return name === "A" || allFail ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "PRIVATE-PROVIDER-ERROR" }) : fauxAssistantMessage("SUCCESS-B");
    return afterTool(transcript) ? fauxAssistantMessage("Started.") : delegate(["A", "B"]);
  });
  try {
    await ask(f.root); const snapshot = await latest(f.harness, f.root, true), view = resultView(snapshot.job, snapshot.workers);
    assert.equal(view.status, allFail ? "failed" : "partial"); assert.match(view.workers[0].error!, /unanswered/);
    assert(!JSON.stringify(view).includes("PRIVATE-PROVIDER-ERROR")); assert.equal(view.workers[1].status, allFail ? "failed" : "completed");
  } finally { await f.close(); }
});

test("orchestrator snapshots never block, and model cancellation stops one worker then the whole job", { timeout: 15000 }, async () => {
  const stop = Promise.withResolvers<void>(); let started = 0, jobId: TaskId<JobResult>;
  const f = await fixture(async (transcript, options) => {
    if (workerName(transcript)) { started++; await gate(stop.promise, options?.signal); return fauxAssistantMessage("Late."); }
    if (afterTool(transcript)) return fauxAssistantMessage("Control retained.");
    const text = userText(transcript);
    if (text.includes("STOP-ALL")) return call("agent_stop", { jobId });
    if (text.includes("STOP-ONE")) return call("agent_stop", { jobId, worker: 1 });
    if (text.includes("SNAPSHOT")) return call("agent_results", { jobId, wait: true });
    return delegate(["A", "B", "C"]);
  });
  try {
    await ask(f.root); await until(() => started === 3); jobId = (await latest(f.harness, f.root)).job.id;
    await ask(f.root, "SNAPSHOT even legacy wait:true must return.");
    const running = await latest(f.harness, f.root); assert.equal(resultView(running.job, running.workers).status, "running");
    await ask(f.root, "STOP-ONE");
    let snapshot = await latest(f.harness, f.root); const first = snapshot.workers.find((worker) => worker.input.index === 0)!;
    assert.equal((await f.harness.waitForTask(first.id, context)).state.outcome.status, "aborted");
    snapshot = await latest(f.harness, f.root); assert.equal(resultView(snapshot.job, snapshot.workers).status, "running");
    assert(snapshot.workers.filter((worker) => worker.input.index !== 0).every((worker) => worker.state.status !== "terminal"));
    await ask(f.root, "STOP-ALL"); snapshot = await latest(f.harness, f.root, true);
    assert.equal(resultView(snapshot.job, snapshot.workers).status, "aborted"); assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { stop.resolve(); await f.close(); }
});

test("all 33 overlapping batches remain discoverable/cancellable, even beyond recent-history retention", { timeout: 20000 }, async () => {
  const stop = Promise.withResolvers<void>(); let started = 0;
  const f = await fixture(async (transcript, options) => {
    if (workerName(transcript)) { started++; await gate(stop.promise, options?.signal); return fauxAssistantMessage("Late."); }
    if (afterTool(transcript)) return fauxAssistantMessage("Acknowledged.");
    if (userText(transcript).includes("STOP-EVERYTHING")) return call("agent_stop", {});
    if (userText(transcript).includes("DISCOVER")) return call("agent_results", {});
    return delegate();
  });
  try {
    for (let index = 0; index < 33; index++) await ask(f.root, `Start batch ${index}.`);
    await until(() => started === 33); const jobs = (await f.harness.snapshot(Jobs, f.root.id, context))!;
    assert.equal(jobs.active.length, 33); assert.equal(jobs.recent.length, 30);
    await f.harness.waitForIdle(context); await f.root.abort(context);
    await ask(f.root, "DISCOVER"); const discovered = (await f.root.context(context)).messages.filter((message) => message.role === "toolResult" && message.toolName === "agent_results").at(-1);
    assert.match(JSON.stringify(discovered), new RegExp(`job ${jobs.active[0]} is running`));
    const foreign = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await assert.rejects(readJob(f.harness, foreign.id, jobs.active[0], context), /not found in this conversation/);
    await ask(f.root, "STOP-EVERYTHING"); await Promise.all(jobs.active.map((id) => f.harness.waitForTask(id, context)));
    assert.deepEqual((await f.harness.snapshot(Jobs, f.root.id, context))?.active, []); assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { stop.resolve(); await f.close(); }
});

for (const cancel of [false, true]) test(`worker ${cancel ? "cancellation" : "completion"} drains child background boundaries`, { timeout: 10000 }, async () => {
  const stop = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>(); let backgroundStarted = false, backgroundAborted = false;
  const f = await fixture(async (transcript, options) => {
    if (workerName(transcript)) { reached.resolve(); await gate(stop.promise, options?.signal); return fauxAssistantMessage("REPORT-A"); }
    return afterTool(transcript) ? fauxAssistantMessage("Started.") : delegate();
  });
  const background = defineTask<{}, { phase: "hold" }, {}>({ name: "fixture.child-background", version: 1, initial: () => ({ phase: "hold" }),
    phases: { hold: async (_task, runtime, taskContext) => { backgroundStarted = true; await runtime.sleep(runtime.now() + 60000, taskContext);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), taskContext); } },
    abort: async (_task, runtime, taskContext) => { backgroundAborted = true; await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext); },
  }); f.registry.install(defineExtension({ name: "background-fixture", tasks: [background] }));
  try {
    await ask(f.root); await reached.promise; const snapshot = await latest(f.harness, f.root), child = snapshot.workers[0].state;
    assert(child.status !== "terminal" && child.status !== "completing" && child.checkpoint.phase === "run");
    const conversationId = child.checkpoint.conversationId;
    const backgroundId = await f.harness.commit((tx) => tx.createTask(background, {}, { ownership: { kind: "conversation" }, conversationId, background: true }), context);
    await until(() => backgroundStarted);
    if (cancel) await f.harness.abortTask(snapshot.job.id, context); else stop.resolve();
    await f.harness.waitForTask(snapshot.job.id, context); assert(backgroundAborted);
    assert.equal((await f.harness.getTask(backgroundId, context))?.state.status, "terminal"); assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { stop.resolve(); await f.close(); }
});

test("no worker deadline or tool-call budget; legacy factory numbers are ignored", { timeout: 15000 }, async () => {
  let now = 100, started = false; const stop = Promise.withResolvers<void>();
  const f = await fixture(async (transcript, options) => {
    if (!workerName(transcript)) return afterTool(transcript) ? fauxAssistantMessage("Started.") : delegate();
    if (toolResults(transcript).length < 105) return call("read", { path: "README.md" });
    started = true; await gate(stop.promise, options?.signal); return fauxAssistantMessage("UNBOUNDED-REPORT");
  }, { timeoutMs: 10, maxToolCalls: 1 }, { now: () => now });
  try {
    await writeFile(join(f.directory, "README.md"), "Read fixture."); await ask(f.root); now = 1e12;
    await until(() => started); await delay(50); let snapshot = await latest(f.harness, f.root);
    assert.equal(resultView(snapshot.job, snapshot.workers).status, "running"); assert(!JSON.stringify(snapshot.workers[0].state).includes("deadline"));
    stop.resolve(); snapshot = await latest(f.harness, f.root, true);
    assert.equal(resultView(snapshot.job, snapshot.workers).workers[0].report, "UNBOUNDED-REPORT");
  } finally { stop.resolve(); await f.close(); }
});

test("full Unicode reports are saved without a byte cap, excluding thinking", { timeout: 10000 }, async () => {
  const text = "你好👩🏽‍💻".repeat(2000);
  const f = await fixture((transcript) => workerName(transcript) ? fauxAssistantMessage([fauxThinking("NOT-A-REPORT"), fauxText(text)])
    : afterTool(transcript) ? fauxAssistantMessage("Started.") : delegate(), { maxReportBytes: 256 });
  try { await ask(f.root); const snapshot = await latest(f.harness, f.root, true), report = resultView(snapshot.job, snapshot.workers).workers[0];
    assert.equal(report.status, "completed"); assert.equal(report.truncated, false); assert.equal(report.report, text);
  } finally { await f.close(); }
});

test("workers use unrestricted stock read/write/edit/bash tools, not the former read-only path profile", { timeout: 10000 }, async () => {
  const outside = await mkdtemp(join(tmpdir(), "pi-d-agent-outside-"));
  const f = await fixture((transcript) => {
    if (!workerName(transcript)) return afterTool(transcript) ? fauxAssistantMessage("Started.") : delegate();
    const results = toolResults(transcript); assert(results.every((result) => !result.isError), JSON.stringify(results));
    if (!results.length) return call("read", { path: "outside-link" });
    if (results.length === 1) return call("write", { path: "changed.txt", content: "first" });
    if (results.length === 2) return call("edit", { path: "changed.txt", oldText: "first", newText: "edited" });
    if (results.length === 3) return call("bash", { command: "printf 'shell marker' > shell.txt" });
    assert.match(JSON.stringify(results[0]), /FAUX-OUTSIDE-READ/); return fauxAssistantMessage("Actual file operations completed.");
  });
  try {
    await writeFile(join(outside, "fixture"), "FAUX-OUTSIDE-READ"); await symlink(join(outside, "fixture"), join(f.directory, "outside-link"));
    await ask(f.root); await latest(f.harness, f.root, true);
    assert.equal(await readFile(join(f.directory, "changed.txt"), "utf8"), "edited"); assert.equal(await readFile(join(f.directory, "shell.txt"), "utf8"), "shell marker");
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

for (const toolName of ["delegate", "agent_results", "agent_stop", "agent_message"]) test(`workers cannot call orchestrator tool ${toolName}, even if a caller bypasses selection`, { timeout: 10000 }, async () => {
  const args: { [key: string]: JsonValue } = toolName === "delegate" ? { tasks: assignments(["RECURSIVE"]) } : toolName === "agent_message" ? { jobId: 1, worker: 1, message: "Forbidden." } : {};
  const f = await fixture((transcript) => workerName(transcript) ? toolResults(transcript).length ? fauxAssistantMessage("Orchestration was blocked.") : call(toolName, args)
    : afterTool(transcript) ? fauxAssistantMessage("Started.") : delegate());
  try {
    await ask(f.root); const snapshot = await latest(f.harness, f.root, true), result = resultView(snapshot.job, snapshot.workers).workers[0];
    const child = await f.harness.conversation(result.conversationId!, context); assert(child);
    assert((await child.context(context)).messages.some((message) => message.role === "toolResult" && message.isError));
    assert.equal((await f.harness.snapshot(Jobs, f.root.id, context))?.recent.length, 1);
    const selected = f.extension.tools!.find((tool) => tool.name === toolName)!;
    await assert.rejects(Promise.resolve().then(() => selected.execute(args, { snapshot: async () => ({ owner: { jobId: snapshot.job.id } }) } as unknown as ToolExecutionApi, context)), /Workers cannot delegate|Only the orchestrator/);
  } finally { await f.close(); }
});

for (const input of ["", " ".repeat(10000), "thinking only"]) test(`empty/whitespace/thinking-only answers are not reports (${input.length})`, { timeout: 10000 }, async () => {
  const f = await fixture((transcript) => workerName(transcript) ? fauxAssistantMessage(input === "thinking only" ? fauxThinking("PRIVATE-THINKING") : fauxText(input))
    : afterTool(transcript) ? fauxAssistantMessage("Started.") : delegate());
  try { await ask(f.root); const snapshot = await latest(f.harness, f.root, true), view = resultView(snapshot.job, snapshot.workers);
    assert.equal(view.status, "failed"); assert.match(view.workers[0].error!, /no text report/);
  } finally { await f.close(); }
});

test("a preparation fault fails one assignment without leaking active references", { timeout: 10000 }, async () => {
  const f = await fixture((transcript) => afterTool(transcript) ? fauxAssistantMessage("Started.") : delegate(), {}, {
    env: ({ cwd }) => { const env = new NodeExecutionEnv({ cwd: cwd! }); env.canonicalPath = async () => { throw new Error("Fixture canonicalization fault."); }; return env; },
  });
  try { await ask(f.root); const snapshot = await latest(f.harness, f.root, true), view = resultView(snapshot.job, snapshot.workers);
    assert.equal(view.status, "failed"); assert.match(view.workers[0].error!, /faulted/);
    assert.deepEqual((await f.harness.snapshot(Jobs, f.root.id, context))?.active, []); assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { await f.close(); }
});
for (const tasks of [[], [{ name: "  ", task: "Investigate." }]]) test(`invalid delegation is rejected before admission (${tasks.length})`, async () => {
  const f = await fixture((transcript) => afterTool(transcript) ? fauxAssistantMessage("Rejected.") : call("delegate", { tasks }));
  try { await ask(f.root); assert.equal(await f.harness.snapshot(Jobs, f.root.id, context), undefined);
    assert((await f.root.context(context)).messages.some((message) => message.role === "toolResult" && message.isError));
  } finally { await f.close(); }
});
test("model stop interrupts a real stock bash process, preserving already-written effects", { timeout: 10000 }, async () => {
  let jobId: TaskId<JobResult>;
  const f = await fixture((transcript) => {
    if (workerName(transcript)) return call("bash", { command: "printf 'already written' > before-stop.txt; printf '%s' \"$$\" > worker.pid; exec sleep 60" });
    return afterTool(transcript) ? fauxAssistantMessage("Control retained.") : userText(transcript).includes("STOP-BASH") ? call("agent_stop", { jobId }) : delegate();
  });
  try {
    await ask(f.root); jobId = (await latest(f.harness, f.root)).job.id;
    await until(async () => { try { return !!(await readFile(join(f.directory, "worker.pid"), "utf8")); } catch { return false; } });
    const pid = Number(await readFile(join(f.directory, "worker.pid"), "utf8")); assert(Number.isSafeInteger(pid) && pid > 1);
    await ask(f.root, "STOP-BASH"); const saved = await latest(f.harness, f.root, true);
    assert.equal(resultView(saved.job, saved.workers).status, "aborted");
    await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } });
    assert.equal(await readFile(join(f.directory, "before-stop.txt"), "utf8"), "already written");
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { await f.close(); }
});

test("model control rejects another conversation's job and cannot cancel it", { timeout: 10000 }, async () => {
  let jobId: TaskId<JobResult>; const hold = Promise.withResolvers<void>();
  const f = await fixture(async (transcript, options) => {
    if (workerName(transcript)) { await gate(hold.promise, options?.signal); return fauxAssistantMessage("Late."); }
    return afterTool(transcript) ? fauxAssistantMessage("Acknowledged.") : userText(transcript).includes("FOREIGN") ? call("agent_stop", { jobId }) : delegate();
  });
  try {
    await ask(f.root); jobId = (await latest(f.harness, f.root)).job.id;
    const foreign = await f.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: f.directory } }, context);
    await ask(foreign, "FOREIGN");
    const results = (await foreign.context(context)).messages.filter((message) => message.role === "toolResult");
    assert(results[0].isError); assert.match(JSON.stringify(results), /not found in this conversation/);
    assert.notEqual((await f.harness.getTask(jobId, context))?.state.status, "terminal");
    await f.harness.abortTask(jobId, context); await f.harness.waitForTask(jobId, context);
  } finally { hold.resolve(); await f.close(); }
});

test("a durable stop saved before dispatch starts no worker or model request", async () => {
  const f = await fixture(() => fauxAssistantMessage("Must not be requested."));
  try {
    const agent = await f.root.agent(context);
    const input: JobInput = { tasks: assignments(["A", "B"]).map((task) => ({ ...task, role: "worker" })), context: "", profile: { model, thinkingLevel: agent.thinkingLevel, cwd: f.directory, instructions: "" } };
    const jobId = await f.harness.commit(async (tx) => {
      const jobs = await tx.doc(Jobs, f.root.id);
      const id = await tx.createTask(SubagentJob, input,
        { conversationId: f.root.id, ownership: { kind: "conversation" }, background: true });
      (await tx.doc(Control, id)).all = true; jobs.active.push(id); jobs.recent.push(id); return id;
    }, context);
    const result = await f.harness.waitForTask(jobId, context); assert.equal(result.state.outcome.status, "aborted");
    const saved = await readJob(f.harness, f.root.id, jobId, context); assert.equal(saved.workers.length, 0);
    assert.equal(resultView(saved.job, saved.workers).workers.length, 2); assert.equal(f.faux.state.callCount, 0);
  } finally { await f.close(); }
});

test("legacy defaults mean unlimited; Unicode bounds affect UI previews only", () => {
  assert(Object.isFrozen(DEFAULT_POLICY)); assert(Object.values(DEFAULT_POLICY).every((value) => value === null));
  for (const size of [256, 257, 258, 259, 260, 8000]) for (const side of ["head", "tail"] as const) {
    const value = bounded("a你好👩🏽‍💻".repeat(2000), size, side); assert(value.truncated); assert(Buffer.byteLength(value.text) <= size); assert(!value.text.includes("�"));
    if (side === "tail") assert(value.text.endsWith("a你好👩🏽‍💻"));
  }
});
