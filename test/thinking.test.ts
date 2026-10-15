import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type LiveState } from "@earendil-works/pi-durable";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { mountChat } from "../src/chat.ts";
import { openPersistentChat } from "../src/session.ts";
import { messageText, Transcript } from "../src/transcript.ts";
import { lockLost, model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for incremental thinking.");
}

const rendered = (transcript: Transcript, width = 156) => transcript.render(width).map(stripTerminalSequences).join("\n");

test("thinking stays in content order, while empty blocks, signatures and redacted payloads stay hidden", () => {
  const message = fauxAssistantMessage([
    { ...fauxThinking(""), thinkingSignature: "EMPTY-OPAQUE-SIGNATURE" },
    fauxText("Before thinking."),
    { ...fauxThinking("Visible reasoning summary."), thinkingSignature: "OPAQUE-SIGNATURE" },
    fauxText("Between thinking blocks."),
    { ...fauxThinking("MUST-NOT-DISPLAY"), redacted: true, thinkingSignature: "ENCRYPTED-PAYLOAD" },
    fauxText("Final answer."),
  ]);
  const text = messageText(message);
  assert.equal((text.match(/\*\*Thinking\*\*/g) ?? []).length, 2);
  assert(text.indexOf("Before thinking.") < text.indexOf("Visible reasoning summary."));
  assert(text.indexOf("Visible reasoning summary.") < text.indexOf("Between thinking blocks."));
  assert(text.indexOf("Between thinking blocks.") < text.indexOf("[Reasoning redacted]"));
  assert(text.indexOf("[Reasoning redacted]") < text.indexOf("Final answer."));
  for (const hidden of ["EMPTY-OPAQUE-SIGNATURE", "OPAQUE-SIGNATURE", "MUST-NOT-DISPLAY", "ENCRYPTED-PAYLOAD"]) assert(!text.includes(hidden));
  assert.equal(messageText(fauxAssistantMessage([fauxThinking(""), fauxText("Only an answer.")])), "Only an answer.");
});

test("rendered thinking strips terminal controls and never displays opaque or redacted payloads", async () => {
  const { models } = testModels({ responses: [fauxAssistantMessage([
    { ...fauxThinking("Visible summary.\x1b[2J\x1b]52;c;clipboard-payload\x07"), thinkingSignature: "OPAQUE-SIGNATURE" },
    { ...fauxThinking("MUST-NOT-DISPLAY"), redacted: true, thinkingSignature: "ENCRYPTED-PAYLOAD" },
    fauxText("Final answer."),
  ])] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings: { progress: { partialIntervalMs: 200 } } }, context);
  const conversation = await harness.root(context, { agent: { model } });
  try {
    const input = await conversation.submit({ type: "input", content: "Show only exposed text." }, context);
    assert.equal((await input.wait(context)).status, "done");
    const state = await conversation.viewState(context);
    const transcript = new Transcript(); transcript.view = state.value; state.dispose();
    for (const width of [36, 76, 156]) {
      const lines = transcript.render(width), text = rendered(transcript, width);
      assert.match(text, /Visible summary/); assert.match(text, /Reasoning redacted/); assert.match(text, /Final answer/);
      for (const hidden of ["OPAQUE-SIGNATURE", "MUST-NOT-DISPLAY", "ENCRYPTED-PAYLOAD", "clipboard-payload"]) assert(!text.includes(hidden));
      assert(!lines.join("\n").includes("\x1b[2J")); assert(!lines.join("\n").includes("\x1b]52"));
      assert(lines.every((line) => visibleWidth(line) <= width && !line.includes("\n") && !line.includes("\r")));
    }
  } finally { await harness.close(context); }
});

test("native thinking snapshots grow on screen before the answer, settle once and survive SQLite reopen", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-thinking-stream-")), file = join(directory, "chat.sqlite");
  const thinking = Array.from({ length: 16 }, (_, index) => `Stage-${String(index).padStart(2, "0")}: plan the change. `).join("");
  const answer = "Visible final answer. " + "Done. ".repeat(16);
  const signature = "OPAQUE-THINKING-SIGNATURE";
  const { models, faux } = testModels({ models: [{ id: "faux-1", reasoning: true }], tokensPerSecond: 80, tokenSize: { min: 4, max: 4 },
    responses: [fauxAssistantMessage([{ ...fauxThinking(thinking), thinkingSignature: signature }, fauxText(answer)])] });
  const chat = await openPersistentChat(file, models, { model, thinkingLevel: "high", onLockLost: lockLost });
  const terminal = new TestTerminal(160, 40), app = await mountChat(chat, terminal, false);
  const watch = await chat.conversation.watch(context);
  const snapshots: { thinking: string; rendered: string }[] = [];
  let reopened: Awaited<ReturnType<typeof openPersistentChat>> | undefined;
  watch.start(async (view) => {
    const live = view.docs["pi.live"] as LiveState | undefined;
    const text = live?.generation?.message?.content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("") ?? "";
    if (text.length > (snapshots.at(-1)?.thinking.length ?? 0)) {
      const transcript = new Transcript(); transcript.view = view;
      snapshots.push({ thinking: text, rendered: rendered(transcript) });
    }
  });
  try {
    app.ui.composer.editor.setText("next draft");
    const input = await chat.conversation.submit({ type: "input", content: "Show the exposed reasoning summary as it arrives." }, context);
    await until(() => snapshots.length >= 2); await terminal.flush();
    assert(app.ui.busy); assert.match(terminal.text(), /Thinking/); assert.match(terminal.text(), /Stage-00/);
    assert(!terminal.text().includes("Visible final answer."));
    assert.notEqual(snapshots[0].rendered, snapshots[1].rendered);
    assert.equal((await input.wait(context)).status, "done"); await terminal.flush();
    assert(snapshots.length >= 3, "Several committed partials must appear, not just the completed answer.");
    assert(snapshots[0].thinking.length < thinking.length);
    for (const snapshot of snapshots) {
      assert(thinking.startsWith(snapshot.thinking)); assert.match(snapshot.rendered, /Thinking/);
      assert(!snapshot.rendered.includes(signature));
    }
    const final = rendered(app.ui.transcript);
    assert.match(final, /Stage-15/); assert.match(final, /Visible final answer/);
    assert.equal((final.match(/Thinking/g) ?? []).length, 1);
    assert.equal((final.match(/● Assistant/g) ?? []).length, 1);
    assert(!final.includes(" · live")); assert(!terminal.output.includes(signature));
    assert.equal(app.ui.busy, false); assert.equal(app.ui.composer.editor.getText(), "next draft");
    for (const width of [36, 76, 156]) assert(app.ui.transcript.render(width).every((line) => visibleWidth(line) <= width));
    const stored = (await chat.conversation.context(context)).messages.flatMap((message) => message.role === "assistant" ? message.content : []).find((part) => part.type === "thinking");
    assert.equal(stored?.thinking, thinking); assert.equal(stored?.thinkingSignature, signature, "Rendering must not modify native stored content.");
    await watch.stop(); await app.close();
    reopened = await openPersistentChat(file, models, { onLockLost: lockLost });
    const state = await reopened.conversation.viewState(context);
    const transcript = new Transcript(); transcript.view = state.value; state.dispose();
    assert.match(rendered(transcript), /Stage-15/); assert.match(rendered(transcript), /Visible final answer/);
    assert(!rendered(transcript).includes(signature)); assert.equal(faux.state.callCount, 1);
  } finally { await watch.stop(); await app.close(); await reopened?.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("Escape during thinking retains the committed partial once and preserves the next draft", { timeout: 10000 }, async () => {
  const thinking = "Inspecting the workspace. ".repeat(100);
  const { models } = testModels({ tokensPerSecond: 40, responses: [fauxAssistantMessage([fauxThinking(thinking), fauxText("Unreached answer.")])] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings: { progress: { partialIntervalMs: 200 } } }, context);
  const conversation = await harness.root(context, { agent: { model } });
  const terminal = new TestTerminal(110, 30), app = await mountChat({ harness, conversation, label: "offline", close: () => harness.close(context) }, terminal, false);
  try {
    app.ui.composer.editor.setText("next draft");
    const input = await conversation.submit({ type: "input", content: "Think slowly." }, context);
    await until(() => rendered(app.ui.transcript).includes("Inspecting")); await terminal.flush();
    assert.match(terminal.text(), /Thinking/); assert(app.ui.busy);
    terminal.send("\x1b");
    const receipt = await input.wait(context); assert.equal(receipt.status, "unanswered"); assert.equal(receipt.reason, "aborted");
    await terminal.flush();
    const final = rendered(app.ui.transcript);
    assert.match(final, /Thinking/); assert.match(final, /Inspecting/);
    assert.equal((final.match(/● Assistant/g) ?? []).length, 1);
    assert(!final.includes(" · live")); assert(!final.includes("Unreached answer."));
    assert.equal(app.ui.busy, false); assert.equal(app.ui.composer.editor.getText(), "next draft");
    const assistant = (await conversation.context(context)).entries.flatMap((entry) => entry.model ?? []).find((message) => message.role === "assistant");
    assert.equal(assistant?.stopReason, "aborted");
    const partial = assistant?.content.find((part) => part.type === "thinking");
    assert(partial && partial.thinking.length > 0 && partial.thinking.length < thinking.length);
  } finally { await app.close(); terminal.dispose(); }
});
