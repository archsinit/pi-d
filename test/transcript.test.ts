import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CompactionEntry, createRegistry, defineExtension, defineTool, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ChatUI } from "../src/ui.ts";
import { model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

process.env.COLORTERM = "truecolor";
const context = BACKGROUND_CONTEXT;
async function fixture(options: { gate?: Promise<void>; failed?: boolean; toolOnly?: boolean } = {}) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "transcript-fixture", tools: [defineTool({
    name: "fixture_read", description: "Offline display fixture", parameters: Type.Object({ path: Type.String() }),
    async execute(_args, api) {
      if (options.gate) { api.output("LIVE-OUTPUT-ONLY\n"); await options.gate; }
      return { output: [fauxText("TOOL-OUTPUT-ONLY")], isError: options.failed ?? false };
    },
  })] }));
  const { models } = testModels({ responses: [
    fauxAssistantMessage([...(options.toolOnly ? [] : [fauxText("Before the reasoning."), fauxThinking("Visible planning summary."), fauxText("After the reasoning.")]), fauxToolCall("fixture_read", { path: "src/example.ts" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Final answer stays readable."),
  ] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  const conversation = await harness.root(context, { agent: { model } });
  const input = await conversation.submit({ type: "input", content: "Question from you." }, context);
  return { harness, conversation, input };
}

function cellAt(terminal: TestTerminal, needle: string) {
  const rows = terminal.text().split("\n"), y = rows.findIndex((row) => row.includes(needle));
  assert(y >= 0, `Missing visible text: ${needle}`);
  const x = rows[y].indexOf(needle), cell = terminal.screen.buffer.active.getLine(y)?.getCell(x);
  assert(cell); return { x, y, cell };
}

for (const trueColor of [true, false]) {
  test(`padded user messages, assistant answers and nested reasoning/tools stay distinct in ${trueColor ? "truecolor" : "256 colors"}`, async () => {
    const capabilities = getCapabilities(); setCapabilities({ ...capabilities, trueColor });
    const { harness, conversation, input } = await fixture();
    const terminal = new TestTerminal(100, 40), ui = new ChatUI(terminal, { animate: false });
    try {
      assert.equal((await input.wait(context)).status, "done");
      const state = await conversation.viewState(context); ui.setView(state.value); state.dispose();
      ui.start(); await terminal.flush();
      const user = cellAt(terminal, "❯ You"), question = cellAt(terminal, "Question from you.");
      const assistant = cellAt(terminal, "● Assistant"), answer = cellAt(terminal, "Final answer stays readable.");
      const thinking = cellAt(terminal, "┆ Thinking"), plan = cellAt(terminal, "Visible planning summary.");
      const call = cellAt(terminal, "↳ Tool call · fixture_read"), result = cellAt(terminal, "↳ Tool result · fixture_read");
      const args = cellAt(terminal, '{"path":"src/example.ts"}'), output = cellAt(terminal, "TOOL-OUTPUT-ONLY");
      assert.equal(user.x, 2); assert.equal(question.x, 2); assert(user.cell.isBold());
      assert.equal(assistant.x, 2); assert.equal(answer.x, 2);
      assert.equal(thinking.x, 4); assert.equal(plan.x, 6);
      assert.equal(call.x, 4); assert.equal(result.x, 4); assert.equal(args.x, 6); assert.equal(output.x, 6);
      assert(question.y < thinking.y && thinking.y < call.y && call.y < result.y && result.y < answer.y);
      if (trueColor) {
        assert.equal(user.cell.getFgColor(), 0x74e6fc); assert.equal(user.cell.getBgColor(), 0);
        assert.equal(question.cell.getBgColor(), user.cell.getBgColor());
        assert.equal(answer.cell.getBgColor(), 0); assert.equal(answer.cell.getFgColor(), 0xcccccc);
        assert.equal(plan.cell.getFgColor(), 0x93939c); assert.equal(plan.cell.getBgColor(), 0);
        assert.equal(call.cell.getFgColor(), 0xb0a9de); assert.equal(result.cell.getFgColor(), 0xb0a9de);
      } else {
        assert(user.cell.isBgPalette()); assert.equal(user.cell.getBgColor(), 16);
        assert.equal(question.cell.getBgColor(), user.cell.getBgColor()); assert.equal(answer.cell.getBgColor(), 16);
      }
      const assertUserPadding = () => {
        const heading = cellAt(terminal, "❯ You"), body = cellAt(terminal, "Question from you.");
        for (const y of [heading.y - 1, body.y + 1, heading.y - 2, body.y + 2]) {
          for (let x = 2; x < terminal.columns - 2; x++) {
            const cell = terminal.screen.buffer.active.getLine(y)?.getCell(x); assert(cell);
            assert.equal(cell.getChars().trim(), "", "Padding and spacer rows must be blank.");
            assert.equal(cell.getBgColor(), trueColor ? 0 : 16, "Padding and spacer rows stay black.");
          }
        }
        for (const y of [heading.y, body.y]) for (let x = 2; x < terminal.columns - 2; x++) {
          assert.equal(terminal.screen.buffer.active.getLine(y)?.getCell(x)?.getBgColor(), trueColor ? 0 : 16, "User messages and blank trailing cells stay black.");
        }
      };
      assertUserPadding();
      terminal.send("\x1b[70;6u"); terminal.send("Question"); await terminal.flush();
      assert.equal(cellAt(terminal, "Question from you.").cell.getBgColor(), trueColor ? 0 : 16, "Search highlighting must keep the background black.");
      terminal.send("\x1b"); await terminal.flush();
      const original = JSON.stringify((await conversation.context(context)).messages);
      assert(!original.includes("❯ You")); assert(!original.includes("Tool result ·"));
      for (const width of [36, 76, 156, 36]) {
        terminal.resize(width + 4, 40); await terminal.flush(); assertUserPadding();
        const lines = ui.transcript.render(width), text = lines.map(stripTerminalSequences).join("\n");
        assert(lines.every((line) => visibleWidth(line) <= width && !line.includes("\n") && !line.includes("\r")));
        for (const value of ["Question from you.", "Before the reasoning.", "Visible planning summary.", "After the reasoning.", "src/example.ts", "TOOL-OUTPUT-ONLY", "Final answer stays readable."]) assert(text.includes(value), value);
        assert(text.indexOf("Before the reasoning.") < text.indexOf("Visible planning summary."));
        assert(text.indexOf("Visible planning summary.") < text.indexOf("After the reasoning."));
      }
    } finally { ui.stop(); terminal.dispose(); await harness.close(context); setCapabilities(capabilities); }
  });
}

test("live tool output is nested like settled output, and tool-only rounds do not masquerade as assistant answers", { timeout: 10000 }, async () => {
  const gate = Promise.withResolvers<void>();
  const { harness, conversation, input } = await fixture({ gate: gate.promise, toolOnly: true });
  const terminal = new TestTerminal(100, 40), ui = new ChatUI(terminal, { animate: false });
  const watch = await conversation.watch(context);
  watch.start(async (view) => ui.setView(view)); ui.setView(watch.value);
  try {
    ui.start();
    let seen = false;
    for (let i = 0; i < 100; i++) {
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      if (live?.tools?.some((tool) => tool.output?.includes("LIVE-OUTPUT-ONLY"))) { seen = true; break; }
      await terminal.flush();
    }
    assert(seen); await terminal.flush();
    assert.equal(cellAt(terminal, "↳ Tool · fixture_read · running").x, 4);
    assert.equal(cellAt(terminal, "LIVE-OUTPUT-ONLY").x, 6);
    gate.resolve(); assert.equal((await input.wait(context)).status, "done"); await terminal.flush();
    assert(!terminal.text().includes("· running")); assert.equal(cellAt(terminal, "TOOL-OUTPUT-ONLY").x, 6);
    assert.equal((ui.transcript.render(96).map(stripTerminalSequences).join("\n").match(/● Assistant/g) ?? []).length, 1);
  } finally { gate.resolve(); await watch.stop(); ui.stop(); terminal.dispose(); await harness.close(context); }
});

for (const format of ["text", "blocks", "unwrapped"] as const) {
  test(`compaction summaries (${format}) are labeled Markdown, wrapped, sanitized and selectable without changing native state`, async () => {
    const summary = "## Goal\nSUMMARY-COPY\n\n- Keep **important context**.\n\n```ts\nconst saved = true;\n```\n\n你好 👩🏽‍💻 " + "wrapped text ".repeat(12) + "\nLAST-LINE\x1b[2J\x1b]52;c;SECRET\x07";
    const wrapped = format === "unwrapped" ? summary : `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;
    const { models } = testModels();
    const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
    const conversation = await harness.root(context, { agent: { model } });
    const terminal = new TestTerminal(80, 30), ui = new ChatUI(terminal, { animate: false });
    try {
      await conversation.commit((tx) => tx.appendEntry(CompactionEntry, conversation.id, {
        head: "self", data: { reason: "threshold" },
        model: [{ role: "user", content: format === "blocks" ? [fauxText(wrapped)] : wrapped, timestamp: 0 }],
      }), context);
      const state = await conversation.viewState(context); ui.setView(state.value); state.dispose();
      const before = JSON.stringify({ context: await conversation.context(context), usage: await harness.usage(context), inspection: await harness.inspect(context) });
      ui.start();
      for (const columns of [40, 80, 160, 40]) {
        terminal.resize(columns, 30); ui.scroll.scrollToStart(); await terminal.flush();
        const lines = ui.transcript.render(columns - 4), text = lines.map(stripTerminalSequences).join("\n");
        assert.match(text, /◇ Compaction summary/);
        for (const value of ["SUMMARY-COPY", "important context", "const saved = true;", "LAST-LINE"]) assert(text.includes(value), value);
        assert(!/❯ You|● Assistant|<\/?summary>|compacted into the following|SECRET|## Goal|\*\*important/.test(text));
        assert.equal((text.match(/SUMMARY-COPY/g) ?? []).length, 1);
        assert(lines.every((line) => visibleWidth(line) <= columns - 4 && !/[\r\n]/.test(line)));
        assert.strictEqual(ui.transcript.render(columns - 4), lines);
        assert.match(terminal.text(), /Compaction summary/); assert(ui.composer.focused);
      }
      const screen = terminal.text().split("\n"), y = screen.findIndex((line) => line.includes("SUMMARY-COPY"));
      assert(y >= 0); const x = screen[y].indexOf("SUMMARY-COPY");
      terminal.send(`\x1b[<0;${x + 1};${y + 1}M`);
      terminal.send(`\x1b[<32;${x + "SUMMARY-COPY".length};${y + 1}M`);
      terminal.send(`\x1b[<0;${x + "SUMMARY-COPY".length};${y + 1}m`);
      await terminal.flush(); assert(ui.tui.hasActiveSelection()); assert(ui.composer.focused);
      assert(terminal.output.includes(`\x1b]52;c;${Buffer.from("SUMMARY-COPY").toString("base64")}\x07`));
      assert.equal(JSON.stringify({ context: await conversation.context(context), usage: await harness.usage(context), inspection: await harness.inspect(context) }), before);
    } finally { ui.stop(); terminal.dispose(); await harness.close(context); }
  });
}

test("failed tool headers and error output are visible rather than collapsed", async () => {
  const { harness, conversation, input } = await fixture({ failed: true });
  const terminal = new TestTerminal(100, 40), ui = new ChatUI(terminal, { animate: false });
  try {
    assert.equal((await input.wait(context)).status, "done");
    const state = await conversation.viewState(context); ui.setView(state.value); state.dispose(); ui.start(); await terminal.flush();
    const failed = cellAt(terminal, "↳ Tool failed · fixture_read"), error = cellAt(terminal, "! tool failed");
    assert.equal(failed.cell.getFgColor(), 0xd9626d); assert.equal(error.cell.getFgColor(), 0xd9626d);
    assert.equal(error.x, 6); assert.equal(cellAt(terminal, "TOOL-OUTPUT-ONLY").x, 6);
  } finally { ui.stop(); terminal.dispose(); await harness.close(context); }
});
