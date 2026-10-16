import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type DocumentId, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createSubagentsExtension } from "../src/subagents/index.ts";
import { Jobs, JOB_KIND, WORKER_KIND, Worker } from "../src/subagents/state.ts";
import { readJob, resultView } from "../src/subagents/view.ts";
import { openPersistentChat } from "../src/session.ts";
import { requireRecoveryReady, sessionStatus } from "../src/status.ts";
import { lockLost, model, testModels } from "./models.ts";
import { gate, until, workerName, toolResults } from "./subagent-fixtures.ts";

const context = BACKGROUND_CONTEXT;
const cutpoints = ["job admission", "child creation", "child submission", "read admission", "child answer", "worker receipt", "job receipt"] as const;
type Cutpoint = typeof cutpoints[number];
function at(cut: Cutpoint, writes: readonly StorageWrite[], workerDoc?: DocumentId) {
  return writes.some((write) => {
    if (cut === "read admission") return write.type === "task" && write.value.kind === "pi.tool" && write.value.conversationId !== ROOT_CONVERSATION_ID && write.value.state.status === "running" && (write.value.state.checkpoint as { phase: string }).phase === "execute";
    if (cut === "child submission") return write.type === "submission" && write.value.conversationId !== ROOT_CONVERSATION_ID && write.value.status === "placed";
    if (cut === "child answer") return write.type === "entry" && write.value.conversationId !== ROOT_CONVERSATION_ID && write.value.kind === "pi.assistant";
    if (write.type !== "task") return false;
    const task = write.value;
    if (cut === "job admission") return task.kind === JOB_KIND && task.state.status === "pending";
    if (cut === "child creation") return task.kind === WORKER_KIND && task.state.status === "running" && (task.state.checkpoint as { phase: string }).phase === "run";
    return task.kind === (cut === "worker receipt" ? WORKER_KIND : JOB_KIND) && task.state.status === "terminal" && task.state.outcome.status === "completed";
  });
}

for (const cut of cutpoints) {
  test(`SQLite recovery after lost commit acknowledgement at ${cut} reuses the job, child and request`, { timeout: 15000 }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-subagent-recovery-"))), path = join(directory, "session.sqlite");
    let tripped = false, workerDoc: DocumentId | undefined;
    await writeFile(join(directory, "README.md"), "A durable read fixture.\n");
    const original = await openNodeSqliteStorage(path);
    // Simulate the crash window after SQLite committed but before the Harness received its acknowledgement.
    const storage: Storage = new Proxy(original, { get(target, key) {
      if (key === "commit") return async (writes: readonly StorageWrite[], commitContext: typeof context) => {
        for (const write of writes) if (write.type === "document.create" && write.record.kind === "pi-d.subagent") workerDoc = write.record.id;
        const seq = await target.commit(writes, commitContext);
        if (!tripped && at(cut, writes, workerDoc)) { tripped = true; throw new Error("Injected lost commit acknowledgement."); }
        return seq;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const respond: FauxResponseFactory = (transcript) => workerName(transcript) ? cut === "read admission" && !toolResults(transcript).length
      ? fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }) : fauxAssistantMessage("SAVED-WORKER-REPORT")
      : transcript.messages.filter((message) => message.role !== "system").at(-1)?.role === "toolResult" ? fauxAssistantMessage("Recovered coordinator answer.")
        : fauxAssistantMessage(fauxToolCall("delegate", { tasks: [{ name: "A", task: "Investigate the fixture." }] }), { stopReason: "toolUse" });
    const first = testModels({ responses: Array.from({ length: 30 }, () => respond) });
    const maxToolCalls = cut === "read admission" ? 1 : 7;
    const registry = createRegistry(); registry.install(createSubagentsExtension({ concurrency: 1, maxToolCalls }));
    const options = { models: first.models, registry, env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? directory }),
      now: () => 100, settings: { retry: { enabled: false }, compaction: { enabled: false } }, onReport: () => {} };
    let harness = await Harness.open(storage, options, context);
    try {
      let root = await harness.root(context, { agent: { model, cwd: directory } });
      const request = await root.submit({ type: "input", content: "Recover this delegation.", requestId: "parent-request" }, context);
      const waiting = request.wait(context).catch((error: unknown) => error);
      await until(() => tripped, cut); assert.equal((await harness.closed).reason, "failed"); await waiting;
      let resumedWorkers = 0;
      const second = testModels({ responses: Array.from({ length: 30 }, () => (...args) => { if (workerName(args[0])) resumedWorkers++; return respond(...args); }) });
      const freshRegistry = createRegistry(); freshRegistry.install(createSubagentsExtension({ concurrency: 4, maxToolCalls: 1 }));
      const reopened = await openNodeSqliteStorage(path);
      // Arbitrarily long downtime imposes no extension deadline.
      harness = await Harness.open(reopened, { ...options, models: second.models, registry: freshRegistry, now: () => cut === "child answer" ? 999999 : 100 }, context);
      root = await harness.root(context);
      const same = await root.submit({ type: "input", content: "Recover this delegation.", requestId: "parent-request" }, context);
      assert.equal(same.id, request.id); assert.equal((await same.wait(context)).status, "done");
      const jobId = (await harness.snapshot(Jobs, root.id, context))!.recent[0];
      await harness.waitForTask(jobId, context);
      const snapshot = await readJob(harness, root.id, jobId, context), view = resultView(snapshot.job, snapshot.workers);
      assert.equal(view.status, "completed", JSON.stringify(view)); assert.equal(view.workers[0].report, "SAVED-WORKER-REPORT");
      assert(!("policy" in snapshot.job.input));
      assert.equal((await reopened.scanTasks({ kind: JOB_KIND }, 10, undefined, context)).items.length, 1);
      assert.equal((await reopened.scanTasks({ kind: WORKER_KIND }, 10, undefined, context)).items.length, 1);
      const children = (await reopened.scanConversations({ ownerConversationId: root.id }, 10, undefined, context)).items;
      assert.equal(children.length, 1);
      const submissions = (await reopened.scanSubmissions({ conversationId: children[0].id }, 10, undefined, context)).items;
      assert.equal(submissions.length, 1); assert.equal(submissions[0].requestId, `subagent:${snapshot.workers[0].id}`);
      const worker = await harness.snapshot(Worker, children[0].id, context);
      assert(worker?.owner); assert(!("maxToolCalls" in worker.owner)); assert(!("calls" in worker));
      const messages = (await root.context(context)).messages;
      assert.equal(messages.filter((message) => message.role === "toolResult" && message.toolName === "delegate").length, 1);
      assert.equal((await harness.inspect(context)).tasks.length, 0);
      if (cut === "child answer" || cut === "worker receipt" || cut === "job receipt") assert.equal(resumedWorkers, 0, "Committed worker answers are reused.");
    } finally { await harness.close(context); await rm(directory, { recursive: true, force: true }); }
  });
}

test("a never-submitted worker still runs after arbitrarily long downtime", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-agent-expired-"))), file = join(directory, "session.sqlite");
  const storage = await openNodeSqliteStorage(file); let tripped = false;
  const wrapped = new Proxy(storage, { get(target, key) {
    if (key === "commit") return async (writes: readonly StorageWrite[], commitContext: typeof context) => {
      const seq = await target.commit(writes, commitContext);
      if (!tripped && at("child creation", writes)) { tripped = true; throw new Error("Crash after child creation."); }
      return seq;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const registry = createRegistry(); registry.install(createSubagentsExtension({ timeoutMs: 100 }));
  const first = testModels({ responses: [fauxAssistantMessage(fauxToolCall("delegate", { tasks: [{ name: "Persisted", task: "Resume after downtime." }] }), { stopReason: "toolUse" }), fauxAssistantMessage("Background acknowledged.")] });
  const options = { models: first.models, registry, env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? directory }), now: () => 100,
    settings: { compaction: { enabled: false }, retry: { enabled: false } }, onReport: () => {} };
  let harness = await Harness.open(wrapped, options, context);
  try {
    const root = await harness.root(context, { agent: { model, cwd: directory } });
    const input = await root.submit({ type: "input", content: "Start an assignment." }, context); const wait = input.wait(context).catch((error: unknown) => error);
    await until(() => tripped); await harness.closed; await wait;
    const second = testModels({ responses: Array.from({ length: 5 }, () => fauxAssistantMessage("No-deadline recovered report.")) });
    const reopened = await openNodeSqliteStorage(file);
    harness = await Harness.open(reopened, { ...options, models: second.models, now: () => 1e12 }, context);
    const restored = await harness.root(context), request = await harness.submission(input.id, context); assert(request);
    assert.equal((await request.wait(context)).status, "done");
    const jobId = (await harness.snapshot(Jobs, restored.id, context))!.recent[0], snapshot = await readJob(harness, restored.id, jobId, context);
    await harness.waitForTask(jobId, context);
    const settled = await readJob(harness, restored.id, jobId, context), view = resultView(settled.job, settled.workers); assert.equal(view.status, "completed"); assert.equal(view.workers[0].report, "No-deadline recovered report.");
    assert.equal((await reopened.scanSubmissions({ conversationId: view.workers[0].conversationId }, 10, undefined, context)).items.length, 1);
    assert(second.faux.state.callCount >= 1);
  } finally { await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});

test("missing subagent code pauses host recovery; restoring trusted code resumes the same background job", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-agent-missing-"))), file = join(directory, "session.sqlite");
  const reached = Promise.withResolvers<void>(), stop = Promise.withResolvers<void>();
  const first = testModels({ responses: Array.from({ length: 20 }, () => async (transcript, options) => {
    if (workerName(transcript)) { reached.resolve(); await gate(stop.promise, options?.signal); return fauxAssistantMessage("Initial worker."); }
    return transcript.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("Background acknowledged.")
      : fauxAssistantMessage(fauxToolCall("delegate", { tasks: [{ name: "Persisted", task: "Resume me." }], background: true }), { stopReason: "toolUse" });
  }) });
  const registry = createRegistry(); registry.install(createSubagentsExtension());
  const env = ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? directory });
  let chat = await openPersistentChat(file, first.models, { defaults: { model }, cwd: directory, registry, env, onLockLost: lockLost });
  try {
    const input = await chat.conversation.submit({ type: "input", content: "Start background work." }, context); assert.equal((await input.wait(context)).status, "done"); await reached.promise;
    const jobId = (await chat.harness.snapshot(Jobs, chat.conversation.id, context))!.recent[0]; await chat.close();
    const second = testModels({ responses: [fauxAssistantMessage("Recovered background report.")] });
    chat = await openPersistentChat(file, second.models, { registry: createRegistry(), env, onLockLost: lockLost });
    await assert.rejects(requireRecoveryReady(chat), /Recovery is blocked.*pi-d-subagents/);
    assert.match(await sessionStatus(chat, second.models), /missing_task/); assert.equal(second.faux.state.callCount, 0);
    assert.equal((await chat.harness.inspect(context)).scheduling, "paused"); await chat.close();
    chat = await openPersistentChat(file, second.models, { registry, env, onLockLost: lockLost }); await requireRecoveryReady(chat); chat.harness.resume();
    assert.equal((await chat.harness.waitForTask(jobId, context)).state.outcome.status, "completed");
    assert.equal((await chat.harness.snapshot(Jobs, chat.conversation.id, context))!.recent.length, 1);
    assert.equal(second.faux.state.callCount, 1);
  } finally { stop.resolve(); await chat.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a model cancellation survives a lost commit acknowledgement and restart", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-agent-stop-recovery-"))), path = join(directory, "session.sqlite"), hold = Promise.withResolvers<void>();
  let controlDoc: DocumentId | undefined, armed = false, tripped = false, reached = false;
  const original = await openNodeSqliteStorage(path);
  const storage: Storage = new Proxy(original, { get(target, key) {
    if (key === "commit") return async (writes: readonly StorageWrite[], ctx: typeof context) => {
      for (const write of writes) if (write.type === "document.create" && write.record.kind === "pi-d.subagent-control") controlDoc = write.record.id;
      const seq = await target.commit(writes, ctx);
      if (armed && !tripped && writes.some((write) => write.type === "document.change" && write.id === controlDoc)) { tripped = true; throw new Error("Lost cancellation acknowledgement."); }
      return seq;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const first = testModels({ responses: Array.from({ length: 15 }, () => async (transcript, options) => {
    if (workerName(transcript)) { reached = true; await gate(hold.promise, options?.signal); return fauxAssistantMessage("Late."); }
    if (transcript.messages.filter((message) => message.role !== "system").at(-1)?.role === "toolResult") return fauxAssistantMessage("Acknowledged.");
    return fauxAssistantMessage(fauxToolCall(JSON.stringify(transcript.messages).includes("STOP-REQUEST") ? "agent_stop" : "delegate",
      JSON.stringify(transcript.messages).includes("STOP-REQUEST") ? {} : { tasks: [{ name: "A", task: "Wait for cancellation." }] }), { stopReason: "toolUse" });
  }) });
  const registry = createRegistry(); registry.install(createSubagentsExtension());
  const options = { registry, models: first.models, env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? directory }), onReport: () => {} };
  let harness = await Harness.open(storage, options, context);
  try {
    let root = await harness.root(context, { agent: { model, cwd: directory } });
    const start = await root.submit({ type: "input", content: "Start." }, context); await start.wait(context); await until(() => reached);
    const jobId = (await harness.snapshot(Jobs, root.id, context))!.recent[0]; armed = true;
    const stop = await root.submit({ type: "input", content: "STOP-REQUEST", requestId: "stop-once" }, context), waiting = stop.wait(context).catch(() => undefined);
    await until(() => tripped); assert.equal((await harness.closed).reason, "failed"); await waiting;
    const second = testModels({ responses: Array.from({ length: 10 }, () => async (transcript, requestOptions) => {
      if (workerName(transcript)) { await gate(hold.promise, requestOptions?.signal); return fauxAssistantMessage("Late."); }
      return fauxAssistantMessage("Recovered cancellation acknowledgement.");
    }) });
    harness = await Harness.open(await openNodeSqliteStorage(path), { ...options, models: second.models }, context); root = await harness.root(context);
    const same = await root.submit({ type: "input", content: "STOP-REQUEST", requestId: "stop-once" }, context); assert.equal(same.id, stop.id);
    assert.equal((await same.wait(context)).status, "done"); await harness.waitForTask(jobId, context);
    const saved = await readJob(harness, root.id, jobId, context); assert.equal(resultView(saved.job, saved.workers).status, "aborted");
    assert.equal(saved.workers.length, 1); assert.deepEqual((await harness.snapshot(Jobs, root.id, context))?.active, []);
    assert.equal((await harness.inspect(context)).tasks.length, 0);
  } finally { hold.resolve(); await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});

test("SIGKILL during a native background subagent recovers its original job and conversation", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-agent-kill-"))), path = join(directory, "session.sqlite");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "test/subagent-crash-child.ts", path, directory], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  let harness: Harness | undefined;
  try {
    await until(() => { if (child.exitCode !== null) throw new Error(`Crash probe exited early: ${errors}`); return output.includes("WORKER-READY"); }, "crash probe");
    child.kill("SIGKILL"); await exited;
    const { models, faux } = testModels({ responses: [fauxAssistantMessage("SIGKILL-RECOVERED-REPORT")] });
    const registry = createRegistry(); registry.install(createSubagentsExtension());
    const storage = await openNodeSqliteStorage(path);
    harness = await Harness.open(storage, { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }) }, context);
    const root = await harness.root(context), jobId = (await harness.snapshot(Jobs, root.id, context))!.recent[0]; harness.resume();
    assert.equal((await harness.waitForTask(jobId, context)).state.outcome.status, "completed");
    const snapshot = await readJob(harness, root.id, jobId, context); assert.equal(resultView(snapshot.job, snapshot.workers).workers[0].report, "SIGKILL-RECOVERED-REPORT");
    assert.equal((await storage.scanConversations({ ownerConversationId: root.id }, 10, undefined, context)).items.length, 1);
    assert.equal((await storage.scanTasks({ kind: JOB_KIND }, 10, undefined, context)).items.length, 1);
    assert.equal((await storage.scanTasks({ kind: WORKER_KIND }, 10, undefined, context)).items.length, 1);
    const submissions = (await storage.scanSubmissions({ conversationId: resultView(snapshot.job, snapshot.workers).workers[0].conversationId }, 10, undefined, context)).items;
    assert.equal(submissions.length, 1); assert.equal(submissions[0].requestId, `subagent:${snapshot.workers[0].id}`); assert.equal(faux.state.callCount, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    child.stdin.destroy(); await harness?.close(context); await rm(directory, { recursive: true, force: true });
  }
});
