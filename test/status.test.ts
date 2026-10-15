import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mountChat, type ChatHandle } from "../src/chat.ts";
import { chatCommands } from "../src/commands.ts";
import { openPersistentChat, readSessionInfo } from "../src/session.ts";
import { LoadedExtensions, requireRecoveryReady, sessionStatus } from "../src/status.ts";
import { lockLost, model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;

test("/status shows session/workspace/local auth and blocked recovery without executing tasks, refreshing tokens or consuming model quota", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-recovery-status-")), file = join(directory, "session.sqlite");
  let calls = 0;
  const task = defineTask<{}, { phase: "run" }, {}>({ name: "fixture.pending", version: 1, initial: () => ({ phase: "run" }),
    phases: { run: async (_task, runtime, taskContext) => { calls++; await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), taskContext); } },
    abort: async (_task, runtime, taskContext) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext); },
  });
  const registry = createRegistry(); registry.install(defineExtension({ name: "fixture-extension", tasks: [task] }));
  const { models, faux } = testModels();
  let chat = await openPersistentChat(file, models, { model, registry, defaultCwd: directory, onLockLost: lockLost });
  let app: Awaited<ReturnType<typeof mountChat>> | undefined;
  const terminal = new TestTerminal(100, 30);
  try {
    await chat.conversation.commit(async (tx) => { await tx.createTask(task, {}, { ownership: { kind: "conversation" } }); }, context);
    await chat.close();
    const metadata = await readSessionInfo(file, lockLost);
    assert.equal(metadata.unfinished, true); assert.equal(metadata.cwd, directory); assert.equal(calls, 0);
    await assert.rejects(openPersistentChat(file, models, { cwd: tmpdir(), onLockLost: lockLost }), /Unfinished work/);
    chat = await openPersistentChat(file, models, { onLockLost: lockLost });
    assert.deepEqual((await chat.harness.snapshot(LoadedExtensions, context))?.names, ["fixture-extension"]);
    chat.beforeModel = () => requireRecoveryReady(chat); chat.command = chatCommands(chat, models);
    app = await mountChat(chat, terminal, false); await terminal.flush();
    assert.equal((await chat.harness.inspect(context)).scheduling, "paused");
    assert.match(terminal.text(), /Recovery is blocked/); assert.equal(calls, 0);
    const status = await sessionStatus(chat, models);
    for (const value of [file, directory, "paused", "fixture-extension", "fixture.pending", "missing_task", "Blocked tasks: 1", "local status only"]) assert(status.includes(value), value);
    assert(!JSON.stringify(await chat.harness.snapshot(LoadedExtensions, context)).includes(".ts"));
    app.ui.composer.editor.setText("/status"); terminal.send("\r"); await terminal.flush(); assert.match(terminal.text(), /Session:/);
    terminal.send("\r"); await terminal.flush();
    assert.equal((await chat.harness.inspect(context)).scheduling, "paused"); assert.equal(faux.state.callCount, 0);
    assert.equal((await chat.conversation.context(context)).messages.length, 0);
    app.ui.composer.editor.setText("/interrupt"); terminal.send("\r");
    for (let i = 0; i < 100 && app.ui.busy; i++) await delay(10);
    assert.equal((await chat.harness.inspect(context)).tasks.length, 0); assert.equal(calls, 0);
  } finally { await app?.close(); await chat.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("active-context footer uses the native estimate, retains reasoning/billing on resize, and falls after reset rather than showing cumulative spend", async () => {
  const { models } = testModels({ models: [{ id: "faux-1", reasoning: true, contextWindow: 8000 }],
    responses: [fauxAssistantMessage("Answer. ".repeat(40))] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings: { compaction: { enabled: false } } }, context);
  const conversation = await harness.root(context, { agent: { model, thinkingLevel: "high" } });
  const chat: ChatHandle = { harness, conversation, models, label: "context", close: () => harness.close(context) };
  const terminal = new TestTerminal(110, 30), app = await mountChat(chat, terminal, false);
  try {
    const input = await conversation.submit({ type: "input", content: "context input ".repeat(90) }, context); await input.wait(context); await terminal.flush();
    const tokens = estimateContextTokens((await conversation.context(context)).messages).tokens;
    assert(tokens > 0);
    for (const width of [110, 80, 40, 160]) {
      terminal.resize(width, 30); await terminal.flush();
      const footer = terminal.text().split("\n").at(-1) ?? "";
      assert.match(footer, /ctx ~/); assert(footer.includes(`${Math.round(tokens / 8000 * 100)}%`));
      assert.match(footer, /· high/); if (width >= 78) assert.match(footer, /~\$/);
      if (width >= 100) assert.match(footer, /\/8K/);
      assert(app.ui.tui.getScreenLines().every((line) => visibleWidth(line) <= width));
    }
    await conversation.reset(undefined, context); await terminal.flush();
    const footer = terminal.text().split("\n").at(-1) ?? "";
    assert.match(footer, /ctx ~0\/8K \(0%\)/); assert.match(footer, /↑/);
    app.ui.setNotice("A notice that should not hide the context meter."); await terminal.flush();
    assert.match(terminal.text().split("\n").at(-1) ?? "", /ctx ~/);
    app.ui.setContextUsage(9000, 8000); await terminal.flush(); assert.match(terminal.text().split("\n").at(-1) ?? "", /113%/);
  } finally { await app.close(); terminal.dispose(); }
});
