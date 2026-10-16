import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { mountChat, type ChatHandle } from "../src/chat.ts";
import { chatCommands } from "../src/commands.ts";
import { commandCompletion } from "../src/completion.ts";
import { codingRegistry } from "../src/coding.ts";
import { Resources } from "../src/resources.ts";
import { createSubagentsExtension } from "../src/subagents/index.ts";
import { Jobs } from "../src/subagents/state.ts";
import { readJob, resultView } from "../src/subagents/view.ts";
import { model, testModels } from "./models.ts";
import { gate, until, workerName } from "./subagent-fixtures.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;
test("optional extension loads through the unchanged native loader and contributes nothing when omitted", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-agent-loader-")));
  const resources = new Resources(join(directory, "config"), [], directory);
  try {
    const absent = await codingRegistry(resources);
    assert(!absent.snapshot().extension("pi-d-subagents"));
    const direct = await codingRegistry(resources, [fileURLToPath(new URL("../src/subagents/index.ts", import.meta.url))]);
    assert(direct.snapshot().extension("pi-d-subagents"));
    const wrapper = join(directory, "configured-subagents.ts");
    await writeFile(wrapper, 'import { createSubagentsExtension } from "pi-d-chat/subagents"; export default createSubagentsExtension({ concurrency: 1 });\n');
    const loaded = await codingRegistry(resources, [wrapper]);
    assert(loaded.snapshot().extension("pi-d-subagents"));
    const { models, faux } = testModels({ responses: Array.from({ length: 5 }, () => (transcript) => workerName(transcript) ? fauxAssistantMessage("SOURCE-LOADER-REPORT")
      : transcript.messages.filter((message) => message.role !== "system").at(-1)?.role === "toolResult" ? fauxAssistantMessage("Source loader verified.")
        : fauxAssistantMessage(fauxToolCall("delegate", { tasks: [{ name: "Loaded worker", task: "Report from the loaded extension." }] }), { stopReason: "toolUse" })) });
    const harness = await Harness.open(new MemoryStorage(), { models, registry: loaded, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }) }, context);
    try {
      const root = await harness.root(context, { agent: { model, cwd: directory } });
      assert.equal((await harness.inspect(context)).scheduling, "paused");
      assert.equal(await harness.snapshot(Jobs, root.id, context), undefined); assert.equal(faux.state.callCount, 0);
      const names = (await root.agent(context)).tools.map((tool) => tool.name);
      assert(names.includes("delegate")); assert(!names.includes("agent_read"));
      const input = await root.submit({ type: "input", content: "Exercise the loaded source extension." }, context); assert.equal((await input.wait(context)).status, "done");
      const jobId = (await harness.snapshot(Jobs, root.id, context))!.recent[0]; await harness.waitForTask(jobId, context);
      const saved = await readJob(harness, root.id, jobId, context); assert.equal(resultView(saved.job, saved.workers).workers[0].report, "SOURCE-LOADER-REPORT");
      assert.equal(faux.state.callCount, 3);
      assert.equal((await harness.snapshot(Jobs, root.id, context))?.recent.length, 1);
      await root.configure({ extensions: { remove: [loaded.snapshot().extension("pi-d-subagents")!] } }, context);
      assert(!(await root.agent(context)).tools.some((tool) => tool.name === "delegate"));
    } finally { await harness.close(context); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("local job inspection/completion/footer is read-only, works without preflight, and stopped workers leave siblings running", { timeout: 15000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-agent-ui-")));
  const stops = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let reached = 0, preflights = 0;
  const { models, faux } = testModels({ responses: Array.from({ length: 80 }, () => async (transcript, options) => {
    const name = workerName(transcript);
    if (name) { reached++; await gate(stops[name === "A" ? 0 : 1].promise, options?.signal); return fauxAssistantMessage([fauxThinking("PRIVATE-CHILD-THINKING"), fauxText(`REPORT-${name}`)]); }
    return transcript.messages.filter((message) => message.role !== "system").at(-1)?.role === "toolResult" ? fauxAssistantMessage("Background acknowledged.")
      : fauxAssistantMessage(fauxToolCall("delegate", { tasks: [{ name: "A", task: "Investigate A." }, { name: "B", task: "Investigate B." }], background: true }), { stopReason: "toolUse" });
  }) });
  const extension = createSubagentsExtension(), registry = createRegistry(); registry.install(extension);
  const storage = new MemoryStorage(), harness = await Harness.open(storage, { models, registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }), settings: { compaction: { enabled: false } } }, context);
  const root = await harness.root(context, { agent: { model, cwd: directory } });
  const chat: ChatHandle = { harness, conversation: root, models, label: "offline subagents", close: () => harness.close(context) };
  chat.command = chatCommands(chat, models); chat.completion = commandCompletion(chat, models);
  const terminal = new TestTerminal(110, 36), app = await mountChat(chat, terminal, false);
  const send = async (text: string) => { app.ui.composer.editor.setText(text); terminal.send("\r"); await terminal.flush(); await until(() => !app.ui.busy); };
  const displayed = () => app.ui.transcript.render(106).map(stripTerminalSequences).join("\n");
  try {
    const input = await root.submit({ type: "input", content: "Start a background batch." }, context); assert.equal((await input.wait(context)).status, "done");
    await until(() => reached === 2); await terminal.flush(); await terminal.flush();
    const jobId = (await harness.snapshot(Jobs, root.id, context))!.recent[0];
    assert.match(terminal.text(), /agents 0\/2 bg/); assert.equal(app.ui.composer.editor.disableSubmit, false);
    chat.beforeModel = async () => { preflights++; throw new Error("No model preflight allowed for local commands."); };
    const before = JSON.stringify(await root.context(context)), calls = faux.state.callCount;
    const commits = t.mock.method(storage, "commit");
    const suggestions = await chat.completion!.getSuggestions(["/agent-show "], 0, 12, { signal: new AbortController().signal, force: true });
    assert(suggestions?.items.some((item) => item.value === String(jobId)));
    await send("/agents"); assert.match(displayed(), new RegExp(`${jobId} · running`));
    await send(`/agent-show ${jobId}`); assert.match(displayed(), /No worker-count, concurrency, deadline/);
    await send(`/agent-show ${jobId} 1`); assert.match(displayed(), /Committed transcript/); assert.match(displayed(), /Investigate A/);
    await send("/agent-show 99999999"); assert.match(terminal.text(), /not found/);
    assert.equal(preflights, 0); assert.equal(faux.state.callCount, calls); assert.equal(JSON.stringify(await root.context(context)), before);
    assert.equal(commits.mock.callCount(), 0, "Inspecting jobs must not create documents, entries or admissions.");
    app.ui.composer.editor.setText(""); terminal.send("\x1b"); await terminal.flush();
    assert.notEqual((await harness.getTask(jobId, context))?.state.status, "terminal", "Ordinary Escape leaves background ownership alone.");
    const foreign = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await assert.rejects(readJob(harness, foreign.id, jobId, context), /not found in this conversation/);
    await send(`/agent-stop ${jobId} 1`);
    let snapshot = await readJob(harness, root.id, jobId, context), view = resultView(snapshot.job, snapshot.workers);
    assert.equal(view.status, "running"); assert.equal(view.workers[0].status, "aborted");
    assert.notEqual(snapshot.workers.find((worker) => worker.input.index === 1)?.state.status, "terminal");
    stops[1].resolve(); await harness.waitForTask(jobId, context); await terminal.flush();
    snapshot = await readJob(harness, root.id, jobId, context); view = resultView(snapshot.job, snapshot.workers);
    assert.equal(view.status, "partial"); assert.equal(faux.state.callCount, calls); assert.match(terminal.text(), /agents 2\/2 partial/);
    await send(`/agent-show ${jobId} 2`); assert.match(displayed(), /REPORT-B/); assert(!displayed().includes("PRIVATE-CHILD-THINKING"));
    const references = await harness.snapshot(Jobs, root.id, context);
    await send("/new"); assert.deepEqual(await harness.snapshot(Jobs, root.id, context), references);
    await send("/agents"); assert.match(displayed(), new RegExp(`${jobId} · partial`)); assert.equal(preflights, 0);
  } finally { for (const stop of stops) stop.resolve(); await app.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("local individual/whole-job stops cancel unrestricted concurrent assignments without model input", { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-agent-stop-"))), stop = Promise.withResolvers<void>(); let started = 0;
  const { models, faux } = testModels({ responses: Array.from({ length: 30 }, () => async (transcript, options) => {
    if (workerName(transcript)) { started++; await gate(stop.promise, options?.signal); return fauxAssistantMessage("Late report."); }
    return transcript.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("Acknowledged.")
      : fauxAssistantMessage(fauxToolCall("delegate", { tasks: [1, 2, 3].map((index) => ({ name: `Worker ${index}`, task: "Wait." })), background: true }), { stopReason: "toolUse" });
  }) });
  const registry = createRegistry(); registry.install(createSubagentsExtension({ concurrency: 1 }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd: directory }) }, context);
  const root = await harness.root(context, { agent: { model, cwd: directory } }), terminal = new TestTerminal(100, 30);
  const chat: ChatHandle = { harness, conversation: root, models, label: "offline", close: () => harness.close(context) }; chat.command = chatCommands(chat, models);
  const app = await mountChat(chat, terminal, false);
  try {
    const input = await root.submit({ type: "input", content: "Background work." }, context); await input.wait(context); await until(() => started === 3);
    const jobId = (await harness.snapshot(Jobs, root.id, context))!.recent[0], calls = faux.state.callCount;
    app.ui.composer.editor.setText(`/agent-stop ${jobId} 3`); terminal.send("\r"); await terminal.flush(); await until(() => !app.ui.busy);
    const partial = await readJob(harness, root.id, jobId, context); assert.equal(partial.workers.find((worker) => worker.input.index === 2)?.state.status, "terminal");
    app.ui.composer.editor.setText(`/agent-stop ${jobId}`); terminal.send("\r"); await terminal.flush(); await until(() => !app.ui.busy);
    const snapshot = await readJob(harness, root.id, jobId, context), view = resultView(snapshot.job, snapshot.workers);
    assert.equal(view.status, "aborted"); assert(view.workers.every((worker) => worker.status === "aborted"));
    assert.equal(snapshot.workers.length, 3); assert.equal(faux.state.callCount, calls);
    assert(!JSON.stringify((await root.context(context)).messages).includes("/agent-stop")); assert.equal((await harness.inspect(context)).tasks.length, 0);
  } finally { stop.resolve(); await app.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});
