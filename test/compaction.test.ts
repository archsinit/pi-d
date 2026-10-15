import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  CompactionEntry, createRegistry, DEFAULT_COMPACTION_POLICY, Harness, LiveDoc, MemoryStorage,
} from "@earendil-works/pi-durable";
import { mountChat } from "../src/chat.ts";
import { codingEnv, codingRegistry } from "../src/coding.ts";
import { chatCommands } from "../src/commands.ts";
import { Resources } from "../src/resources.ts";
import { model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;

test("native background compaction overlaps chat, keeps the composer usable, places a summary, and restores system sections", { timeout: 10000 }, async () => {
  assert.equal(DEFAULT_COMPACTION_POLICY.enabled, true);
  assert.equal(DEFAULT_COMPACTION_POLICY.backgroundTokens, 32768);
  const directory = await mkdtemp(join(tmpdir(), "pi-d-compaction-agents-"));
  const agents = join(directory, "AGENTS.md");
  await writeFile(agents, "AGENTS-V1: keep the project context.");
  const gate = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
  const requests: TranscriptContext[] = [];
  const { models } = testModels({ models: [{ id: "faux-1", contextWindow: 8000, maxTokens: 1000 }],
    responses: Array.from({ length: 12 }, () => async (transcript) => {
      const first = transcript.messages[0];
      if (first?.role === "system" && typeof first.content === "string" && first.content.includes("summarization assistant")) {
        reached.resolve(); await gate.promise;
        return fauxAssistantMessage("## Goal\nKeep the project context.\n## Progress\nBackground summary completed.");
      }
      requests.push(transcript);
      return fauxAssistantMessage("Answer. " + "x".repeat(600));
    }),
  });
  const compaction = { enabled: false, reserveTokens: 1000, keepRecentTokens: 100, backgroundTokens: 5000 };
  const registry = await codingRegistry(new Resources(join(directory, "config"), [], directory));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: codingEnv, settings: { compaction } }, context);
  const conversation = await harness.root(context, { agent: { model, cwd: directory } });
  const terminal = new TestTerminal(80, 24);
  const app = await mountChat({ harness, conversation, label: "offline", close: () => harness.close(context) }, terminal, false);
  const ask = async (content: string) => {
    const input = await conversation.submit({ type: "input", content, whenBusy: "reject" }, context);
    assert.equal((await input.wait(context)).status, "done");
  };
  try {
    for (let i = 0; i < 4; i++) await ask(`History ${i}. ` + "h".repeat(600));
    await terminal.flush();
    app.ui.addExtensionMessage("fixture /notice", "LOCAL-COMPACTION-MESSAGE");
    app.ui.addExtensionToast("fixture /notice", "LOCAL-COMPACTION-TOAST", { timeoutMs: 0 });
    compaction.enabled = true;
    await ask("Start background summarization."); await reached.promise; await terminal.flush();
    const live = await harness.snapshot(LiveDoc, conversation.id, context);
    assert.equal(live?.run, undefined);
    const pending = live?.compactions?.[0]; assert(pending); assert.equal(pending.blocking, false);
    const task = await harness.getTask(pending.taskId, context); assert.equal(task?.background, true);
    assert.equal(app.ui.busy, false, "Background work must not block the next prompt.");
    assert.equal(app.ui.composer.editor.disableSubmit, false);
    const commands = chatCommands({ harness, conversation, label: "offline", close: () => harness.close(context) }, models);
    await assert.rejects(commands("/model faux/faux-1", app.ui, new AbortController().signal), /Unfinished work/);
    for (const command of ["new", "clear"]) {
      await assert.rejects(commands(`/${command}`, app.ui, new AbortController().signal), /resetting context/);
    }
    await writeFile(agents, "AGENTS-V2: these are the fresh instructions.");
    await ask("Another prompt while the summary is still running.");
    await conversation.abort(context);
    assert.equal((await harness.getTask(pending.taskId, context))?.state.status, "running", "Normal Escape leaves background work alone.");
    gate.resolve();
    const completed = await harness.waitForTask(pending.taskId, context);
    const outcome = completed.state.outcome; assert.equal(outcome.status, "completed");
    assert(outcome.status === "completed" && outcome.result.submissionId);
    const placement = await harness.submission(outcome.result.submissionId, context); assert(placement);
    assert.equal((await placement.wait(context)).status, "done");
    const view = await conversation.context(context); assert(CompactionEntry.is(view.head));
    const stored = await conversation.entries({}, 100, undefined, context);
    assert(stored.items.length > view.entries.length, "Compaction must retain the original stored history.");
    await ask("Continue after compaction.");
    const next = requests.at(-1); assert(next);
    assert.match(JSON.stringify(next.messages), /Background summary completed/);
    const system = JSON.stringify(next.messages.filter((message) => message.role === "system"));
    assert.match(system, /AGENTS-V2/); assert.match(system, /expert coding assistant/); assert(!system.includes("AGENTS-V1"));
    await writeFile(agents, "AGENTS-V3: refreshed before the next request too.");
    await ask("One more request.");
    assert.match(JSON.stringify(requests.at(-1)?.messages.filter((message) => message.role === "system")), /AGENTS-V3/);
    await rm(agents); await ask("After deleting the instructions file.");
    assert(!getCurrentSystemPrompt(requests.at(-1)!.messages).includes("AGENTS-V"), "Deleted instructions must leave the effective prompt, whether native placement emitted a patch or a new baseline.");
    await terminal.flush(); assert.equal(app.ui.busy, false);
    assert.match(app.ui.transcript.render(76).join("\n"), /LOCAL-COMPACTION-MESSAGE/);
    assert.match(terminal.text(), /LOCAL-COMPACTION-TOAST/);
    assert(!JSON.stringify(requests).includes("LOCAL-COMPACTION"));
    assert(!JSON.stringify((await conversation.entries({}, 100, undefined, context)).items).includes("LOCAL-COMPACTION"));
  } finally { gate.resolve(); await app.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("manual compaction blocks submission and a failed summary remains visible without disabling chat", { timeout: 10000 }, async () => {
  const gate = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
  const { models } = testModels({ responses: [fauxAssistantMessage("a".repeat(800)), fauxAssistantMessage("b".repeat(800)), async () => {
    reached.resolve(); await gate.promise;
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Offline summary failure.\nRetry later.\x1b[2J" });
  }] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(),
    settings: { compaction: { enabled: false, keepRecentTokens: 100 }, retry: { enabled: false } } }, context);
  const conversation = await harness.root(context, { agent: { model } });
  const terminal = new TestTerminal(100, 24);
  const app = await mountChat({ harness, conversation, label: "offline", close: () => harness.close(context) }, terminal, false);
  try {
    for (let i = 0; i < 2; i++) {
      const input = await conversation.submit({ type: "input", content: "history ".repeat(100) }, context);
      assert.equal((await input.wait(context)).status, "done");
    }
    const task = await conversation.compact(undefined, context); await reached.promise; await terminal.flush();
    assert(app.ui.busy); assert(app.ui.composer.editor.disableSubmit);
    gate.resolve();
    assert.equal((await harness.waitForTask(task, context)).state.outcome.status, "failed");
    await terminal.flush();
    assert.equal(app.ui.busy, false); assert.equal(app.ui.composer.editor.disableSubmit, false);
    assert.equal(app.ui.unavailable, false);
    assert.match(terminal.text(), /Offline summary failure/);
    assert(app.ui.tui.getScreenLines().every((line) => !line.includes("\n")));
  } finally { gate.resolve(); await app.close(); terminal.dispose(); }
});
