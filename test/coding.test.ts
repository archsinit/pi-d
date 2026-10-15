import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { mountChat } from "../src/chat.ts";
import { codingEnv, codingRegistry, workspacePath } from "../src/coding.ts";
import { Resources } from "../src/resources.ts";
import { openPersistentChat } from "../src/session.ts";
import { lockLost, model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;
const call = (name: string, args: Record<string, string | { oldText: string; newText: string }[]>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function waitForToolOutput(chat: Awaited<ReturnType<typeof openPersistentChat>>, terminal: TestTerminal, marker: string) {
  for (let i = 0; i < 100; i++) {
    const live = await chat.harness.snapshot(LiveDoc, chat.conversation.id, context);
    if (live?.tools?.some((tool) => tool.output?.includes(marker))) { await terminal.flush(); return; }
    await terminal.flush();
  }
  assert.fail(`Timed out waiting for committed tool output: ${marker}`);
}

test("actual stock coding tools edit a temporary workspace and show committed live output and tool failures", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-coding-"));
  const cwd = await workspacePath(directory);
  const resources = new Resources(join(directory, "config"), [], directory);
  const registry = await codingRegistry(resources);
  const { models } = testModels({ responses: [
    call("write", { path: "note.txt", content: "before\n" }),
    call("edit", { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] }),
    call("read", { path: "note.txt" }),
    call("bash", { command: "printf 'COMMITTED-LIVE-TOOL-OUTPUT\\n'; sleep 0.6; printf 'BASH-COMPLETED\\n'" }),
    call("read", { path: "missing.txt" }), fauxAssistantMessage("Finished tool verification."),
  ] });
  const chat = await openPersistentChat(join(directory, "chat.sqlite"), models, { defaults: { model }, registry, env: codingEnv, defaultCwd: cwd, onLockLost: lockLost });
  const terminal = new TestTerminal(100, 30), app = await mountChat(chat, terminal, false);
  try {
    assert.deepEqual((await chat.conversation.agent(context)).tools.map((tool) => tool.name), ["read", "write", "edit", "bash"]);
    terminal.send("Inspect and update the fixture."); terminal.send("\r");
    await waitForToolOutput(chat, terminal, "COMMITTED-LIVE-TOOL-OUTPUT");
    assert.match(terminal.text(), /COMMITTED-LIVE-TOOL-OUTPUT/);
    assert.match(terminal.text(), /executing/); assert(app.ui.busy);
    await chat.conversation.waitForIdle(context); await terminal.flush();
    assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "after\n");
    const messages = (await chat.conversation.context(context)).messages;
    const results = messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 5); assert(results.at(-1)?.isError);
    assert.match(JSON.stringify(results), /BASH-COMPLETED/);
    assert.match(JSON.stringify(results), /after/);
    assert.match(terminal.text(), /tool failed/); assert.equal(app.ui.unavailable, false); assert.equal(app.ui.busy, false);
    const system = JSON.stringify(messages.filter((message) => message.role === "system"));
    assert.match(system, /expert coding assistant/); assert.match(system, /Use edit for precise changes/); assert(system.includes(cwd));
  } finally { await app.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("global TypeScript extensions import the host SDK, deduplicate explicit paths and execute through native tools across reopen", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-extension-")), extensionPath = join(directory, "outside extension.ts");
  await writeFile(extensionPath, `import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { fauxText } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
export default defineExtension({ name: "fixture-extension", hooks: [hook(GenerationTask, { beforeRequest: async ({ messages }) => ({ messages: [...messages, { role: "user", content: "EXTENSION HOOK INSTRUCTIONS", timestamp: 0 }] }) })], sections: [section("fixture_instructions", () => "EXTENSION SYSTEM INSTRUCTIONS")], tools: [defineTool({ name: "fixture_tool", description: "Fixture tool", parameters: Type.Object({}), execute: async (_args, api) => ({ output: [fauxText("EXTENSION RESULT " + (await api.agent(BACKGROUND_CONTEXT)).cwd)] }) })] });`);
  const resources = new Resources(join(directory, "config"), [], directory), cwd = await workspacePath(directory);
  await mkdir(join(resources.configDir, "extensions"), { recursive: true });
  await symlink(extensionPath, join(resources.configDir, "extensions", "fixture.ts"));
  const { models } = testModels({ responses: [0, 1, 2, 3].map((index) => async (transcript) => {
    assert.match(JSON.stringify(transcript.messages), /EXTENSION HOOK INSTRUCTIONS/);
    return index % 2 === 0 ? call("fixture_tool", {}) : fauxAssistantMessage("Done.");
  }) });
  let chat: Awaited<ReturnType<typeof openPersistentChat>> | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const registry = await codingRegistry(resources, await resources.extensionPaths(i === 0 ? [extensionPath] : []));
      chat = await openPersistentChat(join(directory, "session.sqlite"), models, { defaults: { model }, registry, env: codingEnv, defaultCwd: cwd, onLockLost: lockLost });
      chat.harness.resume();
      const input = await chat.conversation.submit({ type: "input", content: "Use the extension." }, context);
      assert.equal((await input.wait(context)).status, "done");
      const messages = (await chat.conversation.context(context)).messages;
      assert.match(JSON.stringify(messages), /EXTENSION SYSTEM INSTRUCTIONS/);
      assert.match(JSON.stringify(messages.filter((message) => message.role === "toolResult")), /EXTENSION RESULT/);
      await chat.close(); chat = undefined;
    }
    await writeFile(join(directory, "pi-factory.ts"), "export default function (pi: unknown) {};");
    await assert.rejects(codingRegistry(resources, [join(directory, "pi-factory.ts")]), /Durable Extension object/);
    await assert.rejects(codingRegistry(resources, [extensionPath, extensionPath]), /Duplicate/);
    await writeFile(join(directory, "reserved.mjs"), 'export default { name: "pi-d-prompt" };');
    await assert.rejects(codingRegistry(resources, [join(directory, "reserved.mjs")]), /reserved/);
    await mkdir(join(directory, "invalid-workspace"));
    await assert.rejects(workspacePath(extensionPath), /must be a directory/);
  } finally { await chat?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("saved workspaces survive caller defaults and thinking is retained during an idle cwd-only change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-workspace-"));
  const first = join(directory, "first"), second = join(directory, "second"), file = join(directory, "chat.sqlite");
  await mkdir(first); await mkdir(second);
  const { models } = testModels({ models: [{ id: "faux-1", reasoning: true }] });
  let chat: Awaited<ReturnType<typeof openPersistentChat>> | undefined;
  try {
    chat = await openPersistentChat(file, models, { defaults: { model, thinkingLevel: "high" }, onLockLost: lockLost }); await chat.close();
    await assert.rejects(openPersistentChat(file, models, { defaultCwd: first, thinkingLevel: "max", onLockLost: lockLost }), /does not support max/);
    chat = await openPersistentChat(file, models, { onLockLost: lockLost });
    assert.equal((await chat.conversation.agent(context)).cwd, undefined, "Invalid overrides must not bind even an older workspace-less session."); await chat.close();
    chat = await openPersistentChat(file, models, { defaults: { model, thinkingLevel: "high" }, defaultCwd: first, onLockLost: lockLost });
    assert.equal((await chat.conversation.agent(context)).cwd, first); await chat.close();
    chat = await openPersistentChat(file, models, { defaults: { model }, defaultCwd: second, onLockLost: lockLost });
    assert.equal((await chat.conversation.agent(context)).cwd, first); await chat.close();
    chat = await openPersistentChat(file, models, { cwd: second, onLockLost: lockLost });
    assert.equal((await chat.conversation.agent(context)).cwd, second);
    assert.equal((await chat.conversation.agent(context)).thinkingLevel, "high");
  } finally { await chat?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("pausing a running native bash call preserves its effect and reopen reports interruption rather than executing it twice", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-tool-resume-")), cwd = await workspacePath(directory);
  const resources = new Resources(join(directory, "config"), [], directory);
  const { models } = testModels({ responses: [call("bash", { command: "printf 'once\\n' >> effect.txt; printf 'TOOL-ENTERED\\n'; sleep 5" }), fauxAssistantMessage("Recovered interrupted tool.")] });
  const options = { defaults: { model }, registry: await codingRegistry(resources), env: codingEnv, defaultCwd: cwd, onLockLost: lockLost };
  let chat = await openPersistentChat(join(directory, "session.sqlite"), models, options);
  const terminal = new TestTerminal(100, 30), app = await mountChat(chat, terminal, false);
  try {
    terminal.send("Perform the fixture call."); terminal.send("\r");
    await waitForToolOutput(chat, terminal, "TOOL-ENTERED");
    assert.match(terminal.text(), /TOOL-ENTERED/);
    await app.close();
    assert.equal(await readFile(join(directory, "effect.txt"), "utf8"), "once\n");
    chat = await openPersistentChat(join(directory, "session.sqlite"), models, options);
    chat.harness.resume(); await chat.conversation.waitForIdle(context);
    assert.equal(await readFile(join(directory, "effect.txt"), "utf8"), "once\n");
    assert.match(JSON.stringify((await chat.conversation.context(context)).messages.filter((message) => message.role === "toolResult")), /interrupted/);
  } finally { await app.close(); await chat.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});
