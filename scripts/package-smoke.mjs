import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Verify the distributable, not a symlink back into the checkout. No live auth/model calls.
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-d package-")));
const workspace = join(temporary, "workspace with spaces");
mkdirSync(workspace);
const env = {
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  HOME: join(temporary, "home"), XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"), TMPDIR: temporary,
  TERM: "xterm-256color", COLORTERM: "truecolor",
  // Reuse only the hydration cache; do not read the user's npm credentials/configuration.
  NPM_CONFIG_CACHE: process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? join(homedir(), ".npm"),
  NPM_CONFIG_USERCONFIG: join(temporary, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(temporary, "global-npmrc"),
};
function run(command, args, cwd = workspace) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const extension = join(workspace, "trusted extension.ts");
const verification = `import assert from "node:assert/strict";
import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineChatExtension } from "pi-d-chat/extensions";
import subagents, { createSubagentsExtension, DEFAULT_POLICY } from "pi-d-chat/subagents";
import { codingEnv, codingRegistry } from "./dist/coding.js";
import { executeExtensionCommand, extensionCommands, watchExtensionFooter } from "./dist/extension-ui.js";
import { Resources } from "./dist/resources.js";
import { Jobs } from "./dist/subagents/state.js";
import { readJob, resultView } from "./dist/subagents/view.js";
import { openPersistentChat } from "./dist/session.js";
const [extension, workspace, session, config] = process.argv.slice(2);
const resources = new Resources(config, [], workspace);
const packageSkill = join(config, "skills", "package-review", "SKILL.md");
await mkdir(join(config, "skills", "package-review"), { recursive: true });
await writeFile(packageSkill, ["---", "name: package-review", "description: Packaged assignment fixture", "---", "PACKAGED-ASSIGNED-SKILL"].join(String.fromCharCode(10)));
assert.equal(subagents.name, "pi-d-subagents"); assert.equal(createSubagentsExtension().name, subagents.name); assert.equal(DEFAULT_POLICY.concurrency, null);
const subagentFile = join(workspace, "configured-subagents.ts");
await writeFile(subagentFile, 'import { createSubagentsExtension } from "pi-d-chat/subagents"; export default createSubagentsExtension({ concurrency: 1 });');
await mkdir(join(config, "extensions"), { recursive: true });
await symlink(extension, join(config, "extensions", "install-probe.ts"));
const registry = await codingRegistry(resources, await resources.extensionPaths([extension, subagentFile]));
const faux = fauxProvider({ tokensPerSecond: 100000 });
faux.appendResponses([fauxAssistantMessage(fauxToolCall("install_probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Verified offline.")]);
const models = createModels(); models.setProvider(faux.provider);
const chat = await openPersistentChat(session, models, { defaults: { model: { provider: "faux", modelId: "faux-1" } }, registry, env: codingEnv, defaultCwd: workspace, onLockLost: (error) => { throw error; } });
const workerGate = Promise.withResolvers(), workerStarted = Promise.withResolvers();
try {
  const installed = registry.snapshot().extension("install-probe");
  assert.equal(defineChatExtension(installed), installed);
  let notice = "", statuses = [], uiMessages = [], toasts = [];
  const ui = {
    setNotice: (text) => { notice = text; }, setExtensionStatus: (items) => { statuses = items; },
    addExtensionMessage: (...args) => { uiMessages.push(args); }, addExtensionToast: (...args) => { toasts.push(args); },
  };
  const signal = new AbortController().signal;
  const commands = await extensionCommands(chat, signal);
  assert(commands.some((command) => command.name === "install-local"));
  assert.deepEqual(await commands.find((command) => command.name === "install-local").getArgumentCompletions("o"), [{ value: "ok", label: "ok", description: undefined }]);
  assert(await executeExtensionCommand(chat, "install-local", "ok", ui, signal));
  assert.equal(notice, "INSTALLED-COMMAND-OK ok");
  assert.deepEqual(uiMessages, [["install-probe /install-local", "INSTALLED-MESSAGE-OK", { type: "success" }]]);
  assert.deepEqual(toasts, [["install-probe /install-local", "INSTALLED-TOAST-OK", { timeoutMs: 0 }]]);
  assert.equal(faux.state.callCount, 0);
  assert.equal((await chat.conversation.context(context)).entries.length, 0);
  const footer = watchExtensionFooter(chat, ui, (error) => { throw error; });
  try { await footer.refresh(); assert.equal(statuses[0].text, "INSTALLED-FOOTER-OK"); }
  finally { await footer.stop(); }
  await access(new URL("./dist/extensions.d.ts", import.meta.url));
  const input = await chat.conversation.submit({ type: "input", content: "Test the installed extension." }, context);
  const receipt = await input.wait(context);
  const messages = (await chat.conversation.context(context)).messages;
  assert.equal(receipt.status, "done", JSON.stringify({ receipt, messages }));
  assert.match(JSON.stringify(messages.filter((message) => message.role === "toolResult")), /INSTALLED-EXTENSION-OK/);
  assert.match(JSON.stringify(messages), /INSTALLED-SECTION-OK/);
  assert.equal((await chat.conversation.agent(context)).cwd, workspace);
  await access(new URL("./docs/extensions.md", import.meta.url));
  await access(new URL("./docs/subagents.md", import.meta.url));
  await access(new URL("./dist/subagents/index.d.ts", import.meta.url));
  assert((await chat.conversation.agent(context)).tools.some((tool) => tool.name === "agent_message"));
  faux.appendResponses(Array.from({ length: 14 }, () => async (transcript) => {
    const user = JSON.stringify(transcript.messages.filter((message) => message.role === "user"));
    if (user.includes("Assignment: Package reviewer")) {
      assert.match(JSON.stringify(transcript), /PACKAGED-ASSIGNED-SKILL/); assert.match(JSON.stringify(transcript), /INSTALLED-SECTION-OK/);
      if (transcript.messages.some((message) => message.role === "toolResult")) {
        assert(user.includes("PACKAGED-WORKER-MESSAGE")); return fauxAssistantMessage("PACKAGED-MESSAGE-REPORT");
      }
      workerStarted.resolve(); await workerGate.promise;
      return fauxAssistantMessage(fauxToolCall("install_probe", {}), { stopReason: "toolUse" });
    }
    if (user.includes("Assignment: Package baseline")) {
      assert(!JSON.stringify(transcript).includes("PACKAGED-ASSIGNED-SKILL")); assert(!JSON.stringify(transcript).includes("INSTALLED-SECTION-OK"));
      return fauxAssistantMessage("PACKAGED-BASELINE-REPORT");
    }
    if (transcript.messages.filter((message) => message.role !== "system").at(-1)?.role === "toolResult") return fauxAssistantMessage("Verified compiled orchestration.");
    if (user.includes("Queue packaged message.")) return fauxAssistantMessage(fauxToolCall("agent_message", { jobId, worker: 1, message: "PACKAGED-WORKER-MESSAGE" }), { stopReason: "toolUse" });
    return fauxAssistantMessage(fauxToolCall("delegate", { tasks: [
        { name: "Package reviewer", task: "Give an offline fixture report.", role: "reviewer", skills: ["package-review"], extensions: ["install-probe"] },
        { name: "Package baseline", task: "Report without additional capabilities." },
      ] }), { stopReason: "toolUse" });
  }));
  const delegated = await chat.conversation.submit({ type: "input", content: "Verify packaged subagents." }, context);
  assert.equal((await delegated.wait(context)).status, "done");
  const jobId = (await chat.harness.snapshot(Jobs, chat.conversation.id, context)).recent.at(-1);
  await workerStarted.promise;
  const sent = await chat.conversation.submit({ type: "input", content: "Queue packaged message." }, context);
  assert.equal((await sent.wait(context)).status, "done");
  const messageResult = (await chat.conversation.context(context)).messages.find((message) => message.role === "toolResult" && message.toolName === "agent_message");
  assert(!messageResult.isError); const ack = messageResult.details;
  assert.equal(ack.status, "queued"); assert.equal(ack.mode, "steer"); assert.match(ack.requestId, /^subagent-message:/);
  assert.equal((await chat.harness.commit((tx) => tx.submissionByRequest(ack.conversationId, ack.requestId), context)).status, "queued");
  const running = await readJob(chat.harness, chat.conversation.id, jobId, context); assert.equal(resultView(running.job, running.workers).status, "running");
  workerGate.resolve(); await chat.harness.waitForTask(jobId, context);
  const saved = await readJob(chat.harness, chat.conversation.id, jobId, context), view = resultView(saved.job, saved.workers);
  assert.equal(view.status, "completed"); assert.equal(view.workers[0].report, "PACKAGED-MESSAGE-REPORT"); assert.equal(view.workers[1].report, "PACKAGED-BASELINE-REPORT");
  const children = await chat.harness.commit((tx) => tx.scanConversations({ ownerConversationId: chat.conversation.id }, 10), context);
  assert.equal(children.items.length, 2);
  for (const [index, result] of view.workers.entries()) {
    const worker = await chat.harness.conversation(result.conversationId, context), agent = await worker.agent(context);
    assert.deepEqual(agent.tools.map((tool) => tool.name).sort(), index === 0 ? ["bash", "edit", "install_probe", "read", "write"] : ["bash", "edit", "read", "write"]);
    assert.deepEqual(agent.extensions.map((extension) => extension.name).sort(), index === 0 ? ["install-probe", "pi-d-prompt", "pi-d-subagents"] : ["pi-d-prompt", "pi-d-subagents"]);
    assert.equal(saved.job.input.tasks[index].capabilities.skills.length, index === 0 ? 1 : 0);
    if (index === 0) assert.match(agent.instructions, /assigned reviewer subagent/);
  }
  assert.equal(faux.state.callCount, 9);
  assert.equal((await chat.harness.inspect(context)).tasks.length, 0);
} finally { workerGate.resolve(); await chat.close(); }
`;
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root))[0];
  const files = packed.files.map((file) => file.path).sort();
  const expected = ["README.md", "LICENSE", "NOTICE", "package.json", "npm-shrinkwrap.json", "bin/pi-d.mjs", "bin/pi-d-subagents.mjs", "docs/comparison.md", "docs/extensions.md", "docs/subagents.md", "docs/usage.md", "docs/preview.svg",
    ...readdirSync(join(root, "src"), { recursive: true }).filter((file) => file.endsWith(".ts")).flatMap((file) => [".js", ".d.ts"].map((extension) => `dist/${file.replace(/\.ts$/, extension)}`)),
    ...readdirSync(join(root, "licenses")).map((file) => `licenses/${file}`)].sort();
  assert.deepEqual(files, expected, "Package only runtime JavaScript, documentation, notices and the pinned dependency closure.");
  const archive = join(temporary, packed.filename);
  const lock = JSON.parse(readFileSync(join(root, "npm-shrinkwrap.json"), "utf8"));
  const pinned = new Set(Object.entries(lock.packages).map(([path, pkg]) => `${path.split("node_modules/").at(-1)}@${pkg.version}`));
  const checkVersions = (tree) => {
    for (const [name, pkg] of Object.entries(tree.dependencies ?? {})) {
      if (name !== packed.name && pkg.version) assert(pinned.has(`${name}@${pkg.version}`), `Unreviewed installed dependency: ${name}@${pkg.version}`);
      checkVersions(pkg);
    }
  };
  writeFileSync(extension, `import { defineChatExtension } from "pi-d-chat/extensions";
import { defineTool, section } from "@earendil-works/pi-durable";
import { Type as AIType } from "@earendil-works/pi-ai";
import { fauxText } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
export default defineChatExtension({ name: "install-probe", piD: {
  commands: [{ name: "install-local", description: "Local installation probe", complete: () => [{ value: "ok", label: "ok" }], execute: (argument, api) => {
    api.notify("INSTALLED-COMMAND-OK " + argument);
    api.message("INSTALLED-MESSAGE-OK", { type: "success" }); api.toast("INSTALLED-TOAST-OK", { timeoutMs: 0 });
  } }],
  footer: () => [{ text: "INSTALLED-FOOTER-OK", tone: "cyan" }],
}, sections: [section("install_probe", () => "INSTALLED-SECTION-OK")], tools: [defineTool({ name: "install_probe", description: "Offline installation probe", parameters: Type.Object({}), execute: async (_args, api) => {
  if (AIType.String !== Type.String || !Value.Check(Type.String(), "ok") || visibleWidth("ok") !== 2) throw new Error("Host SDK resolution failed.");
  return { output: [fauxText("INSTALLED-EXTENSION-OK " + (await api.agent(BACKGROUND_CONTEXT)).cwd)] };
} })] });`);
  for (const global of [false, true]) {
    const prefix = join(temporary, global ? "global" : "consumer");
    mkdirSync(prefix);
    if (!global) writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "isolated-consumer", private: true }));
    run("npm", ["install", ...(global ? ["--global"] : []), "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", archive], prefix);
    checkVersions(JSON.parse(run("npm", ["ls", "--all", "--json", ...(global ? ["--global"] : []), "--prefix", prefix])));
    const installed = join(prefix, global ? "lib/node_modules" : "node_modules", packed.name);
    const launcher = join(prefix, global ? "bin" : "node_modules/.bin", "pi-d");
    assert.match(run(launcher, ["--help"]), /\/new/);
    assert.match(run(launcher, ["--list-models"]), /openai-codex\/gpt-6\.1-sol/);
    assert(!existsSync(env.XDG_CONFIG_HOME)); assert(!existsSync(env.XDG_DATA_HOME));
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.private, true, "GitHub publication must not enable npm registry publishing.");
    assert.equal(manifest.license, "MIT");
    assert.equal(readFileSync(join(installed, "LICENSE"), "utf8"), readFileSync(join(root, "LICENSE"), "utf8"));
    const plan = JSON.parse(run(process.execPath, [join(installed, "bin/pi-d-subagents.mjs"), "--check"]));
    assert.equal(plan.extension, join(installed, "dist/subagents/index.js")); assert(plan.experiment.startsWith(temporary + "/"));
    rmSync(plan.experiment, { recursive: true, force: true });
    const requireEntry = join(installed, "package-verification.mjs");
    writeFileSync(requireEntry, verification);
    run(process.execPath, ["--disable-warning=ExperimentalWarning", requireEntry, extension, workspace, join(workspace, global ? "global.sqlite" : "local.sqlite"), join(workspace, global ? "global-config" : "local-config")]);
    assert(!existsSync(join(workspace, global ? "global.sqlite.lock" : "local.sqlite.lock")));
    // Includes real fullscreen demo, local commands, saved-session/auth gate and terminal restoration.
    run("python3", [join(root, "scripts/terminal-smoke.py"), launcher]);
    run("python3", [join(root, "scripts/subagents-smoke.py"), join(installed, "bin/pi-d-subagents.mjs"), process.execPath]);
    console.log(`Package passed: ${global ? "global-prefix" : "local dependency"} install, launcher, SQLite, external TypeScript extension, compiled subagents/isolated helper and offline PTYs.`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
