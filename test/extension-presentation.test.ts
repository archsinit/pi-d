import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Dialog } from "../src/dialog.ts";
import { ExtensionToasts } from "../src/extension-presentation.ts";
import type { ExtensionMessageType } from "../src/extensions.ts";
import { ChatUI } from "../src/ui.ts";
import { TestTerminal } from "./terminal.ts";

process.env.COLORTERM = "truecolor";
const transcript = (ui: ChatUI, width = 96) => ui.transcript.render(width).map(stripTerminalSequences).join("\n");
const mouse = (terminal: TestTerminal, button: number, x: number, y: number, release = false) => terminal.send(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
const clickClose = (terminal: TestTerminal) => {
  const x = Math.min(64, terminal.columns) - 3;
  mouse(terminal, 0, x, 0); mouse(terminal, 0, x, 0, true);
};

for (const [type, color] of [["info", 0x74e6fc], ["success", 0x77ca9b], ["error", 0xd9626d]] as const) {
  test(`${type} messages and top-left toasts are labeled, plain, wrapped, sanitized and focus-free`, async () => {
    const terminal = new TestTerminal(110, 30), ui = new ChatUI(terminal, { animate: false });
    const body = "VISIBLE-BODY 你好 👩🏽‍💻 " + "wrapped text ".repeat(20) + "\nLAST-LINE\x1b[2J\x1b]52;c;SECRET\x07";
    try {
      ui.addExtensionMessage("fixture\x1b[2J /show\noutput", body, { type });
      ui.addExtensionToast("你好 /show", body, { type, timeoutMs: 0 });
      ui.start();
      for (const columns of [40, 80, 110, 160, 40]) {
        terminal.resize(columns, 30); await terminal.flush();
        const lines = ui.tui.getScreenLines();
        assert.equal(lines.length, 30); assert(lines.every((line) => visibleWidth(line) <= columns));
        assert.match(terminal.text().split("\n")[0], new RegExp(`^╭ Extension · ${type}`));
        assert.match(terminal.text().split("\n")[1], /^│ VISIBLE-BODY/);
        assert.match(terminal.text(), /×/); assert(!terminal.text().includes("SECRET"));
        assert.equal(terminal.screen.buffer.active.getLine(0)?.getCell(0)?.getFgColor(), color);
        assert.equal(terminal.screen.buffer.active.getLine(1)?.getCell(0)?.getBgColor(), 0);
        assert(ui.composer.focused); assert(!ui.tui.hasOverlay());
        const text = transcript(ui, columns - 4);
        assert.match(text, /◇ Extension/); assert.match(text, /fixture\s+\/show/);
        assert.match(text, /LAST-LINE/); assert(!text.includes("SECRET")); assert(!text.includes("Assistant"));
        assert(ui.transcript.render(columns - 4).every((line) => visibleWidth(line) <= columns - 4));
      }
      terminal.send("draft"); await terminal.flush(); assert.equal(ui.composer.editor.getText(), "draft");
      clickClose(terminal); await terminal.flush();
      assert(!terminal.text().split("\n")[0].includes("Extension"));
      assert.match(transcript(ui), /VISIBLE-BODY/); assert(ui.composer.focused);
    } finally { ui.stop(); terminal.dispose(); }
  });
}

test("toast defaults to five seconds, queues without replacing persistent output, and starts each timeout when shown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const terminal = new TestTerminal(100, 24), toasts = new ExtensionToasts(terminal, () => {});
  const text = () => toasts.render(100).map(stripTerminalSequences).join("\n");
  try {
    toasts.add("fixture /show", "DEFAULT");
    toasts.add("fixture /show", "SHORT", { timeoutMs: 100 });
    toasts.add("fixture /show", "PERSISTENT", { timeoutMs: 0 });
    assert.match(text(), /DEFAULT/); assert.match(text(), /\+2/);
    t.mock.timers.tick(4999); assert.match(text(), /DEFAULT/);
    t.mock.timers.tick(1); assert(!text().includes("DEFAULT")); assert.match(text(), /SHORT/);
    t.mock.timers.tick(99); assert.match(text(), /SHORT/);
    t.mock.timers.tick(1); assert.match(text(), /PERSISTENT/);
    toasts.add("fixture /show", "AFTER-PERSISTENT", { timeoutMs: 20 });
    t.mock.timers.tick(60000); assert.match(text(), /PERSISTENT/); assert(!text().includes("AFTER-PERSISTENT"));
    toasts.handleMouse({ type: "click", button: "left", x: 61, y: 0, screenX: 61, screenY: 0, width: 100, height: 3, shift: false, alt: false, ctrl: false });
    assert.match(text(), /AFTER-PERSISTENT/);
    t.mock.timers.tick(20); assert.equal(text(), "");
    toasts.add("fixture /show", "DISMISS-BEFORE-TIMEOUT", { timeoutMs: 100 });
    toasts.add("fixture /show", "NEXT-PERSISTENT", { timeoutMs: 0 }); text();
    toasts.handleMouse({ type: "click", button: "left", x: 61, y: 0, screenX: 61, screenY: 0, width: 100, height: 3, shift: false, alt: false, ctrl: false });
    t.mock.timers.tick(60000); assert.match(text(), /NEXT-PERSISTENT/);
  } finally { toasts.clear(); terminal.dispose(); }
});

test("clearing cancels the current timer and drops queued timers before a new session's card is installed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const terminal = new TestTerminal(100, 24);
  let renders = 0;
  const toasts = new ExtensionToasts(terminal, () => { renders++; });
  try {
    toasts.add("old /show", "OLD-TIMED", { timeoutMs: 100 });
    toasts.add("old /show", "OLD-QUEUED", { timeoutMs: 1 });
    toasts.clear();
    const before = renders;
    t.mock.timers.tick(60000); assert.equal(renders, before);
    toasts.add("next /show", "NEW-CARD", { timeoutMs: 0 });
    t.mock.timers.tick(60000);
    const text = toasts.render(100).map(stripTerminalSequences).join("\n");
    assert.match(text, /NEW-CARD/); assert(!text.includes("OLD-"));
  } finally { toasts.clear(); terminal.dispose(); }
});

test("stopping clears messages, ignores stopped UI output and leaves no timeout able to render", async (t) => {
  const terminal = new TestTerminal(100, 24), ui = new ChatUI(terminal, { animate: false });
  try {
    ui.start(); ui.addExtensionMessage("fixture /show", "OLD-MESSAGE");
    ui.addExtensionToast("fixture /show", "OLD-TIMED", { timeoutMs: 50 });
    ui.addExtensionToast("fixture /show", "OLD-QUEUED", { timeoutMs: 0 });
    ui.stop();
    const renders = t.mock.method(ui.tui, "requestRender");
    ui.addExtensionMessage("fixture /late", "STOPPED-MESSAGE"); ui.addExtensionToast("fixture /late", "STOPPED-TOAST");
    await terminal.flush(); await terminal.flush();
    assert.equal(renders.mock.callCount(), 0); assert(!transcript(ui).includes("MESSAGE"));
  } finally { ui.stop(); terminal.dispose(); }
});

test("long toasts scroll locally while chat PageUp, scrollbar dragging and selection remain native", async () => {
  const terminal = new TestTerminal(110, 30), ui = new ChatUI(terminal, { animate: false });
  try {
    ui.start();
    ui.addExtensionMessage("fixture /show", Array.from({ length: 100 }, (_, i) => `CHAT-LINE-${i}`).join("\n"));
    ui.addExtensionToast("fixture /show", Array.from({ length: 40 }, (_, i) => `TOAST-LINE-${i}`).join("\n"), { timeoutMs: 0 });
    await terminal.flush();
    assert.match(terminal.text(), /TOAST-LINE-0/); assert.match(terminal.text(), /wheel to scroll/);
    const before = ui.scroll.scrollTop;
    for (let i = 0; i < 50; i++) mouse(terminal, 65, 8, 2);
    await terminal.flush();
    assert.match(terminal.text(), /TOAST-LINE-39/); assert.equal(ui.scroll.scrollTop, before);
    terminal.send("\x1b[5~"); await terminal.flush();
    assert(ui.scroll.scrollTop < before); assert(!ui.tui.isFollowingOutput); assert.match(terminal.text(), /TOAST-LINE-39/);
    // The primary scrollbar is still interactive while a notification is present.
    const top = terminal.text().split("\n").findIndex((line) => line.includes("pi-d")) + 1;
    mouse(terminal, 0, terminal.columns - 3, top); mouse(terminal, 0, terminal.columns - 3, top, true);
    await terminal.flush(); assert.equal(ui.scroll.scrollTop, 0);
    const screen = terminal.text().split("\n"), y = screen.findIndex((line) => line.includes("CHAT-LINE-0"));
    assert(y >= 0);
    mouse(terminal, 0, 2, y); mouse(terminal, 32, 12, y); mouse(terminal, 0, 12, y, true);
    await terminal.flush(); assert(ui.tui.hasActiveSelection());
    // A queued notification does not reset selection. Clicking × dismisses without jumping to the chat end.
    ui.addExtensionToast("fixture /show", "NEXT-CARD", { timeoutMs: 0 }); await terminal.flush();
    assert(ui.tui.hasActiveSelection());
    clickClose(terminal); await terminal.flush();
    assert.equal(ui.scroll.scrollTop, 0); assert(!ui.tui.isFollowingOutput);
    const copied = [...terminal.output.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].map((match) => Buffer.from(match[1], "base64").toString());
    assert(copied.some((text) => text === "CHAT-LINE-0"));
  } finally { ui.stop(); terminal.dispose(); }
});

test("toast text and URLs use native copy without focusing the card or disturbing an existing dialog", async () => {
  const terminal = new TestTerminal(110, 30), ui = new ChatUI(terminal, { animate: false });
  const url = "https://example.invalid/offline";
  try {
    ui.start(); ui.addExtensionToast("fixture /show", url, { timeoutMs: 0 }); await terminal.flush();
    mouse(terminal, 0, 2, 1); mouse(terminal, 32, 2 + url.length - 1, 1); mouse(terminal, 0, 2 + url.length - 1, 1, true);
    await terminal.flush();
    assert(ui.tui.hasActiveSelection()); assert(ui.composer.focused);
    assert(terminal.output.includes(`\x1b]52;c;${Buffer.from(url).toString("base64")}\x07`));
    const dialog = new Dialog(ui.tui, "EXISTING-DIALOG");
    const overlay = ui.tui.showOverlay(dialog, { width: "90%", margin: 1 });
    ui.addExtensionToast("fixture /show", "QUEUED", { timeoutMs: 0 });
    await terminal.flush(); assert(overlay.isFocused()); assert.match(terminal.text(), /EXISTING-DIALOG/);
    terminal.send("dialog input"); assert.equal(dialog.input.getValue(), "dialog input");
    overlay.hide(); await terminal.flush(); assert(ui.composer.focused);
  } finally { ui.stop(); terminal.dispose(); }
});

test("invalid untyped presentation options fail without displaying partial output", () => {
  const terminal = new TestTerminal(40, 16), ui = new ChatUI(terminal, { animate: false });
  try {
    assert.throws(() => ui.addExtensionMessage("fixture", "INVALID", { type: "bad" as ExtensionMessageType }), /Invalid extension message/);
    for (const timeoutMs of [-1, NaN, Infinity, 2 ** 31]) assert.throws(() => ui.addExtensionToast("fixture", "INVALID", { timeoutMs }), /Invalid extension toast/);
    assert(!transcript(ui).includes("INVALID"));
    ui.start(); ui.tui.renderNow(); assert(!ui.tui.getScreenLines().map(stripTerminalSequences).join("\n").includes("INVALID"));
  } finally { ui.stop(); terminal.dispose(); }
});
