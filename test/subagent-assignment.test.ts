import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, GenerationTask, Harness, hook, MemoryStorage, ROOT_CONVERSATION_ID, section, wrapTool,
  type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { codingRegistry } from "../src/coding.ts";
import { defineChatExtension } from "../src/extensions.ts";
import { mountChat, type ChatHandle } from "../src/chat.ts";
import { chatCommands } from "../src/commands.ts";
import { Resources } from "../src/resources.ts";
import { openPersistentChat } from "../src/session.ts";
import { requireRecoveryReady } from "../src/status.ts";
import { JOB_KIND, WORKER_KIND, Jobs, Worker } from "../src/subagents/state.ts";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { readJob, resultView } from "../src/subagents/view.ts";
import { gate, until, workerName, toolResults } from "./subagent-fixtures.ts";
import { lockLost, model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const call = (name: string, args: { [key: string]: JsonValue } = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const task = (name: string, skills?: string[], extensions?: string[]) => ({ name, task: `Complete ${name} and cite evidence.`, ...(skills ? { skills } : {}), ...(extensions ? { extensions } : {}) });
async function skill(directory: string, name: string, body: string, manual = false) {
  const path = join(directory, "config", "skills", name, "SKILL.md");
  await mkdir(join(directory, "config", "skills", name), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: ${name} fixture instructions\n${manual ? "disable-model-invocation: true\n" : ""}---\n${body}`);
  return path;
}
async function fixture(respond: FauxResponseFactory, options: { directory?: string; storage?: Storage } = {}) {
  const directory = options.directory ?? await realpath(await mkdtemp(join(tmpdir(), "pi-d-assigned-")));
  const resources = new Resources(join(directory, "config"), [], directory);
  const registry = await codingRegistry(resources);
  const { models, faux } = testModels({ responses: Array.from({ length: 100 }, () => respond) });
  const storage = options.storage ?? new MemoryStorage();
  const harness = await Harness.open(storage, { registry, models, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? directory }),
    settings: { retry: { enabled: false }, compaction: { enabled: false } }, onReport: () => {} }, context);
  const root = await harness.root(context, { agent: { model, cwd: directory } });
  return { directory, resources, registry, harness, root, models, faux,
    ask: async (content = "ROOT-PRIVATE-HISTORY") => { const request = await root.submit({ type: "input", content }, context); assert.equal((await request.wait(context)).status, "done"); },
    latest: async () => { const jobId = (await harness.snapshot(Jobs, root.id, context))!.recent.at(-1)!; await harness.waitForTask(jobId, context); return readJob(harness, root.id, jobId, context); },
    close: async () => { await harness.close(context); if (!options.directory) await rm(directory, { recursive: true, force: true }); },
  };
}
const baseline = ["bash", "edit", "read", "write"];
const probe = (name: string, action = () => {}) => defineTool({ name, description: name, replay: "safe", parameters: Type.Object({}), async execute() {
  action(); return { output: [{ type: "text" as const, text: `${name}-RESULT` }] };
} });
const injected = (text: string) => hook(GenerationTask, { beforeRequest: ({ messages }) => ({ messages: [...messages, { role: "user" as const, content: text, timestamp: 0 }] }) });

test("built-in workers get only individually assigned extensions/hooks/wraps and full skills, never the shared catalog or parent history", { timeout: 15000 }, async () => {
  const requests = new Map<string, string[]>(); let uiCalls = 0;
  const f = await fixture((transcript) => {
    const name = workerName(transcript), results = toolResults(transcript);
    if (!name) return results.length ? fauxAssistantMessage("I retain control.") : call("delegate", { tasks: [
      task("review", ["code-review", "external-skill"], ["review-ext", "pi-d-subagents"]), task("test", ["manual"], ["test-ext"]), task("omitted"), task("empty", [], []), task("ui-only", [], ["@fixture/ui-only "]),
    ] });
    requests.set(name, [...(requests.get(name) ?? []), JSON.stringify(transcript)]);
    if (!results.length) return call(name === "review" ? "review_probe" : name === "test" ? "test_probe" : "read", name === "review" || name === "test" ? {} : { path: "README.md" });
    if (name === "review" && results.length === 1) return call("read", { path: "README.md" });
    assert(results.every((result) => !result.isError), JSON.stringify(results));
    if (name === "review") assert.match(JSON.stringify(results), /REVIEW-WRAPPER-MARKER/);
    return fauxAssistantMessage(`REPORT-${name}`);
  });
  f.registry.install(defineExtension({ name: "review-ext", tools: [probe("review_probe")], sections: [section("review_rules", () => "REVIEW-SECTION-MARKER")], hooks: [injected("REVIEW-HOOK-MARKER")],
    wraps: [wrapTool(createReadTool(), (original) => ({ ...original, async execute(args, api, ctx) {
      const result = await original.execute(args, api, ctx); return { ...result, output: [...(result.output ?? []), { type: "text" as const, text: "REVIEW-WRAPPER-MARKER" }] };
    } }))] }));
  f.registry.install(defineChatExtension({ name: "test-ext", tools: [probe("test_probe")], sections: [section("test_rules", () => "TEST-SECTION-MARKER")], hooks: [injected("TEST-HOOK-MARKER")],
    piD: { commands: [{ name: "assigned-ui", description: "UI must remain headless", execute: () => { uiCalls++; } }], footer: () => { uiCalls++; return []; } } }));
  f.registry.install(defineChatExtension({ name: "@fixture/ui-only ", piD: { footer: () => { uiCalls++; return []; } } }));
  f.registry.install(defineExtension({ name: "unassigned", tools: [probe("unassigned_probe")], sections: [section("unassigned_rules", () => "UNASSIGNED-SECTION-MARKER")], hooks: [injected("UNASSIGNED-HOOK-MARKER")] }));
  try {
    const reviewPath = await skill(f.directory, "code-review", "REVIEW-SKILL-BODY\nUse relative-helper.md as guidance.");
    await skill(f.directory, "manual", "MANUAL-SKILL-BODY", true); await skill(f.directory, "unassigned", "UNASSIGNED-SKILL-BODY");
    const external = join(f.directory, "extra-skill.md"); await writeFile(external, "---\nname: external-skill\ndescription: Explicit --skill fixture\n---\nEXTERNAL-SKILL-BODY"); f.resources.skillPaths.push(external);
    await writeFile(join(f.directory, "README.md"), "Stock read evidence."); await writeFile(join(f.directory, "AGENTS.md"), "PROJECT-INSTRUCTION-MARKER");
    await f.ask(); const saved = await f.latest(); assert.equal(resultView(saved.job, saved.workers).status, "completed");
    assert.equal(uiCalls, 0); assert.equal(saved.job.version, 3);
    for (const [name, values] of requests) {
      const text = values.join("\n"); assert(!text.includes("ROOT-PRIVATE-HISTORY")); assert(!text.includes("UNASSIGNED-SKILL-BODY"));
      assert(!text.includes("UNASSIGNED-HOOK-MARKER")); assert(!text.includes("UNASSIGNED-SECTION-MARKER")); assert(!text.includes("available_skills"));
      assert.match(text, /PROJECT-INSTRUCTION-MARKER/);
      assert.equal(text.includes("REVIEW-SKILL-BODY"), name === "review"); assert.equal(text.includes("EXTERNAL-SKILL-BODY"), name === "review"); assert.equal(text.includes("MANUAL-SKILL-BODY"), name === "test");
      assert.equal(text.includes("REVIEW-HOOK-MARKER"), name === "review"); assert.equal(text.includes("TEST-HOOK-MARKER"), name === "test");
      const record = saved.workers.find((worker) => worker.input.assignment.name === name)!;
      const child = await f.harness.conversation(resultView(saved.job, saved.workers).workers.find((worker) => worker.name === name)!.conversationId!, context); assert(child);
      const agent = await child.agent(context), extra = name === "review" ? ["review_probe"] : name === "test" ? ["test_probe"] : [];
      assert.deepEqual(agent.tools.map((tool) => tool.name).sort(), [...baseline, ...extra].sort());
      assert(!agent.callable.some((tool) => ["delegate", "agent_stop", "agent_results", "agent_message"].includes(tool.name)));
      const caps = record.input.assignment.capabilities!; assert(caps);
      assert.deepEqual((await f.harness.snapshot(Worker, child.id, context))!.capabilities, caps);
      if (name === "review") { assert.equal(caps.skills[0].filePath, reviewPath); assert.match(caps.skills[0].content, /REVIEW-SKILL-BODY/); }
      if (name === "omitted" || name === "empty") { assert.deepEqual(caps.skills, []); assert.deepEqual(caps.extensions, []); }
      if (name === "ui-only") assert(agent.extensions.some((extension) => extension.name === "@fixture/ui-only "));
    }
    const parentText = JSON.stringify(await f.root.context(context)); assert(!parentText.includes("REVIEW-SKILL-BODY")); assert(!parentText.includes("MANUAL-SKILL-BODY"));
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { await f.close(); }
});

for (const invalid of [
  { label: "unknown skill", skills: ["missing"], extensions: [] },
  { label: "skill path", skills: ["../../SKILL.md"], extensions: [] },
  { label: "unknown extension", skills: [], extensions: ["missing"] },
  { label: "extension path", skills: [], extensions: ["/tmp/do-not-import.mjs"] },
  { label: "disabled extension", skills: [], extensions: ["disabled"] },
  { label: "blank skill", skills: ["   "], extensions: [] },
  { label: "blank extension", skills: [], extensions: ["   "] },
  { label: "duplicate skill", skills: ["code-review", " code-review "], extensions: [] },
  { label: "duplicate extension", skills: [], extensions: ["pi-d-subagents", "pi-d-subagents"] },
]) test(`invalid capability selection rejects the entire batch before admission: ${invalid.label}`, async () => {
  const f = await fixture((transcript) => toolResults(transcript).length ? fauxAssistantMessage("Rejected.") : call("delegate", { tasks: [task("valid"), task("invalid", invalid.skills, invalid.extensions)] }));
  const disabled = defineExtension({ name: "disabled", tools: [probe("disabled_probe")] }); f.registry.install(disabled);
  try {
    await skill(f.directory, "code-review", "Valid skill."); await f.root.configure({ extensions: { remove: [disabled] } }, context);
    await f.ask(); assert.equal(await f.harness.snapshot(Jobs, f.root.id, context), undefined);
    assert((await f.root.context(context)).messages.some((message) => message.role === "toolResult" && message.isError));
    const children = await f.harness.commit((tx) => tx.scanConversations({ ownerConversationId: f.root.id }, 10), context); assert.equal(children.items.length, 0);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { await f.close(); }
});

test("skills require the parent's enabled catalog, and an unreadable assigned file never admits a job", async () => {
  for (const unavailable of ["catalog", "file"]) {
    const f = await fixture((transcript) => toolResults(transcript).length ? fauxAssistantMessage("Rejected.") : call("delegate", { tasks: [task("A", ["code-review"])] }));
    try {
      if (unavailable === "catalog") await f.root.configure({ extensions: { remove: [f.registry.snapshot().extension("pi-d-prompt")!] } }, context);
      else f.resources.skills = async () => ({ skills: [{ name: "code-review", description: "Missing file fixture", filePath: join(f.directory, "deleted.md"), disableModelInvocation: false }], diagnostics: [] });
      await f.ask(); assert.equal(await f.harness.snapshot(Jobs, f.root.id, context), undefined);
      assert.match(JSON.stringify((await f.root.context(context)).messages.filter((message) => message.role === "toolResult")), unavailable === "catalog" ? /no skill catalog/ : /cannot be read/);
    } finally { await f.close(); }
  }
});

test("selected extensions retain parent tool/model/caller filters; deferred loading cannot enable unassigned tools or orchestration", { timeout: 10000 }, async () => {
  const executed: string[] = [];
  const visible = probe("visible_probe", () => executed.push("visible")), hidden = probe("hidden_probe"), forbidden = probe("forbidden_probe", () => executed.push("FORBIDDEN"));
  const deferred = { ...probe("deferred_probe", () => executed.push("deferred")), deferred: true as const };
  const toolsOnly = probe("tools_only_wrap", () => executed.push("tools-only"));
  const search = defineTool({ name: "search_probe", parameters: Type.Object({}), description: "Load assigned deferred tools", replay: "safe", async execute(_args, api, ctx) {
    const nested = await api.executeTool("visible_probe", {}, ctx); assert(nested.isError, "The parent's model-only wrapper must not gain nested access when unassigned.");
    assert.equal((await api.executeTool("tools_only_wrap", {}, ctx)).isError, false);
    return { output: [{ type: "text", text: "Loaded assigned tools." }], control: { addTools: ["deferred_probe", "tools_only_wrap", "forbidden_probe", "delegate", "agent_stop", "agent_results", "agent_message"] } };
  } });
  const f = await fixture((transcript) => {
    if (!workerName(transcript)) return toolResults(transcript).length ? fauxAssistantMessage("Started.") : call("delegate", { tasks: [task("filtered", [], ["filtered", "pi-d-subagents"])] });
    const count = toolResults(transcript).length;
    if (!count) return call("search_probe");
    if (count === 1) return call("deferred_probe");
    if (count === 2) return call("visible_probe");
    if (count === 3) return call("delegate", { tasks: [task("nested")] });
    if (count === 4) return call("forbidden_probe");
    if (count === 5) return call("tools_only_wrap");
    return fauxAssistantMessage("Filtered tools verified.");
  });
  f.registry.install(defineExtension({ name: "filtered", tools: [visible, hidden, forbidden, deferred, search, toolsOnly] }));
  f.registry.install(defineExtension({ name: "parent-caller-filter", wraps: [wrapTool(visible, (tool) => ({ ...tool, callers: ["model"] })), wrapTool(toolsOnly, (tool) => ({ ...tool, callers: ["tools"] }))] }));
  try {
    await f.root.configure({ tools: { remove: [forbidden] }, modelTools: { remove: [hidden] } }, context);
    await f.ask(); const saved = await f.latest(), view = resultView(saved.job, saved.workers); assert.equal(view.status, "completed");
    const child = await f.harness.conversation(view.workers[0].conversationId!, context); assert(child);
    const agent = await child.agent(context), offered = agent.tools.map((tool) => tool.name);
    assert(offered.includes("deferred_probe")); assert(!offered.includes("hidden_probe")); assert(!offered.includes("forbidden_probe"));
    assert(!offered.some((name) => ["delegate", "agent_stop", "agent_results", "agent_message", "tools_only_wrap"].includes(name))); assert.deepEqual(executed, ["tools-only", "deferred", "visible"]);
    const results = (await child.context(context)).messages.filter((message) => message.role === "toolResult"); assert.equal(results.length, 6); assert(results.slice(-3).every((result) => result.isError));
    assert.equal((await f.harness.snapshot(Jobs, f.root.id, context))!.recent.length, 1);
  } finally { await f.close(); }
});

test("assigned mixed extensions keep their native tools headless while UI callbacks remain main-only", { timeout: 10000 }, async () => {
  const footers: number[] = [], commands: number[] = [];
  const f = await fixture((transcript) => workerName(transcript) ? toolResults(transcript).length ? fauxAssistantMessage("Worker complete.") : call("mixed_probe")
    : toolResults(transcript).length ? fauxAssistantMessage("Started.") : call("delegate", { tasks: [task("A", [], ["mixed"])] }));
  f.registry.install(defineChatExtension({ name: "mixed", tools: [probe("mixed_probe")], piD: {
    footer: (api) => { footers.push(api.conversation.id); return [{ text: "main-only UI" }]; },
    commands: [{ name: "mixed-local", description: "Main-only command", execute: (_argument, api) => { commands.push(api.conversation.id); api.message("MAIN-ONLY-MESSAGE"); } }],
  } }));
  const terminal = new TestTerminal(110, 30), chat: ChatHandle = { harness: f.harness, conversation: f.root, models: f.models, label: "assigned UI", close: () => f.harness.close(context) };
  chat.command = chatCommands(chat, f.models); const app = await mountChat(chat, terminal, false);
  try {
    await f.ask(); const saved = await f.latest(); assert.equal(resultView(saved.job, saved.workers).status, "completed"); await terminal.flush();
    await until(() => footers.length > 0); assert(footers.every((id) => id === f.root.id)); assert.deepEqual(commands, []);
    const calls = f.faux.state.callCount; app.ui.composer.editor.setText("/mixed-local"); terminal.send("\r"); await terminal.flush(); await until(() => !app.ui.busy);
    assert.deepEqual(commands, [f.root.id]); assert.equal(f.faux.state.callCount, calls);
    assert(!JSON.stringify(await f.root.context(context)).includes("MAIN-ONLY-MESSAGE"));
    app.ui.composer.editor.setText("/agent-show"); terminal.send("\r"); await terminal.flush(); await until(() => !app.ui.busy);
    assert.match(app.ui.transcript.render(106).join("\n"), /Skills: none · Extensions: mixed/); assert.equal(f.faux.state.callCount, calls);
  } finally { await app.close(); terminal.dispose(); await f.close(); }
});

for (const cut of ["job admission", "child submission"] as const) test(`SQLite ${cut} recovery preserves explicit assignments and skill contents, without re-reading changed skills or duplicating work`, { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-assigned-recovery-"))), path = join(directory, "session.sqlite");
  const original = await openNodeSqliteStorage(path); let tripped = false;
  const storage: Storage = new Proxy(original, { get(target, key) {
    if (key === "commit") return async (writes: readonly StorageWrite[], ctx: typeof context) => {
      const seq = await target.commit(writes, ctx);
      if (!tripped && writes.some((write) => cut === "job admission" ? write.type === "task" && write.value.kind === JOB_KIND && write.value.state.status === "pending"
        : write.type === "submission" && write.value.conversationId !== ROOT_CONVERSATION_ID && write.value.status === "placed")) {
        tripped = true; throw new Error("Lost assignment commit acknowledgement.");
      }
      return seq;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const respond: FauxResponseFactory = (transcript) => {
    if (!workerName(transcript)) return toolResults(transcript).length ? fauxAssistantMessage("Acknowledged.") : call("delegate", { tasks: [task("A", ["code-review"], ["assigned-ext"])] });
    const text = JSON.stringify(transcript); assert.match(text, /ORIGINAL-ASSIGNED-SKILL/); assert(!text.includes("MUTATED-SKILL"));
    return toolResults(transcript).length ? fauxAssistantMessage("Recovered assigned report.") : call("assigned_probe");
  };
  let f = await fixture(respond, { directory, storage }); f.registry.install(defineExtension({ name: "assigned-ext", tools: [probe("assigned_probe")] }));
  try {
    await skill(directory, "code-review", "ORIGINAL-ASSIGNED-SKILL");
    const submitted = await f.root.submit({ type: "input", content: "Save explicit assignments.", requestId: "assigned-parent" }, context), waiting = submitted.wait(context).catch(() => undefined);
    await until(() => tripped); await f.harness.closed; await waiting;
    await skill(directory, "code-review", "MUTATED-SKILL"); const reopened = await openNodeSqliteStorage(path);
    f = await fixture(respond, { directory, storage: reopened }); f.registry.install(defineExtension({ name: "assigned-ext", tools: [probe("assigned_probe")] }));
    const same = await f.root.submit({ type: "input", content: "Save explicit assignments.", requestId: "assigned-parent" }, context); assert.equal(same.id, submitted.id); await same.wait(context);
    const saved = await f.latest(), view = resultView(saved.job, saved.workers); assert.equal(view.status, "completed"); assert.equal(view.workers[0].report, "Recovered assigned report.");
    assert.deepEqual(saved.job.input.tasks[0].capabilities!.extensions, ["assigned-ext"]); assert.match(saved.job.input.tasks[0].capabilities!.skills[0].content, /ORIGINAL-ASSIGNED-SKILL/);
    assert.equal((await reopened.scanTasks({ kind: JOB_KIND }, 10, undefined, context)).items.length, 1);
    assert.equal((await reopened.scanTasks({ kind: WORKER_KIND }, 10, undefined, context)).items.length, 1);
    assert.equal((await reopened.scanSubmissions({ conversationId: view.workers[0].conversationId }, 10, undefined, context)).items.length, 1);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test("host recovery pauses for missing assigned extension code and restoring it resumes the same worker", { timeout: 15000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d-assigned-readiness-"))), path = join(directory, "session.sqlite"), hold = Promise.withResolvers<void>(); let reached = false;
  const first = testModels({ responses: Array.from({ length: 10 }, () => async (transcript, options) => {
    if (workerName(transcript)) { reached = true; await gate(hold.promise, options?.signal); return fauxAssistantMessage("Late original worker."); }
    return toolResults(transcript).length ? fauxAssistantMessage("Started.") : call("delegate", { tasks: [task("A", [], ["required-assigned"])] });
  }) });
  const registry = await codingRegistry(new Resources(join(directory, "config"), [], directory));
  const required = defineExtension({ name: "required-assigned", tools: [probe("required_probe")] }); registry.install(required);
  const env = ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? directory });
  let chat = await openPersistentChat(path, first.models, { defaults: { model }, cwd: directory, registry, env, onLockLost: lockLost });
  try {
    const submitted = await chat.conversation.submit({ type: "input", content: "Start assigned work." }, context); assert.equal((await submitted.wait(context)).status, "done"); await until(() => reached);
    const jobId = (await chat.harness.snapshot(Jobs, chat.conversation.id, context))!.recent[0]; await chat.close();
    const without = await codingRegistry(new Resources(join(directory, "config"), [], directory));
    const second = testModels({ responses: [fauxAssistantMessage("Recovered with assigned code.")] });
    chat = await openPersistentChat(path, second.models, { registry: without, env, onLockLost: lockLost });
    await assert.rejects(requireRecoveryReady(chat), /required-assigned/); assert.equal(second.faux.state.callCount, 0); assert.equal((await chat.harness.inspect(context)).scheduling, "paused"); await chat.close();
    without.install(required); chat = await openPersistentChat(path, second.models, { registry: without, env, onLockLost: lockLost });
    await requireRecoveryReady(chat); chat.harness.resume(); await chat.harness.waitForTask(jobId, context);
    const saved = await readJob(chat.harness, chat.conversation.id, jobId, context); assert.equal(resultView(saved.job, saved.workers).status, "completed");
    assert.equal(saved.workers.length, 1); assert.equal(second.faux.state.callCount, 1); assert.equal((await chat.harness.snapshot(Jobs, chat.conversation.id, context))!.recent.length, 1);
  } finally { hold.resolve(); await chat.close(); await rm(directory, { recursive: true, force: true }); }
});

test("explicitly assigned extension work remains nonblocking and cancellable by the orchestrator", { timeout: 10000 }, async () => {
  const hold = Promise.withResolvers<void>(); let started = false, stopped = false;
  const wait = defineTool({ name: "assigned_wait", description: "Cooperative fixture tool", parameters: Type.Object({}), async execute(_args, _api, ctx) {
    started = true; try { await gate(hold.promise, ctx.abortSignal); return { output: [{ type: "text" as const, text: "Late result." }] }; } finally { stopped = true; }
  } });
  const f = await fixture((transcript) => {
    if (workerName(transcript)) return call("assigned_wait");
    if (toolResults(transcript).at(-1)?.toolName === "agent_stop") return fauxAssistantMessage("Cancellation requested.");
    if (JSON.stringify(transcript.messages).includes("STOP-ASSIGNED")) return call("agent_stop");
    return toolResults(transcript).length ? fauxAssistantMessage("Main control retained.") : call("delegate", { tasks: [task("A", [], ["assigned-wait"])] });
  }); f.registry.install(defineExtension({ name: "assigned-wait", tools: [wait] }));
  try {
    await f.ask(); await until(() => started); await f.ask("STOP-ASSIGNED"); const saved = await f.latest();
    assert.equal(resultView(saved.job, saved.workers).status, "aborted"); assert(stopped); assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  } finally { hold.resolve(); await f.close(); }
});
