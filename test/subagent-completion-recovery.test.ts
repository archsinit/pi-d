import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type Storage, type StorageWrite, type TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mountChat } from "../src/chat.ts";
import { chatCommands } from "../src/commands.ts";
import { modelReadinessGate, modelReadinessPending } from "../src/model-readiness.ts";
import { openPersistentChat } from "../src/session.ts";
import { requireRecoveryReady, sessionStatus } from "../src/status.ts";
import { createSubagentsExtension } from "../src/subagents/index.ts";
import { COMPLETION_ENTRY, COMPLETION_KIND, JOB_KIND, Jobs, WORKER_KIND, type JobResult } from "../src/subagents/state.ts";
import { readJob, resultView } from "../src/subagents/view.ts";
import { completionJob, gate, until, workerName } from "./subagent-fixtures.ts";
import { lockLost, model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

function registry(missingCompletion = false) {
  const registry = createRegistry(), extension = createSubagentsExtension();
  registry.install(missingCompletion ? { ...extension, tasks: extension.tasks!.filter((task) => task.definition.name !== COMPLETION_KIND) } : extension);
  return registry;
}
const respond: FauxResponseFactory = (transcript) => {
  if (workerName(transcript)) return fauxAssistantMessage("RECOVERED-WORKER-REPORT");
  const jobId = completionJob(transcript), last = transcript.messages.at(-1);
  if (jobId !== undefined) return last?.role === "toolResult" && last.toolName === "agent_results" ? fauxAssistantMessage("AUTOMATIC-RECOVERY-UPDATE")
    : fauxAssistantMessage(fauxToolCall("agent_results", { jobId }), { stopReason: "toolUse" });
  return last?.role === "toolResult" ? fauxAssistantMessage("Background acknowledged.")
    : fauxAssistantMessage(fauxToolCall("delegate", { tasks: [{ name: "Recover", task: "Produce the saved report." }] }), { stopReason: "toolUse" });
};
const modelsFor = (factory = respond) => testModels({ responses: Array.from({ length: 30 }, () => factory) });
const cuts = ["job admission", "notifier waiting", "job receipt", "callback admission", "callback entry", "notifier receipt", "callback answer"] as const;
function at(cut: typeof cuts[number], writes: readonly StorageWrite[]) {
  return writes.some((write) => {
    if (cut === "callback admission") return write.type === "submission" && write.value.requestId?.startsWith("subagent-completion:");
    if (cut === "callback entry") return write.type === "entry" && write.value.kind === COMPLETION_ENTRY;
    if (cut === "callback answer") return write.type === "entry" && write.value.conversationId === ROOT_CONVERSATION_ID && write.value.kind === "pi.assistant" && JSON.stringify(write.value.model).includes("AUTOMATIC-RECOVERY-UPDATE");
    return write.type === "task" && write.value.kind === (cut === "job admission" || cut === "job receipt" ? JOB_KIND : COMPLETION_KIND)
      && write.value.state.status === (cut === "job admission" ? "pending" : cut === "notifier waiting" ? "waiting" : "terminal");
  });
}

for (const cut of cuts) test(`SQLite callback recovery after lost acknowledgement at ${cut} admits one job-scoped event`, { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-callback-recovery-"))), path = join(directory, "session.sqlite");
  const original = await openNodeSqliteStorage(path); let tripped = false;
  const storage: Storage = new Proxy(original, { get(target, key) {
    if (key === "commit") return async (writes: readonly StorageWrite[], ctx: typeof context) => {
      const seq = await target.commit(writes, ctx);
      if (!tripped && at(cut, writes)) { tripped = true; throw new Error("Injected callback acknowledgement loss."); }
      return seq;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const first = modelsFor(), options = { registry: registry(), models: first.models, env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? directory }),
    settings: { retry: { enabled: false }, compaction: { enabled: false } }, onReport: () => {} };
  let harness = await Harness.open(storage, options, context);
  try {
    let root = await harness.root(context, { agent: { model, cwd: directory } });
    const input = await root.submit({ type: "input", content: "START", requestId: "coordinator-once" }, context), waiting = input.wait(context).catch(() => undefined);
    await until(() => tripped, cut); assert.equal((await harness.closed).reason, "failed"); await waiting;
    const second = modelsFor(), reopened = await openNodeSqliteStorage(path);
    harness = await Harness.open(reopened, { ...options, models: second.models, registry: registry() }, context); root = await harness.root(context);
    assert.equal(second.faux.state.callCount, 0); assert.equal((await harness.inspect(context)).scheduling, "paused");
    const same = await root.submit({ type: "input", content: "START", requestId: "coordinator-once" }, context); assert.equal(same.id, input.id);
    assert.equal((await same.wait(context)).status, "done");
    const callback = (await reopened.scanTasks({ kind: COMPLETION_KIND }, 10, undefined, context)).items[0]; assert(callback);
    await harness.waitForTask(callback.id, context); await root.waitForIdle(context);
    const jobId = (callback.input as { jobId: TaskId<JobResult> }).jobId, saved = await readJob(harness, root.id, jobId, context);
    assert.equal(resultView(saved.job, saved.workers).status, "completed"); assert.equal(resultView(saved.job, saved.workers).workers[0].report, "RECOVERED-WORKER-REPORT");
    for (const kind of [JOB_KIND, WORKER_KIND, COMPLETION_KIND]) assert.equal((await reopened.scanTasks({ kind }, 10, undefined, context)).items.length, 1);
    const notices = (await root.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY); assert.equal(notices.length, 1);
    const submissions = (await reopened.scanSubmissions({ conversationId: root.id }, 10, undefined, context)).items;
    assert.equal(submissions.length, 2); const receipt = submissions.find((submission) => submission.requestId === `subagent-completion:${jobId}`)!;
    assert.equal(receipt.status, "done"); assert.equal((await harness.inspect(context)).tasks.length, 0);
    if (cut === "callback answer") assert.equal(second.faux.state.callCount, 0, "A saved coordinator answer must not call the provider again.");
    await harness.close(context);
    const third = testModels(); harness = await Harness.open(await openNodeSqliteStorage(path), { ...options, models: third.models, registry: registry() }, context);
    root = await harness.root(context); harness.resume(); await root.waitForIdle(context);
    assert.equal(third.faux.state.callCount, 0); assert.equal((await root.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 1);
    assert.equal((await harness.commit((tx) => tx.submissionByRequest(root.id, `subagent-completion:${jobId}`), context))?.id, receipt.id);
  } finally { await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});

for (const command of ["/interrupt", "/agent-stop"] as const) test(`paused host ${command} cannot bypass model readiness; approving the reopened host releases one completion`, { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-callback-readiness-"))), path = join(directory, "session.sqlite"), held = Promise.withResolvers<void>(); let started = false;
  const first = modelsFor(async (transcript, options, ...rest) => {
    if (workerName(transcript)) { started = true; await gate(held.promise, options?.signal); }
    return respond(transcript, options, ...rest);
  });
  const options = { registry: registry(), env: ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? directory }), defaultCwd: directory,
    defaults: { model }, onLockLost: lockLost, onReport: () => {}, gateModelWork: true };
  let chat = await openPersistentChat(path, first.models, options);
  try {
    assert(await modelReadinessPending(chat.harness)); chat.allowModel!();
    const initial = await chat.conversation.submit({ type: "input", content: "START" }, context); await initial.wait(context); await until(() => started);
    const jobId = (await chat.harness.snapshot(Jobs, chat.conversation.id, context))!.recent[0]; await chat.close();
    const second = modelsFor(); chat = await openPersistentChat(path, second.models, { ...options, registry: registry() });
    assert(await modelReadinessPending(chat.harness)); assert.equal(second.faux.state.callCount, 0);
    chat.beforeModel = async () => { throw new Error("TEST-AUTH-READINESS-PAUSED"); }; chat.command = chatCommands(chat, second.models);
    const terminal = new TestTerminal(100, 30), app = await mountChat(chat, terminal, false);
    try {
      await until(() => terminal.text().includes("TEST-AUTH-READINESS-PAUSED"));
      app.ui.composer.editor.setText(command === "/agent-stop" ? `/agent-stop ${jobId}` : command); terminal.send("\r"); await terminal.flush();
      if (command === "/agent-stop") {
        await until(async () => (await chat.harness.getTask(jobId, context))?.state.status === "terminal");
        await until(async () => (await chat.harness.inspect(context)).tasks.some(({ record }) => record.kind === COMPLETION_KIND && record.state.status === "running"));
        assert.equal(await chat.harness.commit((tx) => tx.submissionByRequest(chat.conversation.id, `subagent-completion:${jobId}`), context), undefined);
      } else await until(() => !app.ui.busy);
      assert.equal(second.faux.state.callCount, 0, "Local cancellation must not authorize a replay, worker or callback provider request.");
      assert.match(await sessionStatus(chat, second.models), /model requests await host authentication\/recovery readiness/);
      chat.beforeModel = async () => { await requireRecoveryReady(chat); chat.allowModel!(); };
      await chat.beforeModel(); chat.harness.resume();
      await until(async () => JSON.stringify((await chat.conversation.context(context)).messages).includes("AUTOMATIC-RECOVERY-UPDATE"));
      await chat.conversation.waitForIdle(context);
      assert.equal((await chat.conversation.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 1);
      const saved = await readJob(chat.harness, chat.conversation.id, jobId, context);
      assert.equal(resultView(saved.job, saved.workers).status, command === "/agent-stop" ? "aborted" : "completed");
      assert.equal(second.faux.state.callCount, command === "/agent-stop" ? 2 : 3);
    } finally { await app.close(); terminal.dispose(); }
  } finally { held.resolve(); await chat.close(); await rm(directory, { recursive: true, force: true }); }
});

test("missing notifier code keeps recovery and provider work paused; restoring code recovers the original callback", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-callback-missing-"))), path = join(directory, "session.sqlite");
  const first = modelsFor(), original = await openNodeSqliteStorage(path); let tripped = false;
  const wrapped: Storage = new Proxy(original, { get(target, key) {
    if (key === "commit") return async (writes: readonly StorageWrite[], ctx: typeof context) => {
      const seq = await target.commit(writes, ctx);
      if (!tripped && at("job receipt", writes)) { tripped = true; throw new Error("Stop before callback delivery."); }
      return seq;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const env = () => new NodeExecutionEnv({ cwd: directory }), harness = await Harness.open(wrapped, { models: first.models, registry: registry(), env, onReport: () => {} }, context);
  const root = await harness.root(context, { agent: { model, cwd: directory } });
  const input = await root.submit({ type: "input", content: "START" }, context), waiting = input.wait(context).catch(() => undefined);
  await until(() => tripped); await harness.closed; await waiting;
  const second = modelsFor(), options = { registry: registry(true), env, defaultCwd: directory, defaults: { model }, onLockLost: lockLost, gateModelWork: true };
  let chat = await openPersistentChat(path, second.models, options);
  try {
    await assert.rejects(requireRecoveryReady(chat), /Recovery is blocked/); assert.match(await sessionStatus(chat, second.models), new RegExp(COMPLETION_KIND));
    assert.equal(second.faux.state.callCount, 0); assert.equal((await chat.harness.inspect(context)).scheduling, "paused"); await chat.close();
    chat = await openPersistentChat(path, second.models, { ...options, registry: registry() }); await requireRecoveryReady(chat); chat.allowModel!(); chat.harness.resume();
    await until(async () => JSON.stringify((await chat.conversation.context(context)).messages).includes("AUTOMATIC-RECOVERY-UPDATE"));
    await chat.conversation.waitForIdle(context); assert.equal((await chat.conversation.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 1);
    assert.equal(second.faux.state.callCount, 2, "Settled workers are not restarted to deliver their callback.");
  } finally { await chat.close(); await harness.close(context); await rm(directory, { recursive: true, force: true }); }
});

test("SIGKILL recovery retains the notifier and admits one automatic completion after the original worker resumes", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-callback-kill-"))), path = join(directory, "session.sqlite");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./subagent-crash-child.ts", import.meta.url)), path, directory, "completion"], {
    env: { PATH: process.env.PATH, HOME: join(directory, "home"), XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), NODE_NO_WARNINGS: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); }); let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.resume();
  let harness: Harness | undefined;
  try {
    await until(() => output.includes("WORKER-READY")); child.kill("SIGKILL"); await exited;
    const next = modelsFor(), storage = await openNodeSqliteStorage(path);
    harness = await Harness.open(storage, { models: next.models, registry: registry(), env: () => new NodeExecutionEnv({ cwd: directory }) }, context);
    const root = await harness.root(context), notifier = (await storage.scanTasks({ kind: COMPLETION_KIND }, 10, undefined, context)).items[0]; assert(notifier);
    await harness.waitForTask(notifier.id, context); await root.waitForIdle(context);
    assert.equal((await root.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 1);
    assert.equal((await storage.scanTasks({ kind: WORKER_KIND }, 10, undefined, context)).items.length, 1);
    assert.equal((await storage.scanConversations({ ownerConversationId: root.id }, 10, undefined, context)).items.length, 1);
    assert.equal(next.faux.state.callCount, 3);
  } finally { child.kill("SIGKILL"); await exited; await harness?.close(context); await rm(directory, { recursive: true, force: true }); }
});

test("a withdrawn queued callback is not resurrected when its lost-acknowledgement notifier replays", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-callback-withdraw-"))), path = join(directory, "session.sqlite");
  const worker = Promise.withResolvers<void>(), busy = Promise.withResolvers<void>(); let parentStarted = false, tripped = false;
  const original = await openNodeSqliteStorage(path), storage: Storage = new Proxy(original, { get(target, key) {
    if (key === "commit") return async (writes: readonly StorageWrite[], ctx: typeof context) => {
      const seq = await target.commit(writes, ctx);
      if (!tripped && writes.some((write) => write.type === "submission" && write.value.status === "queued" && write.value.requestId?.startsWith("subagent-completion:"))) {
        tripped = true; throw new Error("Callback queued before acknowledgement was lost.");
      }
      return seq;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const first = modelsFor(async (transcript, options, ...rest) => {
    if (workerName(transcript)) await gate(worker.promise, options?.signal);
    else if (JSON.stringify(transcript.messages.filter((message) => message.role === "user")).includes("HOLD-ROOT")) {
      parentStarted = true; await gate(busy.promise, options?.signal); return fauxAssistantMessage("Unreachable parent final.");
    }
    return respond(transcript, options, ...rest);
  });
  const options = { registry: registry(), models: first.models, onReport: () => {}, env: () => new NodeExecutionEnv({ cwd: directory }) };
  let harness = await Harness.open(storage, options, context), readiness: ReturnType<typeof modelReadinessGate> | undefined;
  try {
    let root = await harness.root(context, { agent: { model, cwd: directory } });
    await (await root.submit({ type: "input", content: "START" }, context)).wait(context);
    const jobId = (await harness.snapshot(Jobs, root.id, context))!.recent[0];
    const held = await root.submit({ type: "input", content: "HOLD-ROOT" }, context), waiting = held.wait(context).catch(() => undefined);
    await until(() => parentStarted); worker.resolve(); await until(() => tripped); await harness.closed; await waiting;
    const next = modelsFor(), reopened = await openNodeSqliteStorage(path); readiness = modelReadinessGate(next.models);
    harness = await Harness.open(reopened, { ...options, registry: registry(), models: readiness.models }, context); readiness.attach(harness); root = await harness.root(context);
    const queued = await harness.commit((tx) => tx.submissionByRequest(root.id, `subagent-completion:${jobId}`), context); assert.equal(queued?.status, "queued");
    const receipt = await harness.submission(queued.id, context); assert(receipt); assert.equal(await receipt.abort(context), "aborted");
    await root.abort(context); assert.equal(next.faux.state.callCount, 0);
    const notifier = (await reopened.scanTasks({ kind: COMPLETION_KIND }, 10, undefined, context)).items[0]; assert(notifier);
    readiness.allow(); const completed = await harness.waitForTask(notifier.id, context); await root.waitForIdle(context);
    assert.equal((completed.state.outcome.result as { submissionId: number }).submissionId, queued.id);
    assert.equal((await receipt.status(context)).status, "unanswered"); assert.equal(next.faux.state.callCount, 0);
    assert.equal((await root.context(context)).entries.filter((entry) => entry.kind === COMPLETION_ENTRY).length, 0);
    const callbacks = (await reopened.scanSubmissions({ conversationId: root.id }, 10, undefined, context)).items.filter((submission) => submission.requestId?.startsWith("subagent-completion:"));
    assert.equal(callbacks.length, 1); assert.equal(callbacks[0].id, queued.id);
  } finally { worker.resolve(); busy.resolve(); await harness.close(context); readiness?.close(); await rm(directory, { recursive: true, force: true }); }
});
