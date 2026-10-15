import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type LiveState } from "@earendil-works/pi-durable";
import { getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { openDemo } from "../src/demo.ts";
import { Dialog } from "../src/dialog.ts";
import { safeText } from "../src/theme.ts";
import { ChatUI } from "../src/ui.ts";
import { model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

process.env.COLORTERM = "truecolor";

for (const [columns, rows] of [[40, 16], [80, 24], [110, 36], [160, 50]]) {
  test(`empty layout fits ${columns}×${rows}, with a usable composer`, async () => {
    const terminal = new TestTerminal(columns, rows);
    const ui = new ChatUI(terminal, { animate: false });
    try {
      ui.start(); await terminal.flush();
      const lines = ui.tui.getScreenLines();
      assert.equal(lines.length, rows);
      assert(lines.every((line) => visibleWidth(line) <= columns));
      assert.match(terminal.text(), /pi-d/);
      const screen = terminal.text().split("\n");
      assert.match(screen.at(-1) ?? "", /ready/);
      assert.match(screen.at(-2) ?? "", /^╰─/);
      for (const hint of ["/new", "/help", "Ctrl+C", "Ctrl+N", "PgUp/Dn"]) assert(!terminal.text().includes(hint));
      assert(ui.composer.focused);
      terminal.send("你好 👩🏽‍💻 café");
      terminal.send("\x1b\r"); terminal.send("second line");
      await terminal.flush();
      assert.equal(ui.composer.editor.getText(), "你好 👩🏽‍💻 café\nsecond line");
      assert.match(terminal.text(), /second line/);
    } finally { ui.stop(); terminal.dispose(); }
    assert(terminal.stopped);
    assert(terminal.output.includes("\x1b[?1049h"));
    assert(terminal.output.includes("\x1b[?1049l"));
    assert(terminal.output.includes("\x1b[?25h"));
  });
}

test("Alt+Enter, terminal-supported Shift+Enter and Ctrl+J insert newlines; Enter submits", async () => {
  const terminal = new TestTerminal(100, 24);
  const ui = new ChatUI(terminal, { animate: false });
  const submitted: string[] = [];
  ui.composer.editor.onSubmit = (text) => submitted.push(text);
  try {
    ui.start();
    for (const [name, key] of [["Alt+Enter", "\x1b\r"], ["Shift+Enter (Kitty)", "\x1b[13;2u"], ["Shift+Enter (legacy)", "\x1b[13;2~"], ["Ctrl+J", "\n"]]) {
      ui.composer.editor.setText("first line");
      terminal.send(key); terminal.send("second line"); await terminal.flush();
      assert.equal(ui.composer.editor.getExpandedText(), "first line\nsecond line", name);
      assert.equal(submitted.length, 0, name);
    }
    terminal.send("\r");
    assert.deepEqual(submitted, ["first line\nsecond line"]);
    assert.equal(ui.composer.editor.getText(), "");
  } finally { ui.stop(); terminal.dispose(); }
});

test("conversation uses full available width, reflows on resize and stays aligned with the composer", async () => {
  const context = BACKGROUND_CONTEXT;
  const { models } = testModels({ responses: [fauxAssistantMessage("Assistant alignment marker. " + "flow ".repeat(50))] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, { agent: { model } });
  const terminal = new TestTerminal(160, 30);
  const ui = new ChatUI(terminal, { animate: false });
  const watch = await conversation.watch(context);
  watch.start(async (view) => ui.setView(view)); ui.setView(watch.value);
  const columnOf = (text: string): number => {
    const line = terminal.text().split("\n").find((row) => row.includes(text));
    assert(line, `Expected visible text: ${text}`);
    return line.indexOf(text);
  };
  try {
    ui.start(); ui.composer.editor.setText("Draft alignment marker.");
    await terminal.flush();
    assert(ui.transcript.render(90).map(stripTerminalSequences).every((line) => !line.trim()));
    assert.equal(columnOf("Draft alignment marker."), 2);
    const input = await conversation.submit({ type: "input", content: "User alignment marker. " + "flow ".repeat(50) }, context);
    assert.equal((await input.wait(context)).status, "done");
    const heights = new Map<number, number>();
    for (const columns of [160, 110, 80, 40, 160]) {
      terminal.resize(columns, 30); await terminal.flush();
      assert.equal(columnOf("Draft alignment marker."), 2);
      for (const text of ["❯ You", "● Assistant", "User alignment marker.", "Assistant alignment marker."]) {
        assert.equal(columnOf(text), 2, `${text} at ${columns} columns`);
      }
      if (columns > 92) {
        for (const marker of ["User alignment marker.", "Assistant alignment marker."]) {
          const line = terminal.text().split("\n").find((row) => row.includes(marker)); assert(line);
          assert(visibleWidth(line.slice(2, -2).trimEnd()) > 88, `${marker} must extend beyond the old cap at ${columns} columns`);
        }
      }
      const lines = ui.transcript.render(columns - 4);
      assert(lines.every((line) => visibleWidth(line) <= columns - 4));
      heights.set(columns, lines.length);
      assert(ui.tui.getScreenLines().every((line) => visibleWidth(line) <= columns));
    }
    for (const [wide, narrow] of [[160, 110], [110, 80], [80, 40]]) {
      assert(heights.get(wide)! < heights.get(narrow)!, `Wider messages should need fewer rows: ${wide} vs ${narrow}`);
    }
  } finally { ui.stop(); await watch.stop(); await harness.close(context); terminal.dispose(); }
});

test("paste, resize, scrolling and search reuse native terminal components", async () => {
  const terminal = new TestTerminal(100, 28);
  const ui = new ChatUI(terminal, { animate: false });
  const demo = await openDemo(100000);
  const watch = await demo.conversation.watch(BACKGROUND_CONTEXT);
  watch.start(async (view) => ui.setView(view));
  ui.setView(watch.value);
  try {
    ui.start();
    terminal.send("\x1b[200~first\nsecond\nthird\x1b[201~");
    await terminal.flush();
    assert.equal(ui.composer.editor.getText(), "first\nsecond\nthird");
    demo.answer();
    const submission = await demo.conversation.submit({ type: "input", content: "Show the design." }, BACKGROUND_CONTEXT);
    const receipt = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(receipt.status, "done");
    await terminal.flush();
    assert.match(terminal.text(), /offline design demo/);
    assert.equal(ui.busy, false);
    assert.equal((ui.transcript.render(90).map(stripTerminalSequences).join("\n").match(/● Assistant/g) ?? []).length, 1);
    terminal.send("\x1b[5~"); await terminal.flush();
    assert(ui.tui.viewportTop >= 0);
    assert(!ui.tui.isFollowingOutput);
    terminal.resize(52, 20); await terminal.flush();
    assert(ui.tui.getScreenLines().every((line) => visibleWidth(line) <= 52));
    assert.match(terminal.text(), /pi-d/);
    terminal.send("\x1b[70;6u"); // Kitty Ctrl+Shift+F.
    terminal.send("Durable"); await terminal.flush();
    assert.match(terminal.text(), /Durable/);
    terminal.send("\x1b");
  } finally {
    ui.stop(); await watch.stop(); await demo.harness.close(BACKGROUND_CONTEXT); terminal.dispose();
  }
});

test("committed streaming replaces the live message once, and cancellation settles", async () => {
  const terminal = new TestTerminal(100, 30);
  const ui = new ChatUI(terminal, { animate: false });
  const demo = await openDemo(80);
  const watch = await demo.conversation.watch(BACKGROUND_CONTEXT);
  let sawLive = false;
  watch.start(async (view) => {
    ui.setView(view);
    const live = view.docs["pi.live"] as LiveState | undefined;
    sawLive ||= !!live?.generation?.message?.content.some((part) => part.type === "text" && part.text.length > 0);
  });
  ui.setView(watch.value);
  try {
    ui.start(); demo.answer();
    const submission = await demo.conversation.submit({ type: "input", content: "Hello." }, BACKGROUND_CONTEXT);
    for (let i = 0; i < 30 && !sawLive; i++) await terminal.flush();
    assert(sawLive);
    assert(ui.busy);
    assert(ui.composer.editor.disableSubmit);
    await demo.conversation.abort(BACKGROUND_CONTEXT);
    const receipt = await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(receipt.status, "unanswered");
    await terminal.flush();
    assert.equal(ui.busy, false);
    const rendered = ui.transcript.render(90).map(stripTerminalSequences).join("\n");
    assert.equal((rendered.match(/● Assistant/g) ?? []).length, 1);
    assert(!rendered.includes("live"));
  } finally {
    ui.stop(); await watch.stop(); await demo.harness.close(BACKGROUND_CONTEXT); terminal.dispose();
  }
});

test("activity changes while busy and the footer reserves usage space for long model names", async () => {
  const terminal = new TestTerminal(80, 24);
  const ui = new ChatUI(terminal);
  const demo = await openDemo(40);
  const watch = await demo.conversation.watch(BACKGROUND_CONTEXT);
  watch.start(async (view) => ui.setView(view)); ui.setView(watch.value);
  try {
    ui.start(); demo.answer();
    const input = await demo.conversation.submit({ type: "input", content: "Show activity." }, BACKGROUND_CONTEXT);
    await terminal.flush();
    const before = terminal.text().split("\n").at(-1);
    await new Promise((resolve) => setTimeout(resolve, 130)); await terminal.flush();
    const after = terminal.text().split("\n").at(-1);
    assert.match(after ?? "", /responding/); assert.notEqual(before, after);
    await demo.conversation.abort(BACKGROUND_CONTEXT); await input.wait(BACKGROUND_CONTEXT);
    await demo.conversation.configure({ model: { provider: "provider-name", modelId: "\n\x1b[2J" + "very-long-model-name/".repeat(5) } }, BACKGROUND_CONTEXT);
    await terminal.flush();
    const footer = terminal.text().split("\n").at(-1) ?? "";
    assert.match(footer, /ready/); assert.match(footer, /~\$0\.0000/); assert.match(footer, /↑/);
    assert(ui.tui.getScreenLines().every((line) => !line.includes("\n")));
  } finally { ui.stop(); await watch.stop(); await demo.close(); terminal.dispose(); }
});

test("OpenAI footer keeps max visible and reports subscription rather than a fictional API bill", async () => {
  const terminal = new TestTerminal(110, 24);
  const ui = new ChatUI(terminal, { animate: false });
  const demo = await openDemo(100000);
  const watch = await demo.conversation.watch(BACKGROUND_CONTEXT);
  watch.start(async (view) => ui.setView(view)); ui.setView(watch.value);
  try {
    ui.start(); demo.answer();
    const input = await demo.conversation.submit({ type: "input", content: "Offline usage test." }, BACKGROUND_CONTEXT);
    await input.wait(BACKGROUND_CONTEXT);
    for (const provider of ["openai", "openai-codex"]) {
      await demo.conversation.configure({ model: { provider, modelId: "gpt-6.1-sol" }, thinkingLevel: "max" }, BACKGROUND_CONTEXT);
      for (const busy of [false, true]) {
        ui.setAdmitting(busy);
        for (const width of [110, 80, 40]) {
          terminal.resize(width, 24); await terminal.flush();
          const footer = terminal.text().split("\n").at(-1) ?? "";
          assert.match(footer, /· max/); assert(!footer.includes("~$"));
          if (width >= 78) { assert.match(footer, /subscription/); assert.match(footer, /↑/); }
          assert(ui.tui.getScreenLines().every((line) => visibleWidth(line) <= width));
        }
      }
    }
  } finally { ui.stop(); await watch.stop(); await demo.close(); terminal.dispose(); }
});

test("256-color fallback keeps the fixed theme without truecolor output", async () => {
  const capabilities = getCapabilities();
  setCapabilities({ ...capabilities, trueColor: false });
  const terminal = new TestTerminal(80, 24);
  const ui = new ChatUI(terminal, { animate: false });
  try {
    ui.start(); await terminal.flush();
    assert(terminal.output.includes("\x1b[38;5;"));
    assert(!terminal.output.includes("\x1b[38;2;"));
    assert(terminal.output.includes("\x1b[48;5;"));
    for (let y = 0; y < terminal.rows; y++) for (let x = 0; x < terminal.columns; x++) {
      const cell = terminal.screen.buffer.active.getLine(y)?.getCell(x); assert(cell);
      assert(cell.isBgPalette()); assert.equal(cell.getBgColor(), 16, `Expected black at ${x},${y}`);
    }
  } finally { ui.stop(); terminal.dispose(); setCapabilities(capabilities); }
});

test("large paste expands on submission and long input retains native hidden-line hints", async () => {
  const terminal = new TestTerminal(52, 20);
  const ui = new ChatUI(terminal, { animate: false });
  try {
    ui.start();
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    terminal.send(`\x1b[200~${text}\x1b[201~`); await terminal.flush();
    assert.equal(ui.composer.editor.getExpandedText(), text);
    assert.match(ui.composer.editor.getText(), /paste #1/);
    let submitted = "";
    ui.composer.editor.onSubmit = (value) => { submitted = value; };
    terminal.send("\r");
    assert.equal(submitted, text);
    ui.composer.editor.setText(text); await terminal.flush();
    assert.match(terminal.text(), /pi-d/);
    assert(ui.composer.focused);
    assert.match(terminal.text(), /line 99/);
    assert.match(terminal.text(), /↑/);
    assert.match(terminal.text().split("\n").at(-1) ?? "", /ready/);
    assert(!terminal.text().includes("Ctrl+C"));
  } finally { ui.stop(); terminal.dispose(); }
});

test("the entire surface stays explicitly black on a light terminal", async () => {
  const context = BACKGROUND_CONTEXT;
  const { models } = testModels({ responses: [fauxAssistantMessage("Black surface.\n\n```ts\nconst value = 1;\n```")] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, { agent: { model } });
  const terminal = new TestTerminal(110, 30);
  terminal.screen.options.theme = { background: "#ffffff" };
  const ui = new ChatUI(terminal, { animate: false });
  const watch = await conversation.watch(context);
  watch.start(async (view) => ui.setView(view)); ui.setView(watch.value);
  const assertBlack = () => {
    const buffer = terminal.screen.buffer.active;
    for (let y = 0; y < terminal.rows; y++) for (let x = 0; x < terminal.columns; x++) {
      const cell = buffer.getLine(y)?.getCell(x);
      assert(cell); assert(cell.isBgRGB(), `Expected an explicit surface at ${x},${y}`);
      assert.equal(cell.getBgColor(), 0, `Unexpected background at ${x},${y}`);
    }
  };
  try {
    ui.start(); await terminal.flush(); assertBlack();
    const input = await conversation.submit({ type: "input", content: "Short prompt." }, context);
    await input.wait(context); await terminal.flush(); assertBlack();
    terminal.send("\x1b[70;6u"); terminal.send("Black"); await terminal.flush(); assertBlack();
    terminal.send("\x1b");
    ui.composer.editor.setText("Long draft.\n".repeat(40)); await terminal.flush(); assertBlack();
    for (const [columns, rows] of [[40, 16], [160, 40], [80, 24]]) {
      terminal.resize(columns, rows); await terminal.flush(); assertBlack();
    }
    const dialog = new Dialog(ui.tui, Array.from({ length: 50 }, (_, index) => `OVERLAY-LINE-${index}`).join("\n"));
    const overlay = ui.tui.showOverlay(dialog, { width: "90%", maxHeight: "100%", margin: 1 });
    await terminal.flush(); assertBlack();
    for (let i = 0; i < 6; i++) terminal.send("\x1b[6~");
    await terminal.flush(); assert.match(terminal.text(), /OVERLAY-LINE-49/); assertBlack();
    terminal.resize(40, 16); await terminal.flush(); assertBlack();
    overlay.hide(); await terminal.flush(); assertBlack();
    const lines = ui.transcript.render(80).map(stripTerminalSequences);
    const user = lines.findIndex((line) => line.includes("❯ You"));
    assert(lines[user + 1].includes("Short prompt."), "No blank row between a role and its message.");
    const assistant = lines.findIndex((line) => line.includes("● Assistant"));
    assert.equal(user, 2, "Two blank rows precede the first user heading.");
    assert.equal(assistant - user, 4, "Two blank rows follow the user message.");
    assert(!terminal.text().includes("stock harness"));
    assert(!terminal.text().includes("durable conversations"));
  } finally { ui.stop(); await watch.stop(); await harness.close(context); terminal.dispose(); }
});

test("untrusted message content cannot carry terminal control sequences", () => {
  assert.equal(safeText("okay\x1b[2J\x1b]52;c;secret\x07\x00\n你好"), "okay\n你好");
});
