import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ExtensionToasts } from "../src/extension-presentation.ts";
import { openNotifications } from "../src/notifications.ts";
import { ChatUI } from "../src/ui.ts";
import { TestTerminal } from "./terminal.ts";

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const closeEvent: TuiMouseEvent = { type: "click", button: "left", x: 61, y: 0, screenX: 61, screenY: 0,
  width: 100, height: 3, shift: false, alt: false, ctrl: false };

test("notification snapshots/queued dismissal do not consume or restart lifetimes; IDs and subscriptions are identity-safe", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const terminal = new TestTerminal(), toasts = new ExtensionToasts(terminal, () => {});
  let changes = 0;
  const unsubscribe = toasts.subscribe(() => { changes++; });
  try {
    toasts.add("fixture", "ACTIVE");
    toasts.add("fixture", "QUEUED-TIMED", { timeoutMs: 200 });
    toasts.add("fixture", "QUEUED-PERSISTENT", { timeoutMs: 0 });
    const [active, timed, persistent] = toasts.snapshot();
    assert.deepEqual(toasts.snapshot().map((item) => item.active), [true, false, false]);
    t.mock.timers.tick(4999);
    assert.deepEqual(toasts.snapshot().map((item) => item.id), [active.id, timed.id, persistent.id]);
    assert.equal(changes, 3, "Inspection does not mutate or notify.");
    t.mock.timers.tick(1);
    assert.equal(toasts.snapshot()[0].id, timed.id);
    t.mock.timers.tick(100);
    toasts.dismiss(persistent.id); toasts.dismiss(persistent.id); toasts.dismiss(active.id);
    toasts.add("fixture", "NEXT", { timeoutMs: 20 });
    t.mock.timers.tick(99); assert.equal(toasts.snapshot()[0].id, timed.id);
    t.mock.timers.tick(1); assert.equal(toasts.snapshot()[0].text, "NEXT");
    t.mock.timers.tick(19); assert.equal(toasts.snapshot().length, 1);
    t.mock.timers.tick(1); assert.equal(toasts.snapshot().length, 0);
    unsubscribe(); const before = changes;
    toasts.add("fixture", "AFTER-UNSUBSCRIBE", { timeoutMs: 10 }); toasts.clear();
    toasts.add("fixture", "NEW-SESSION", { timeoutMs: 0 }); toasts.dismiss(timed.id);
    t.mock.timers.tick(60000);
    assert.equal(changes, before); assert.equal(toasts.snapshot()[0].text, "NEW-SESSION");
    assert(toasts.snapshot()[0].id > persistent.id, "Clearing must not reuse IDs held by stale views/callbacks.");
  } finally { unsubscribe(); toasts.clear(); terminal.dispose(); }
});

test("pending notifications are bounded, overflow preserves active expiry, and truncation is sanitized UTF-8", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const terminal = new TestTerminal(), toasts = new ExtensionToasts(terminal, () => {});
  try {
    toasts.add("fixture", "ACTIVE", { timeoutMs: 100 });
    t.mock.timers.tick(50);
    for (let i = 0; i < 100; i++) toasts.add("fixture", `QUEUED-${i}`, { timeoutMs: 10 });
    assert.equal(toasts.snapshot().length, 100);
    assert.equal(toasts.snapshot()[0].text, "ACTIVE"); assert.equal(toasts.snapshot()[1].text, "QUEUED-1");
    assert.equal(toasts.snapshot().at(-1)?.text, "QUEUED-99");
    t.mock.timers.tick(49); assert.equal(toasts.snapshot()[0].text, "ACTIVE");
    t.mock.timers.tick(1); assert.equal(toasts.snapshot()[0].text, "QUEUED-1");
    t.mock.timers.tick(9); assert.equal(toasts.snapshot()[0].text, "QUEUED-1");
    t.mock.timers.tick(1); assert.equal(toasts.snapshot()[0].text, "QUEUED-2");
    toasts.clear();
    toasts.add("源".repeat(600), "\x1b]52;c;PRIVATE-CONTROL\x07" + "你好 👩🏽‍💻\n".repeat(20000), { timeoutMs: 0 });
    const item = toasts.snapshot()[0];
    assert(Buffer.byteLength(item.text) <= 65536); assert(Buffer.byteLength(item.source) <= 512);
    assert(item.text.endsWith("\n[Notification truncated]")); assert(item.source.endsWith("…"));
    assert(!item.text.includes("\ufffd")); assert(!item.source.includes("\ufffd")); assert(!item.text.includes("PRIVATE-CONTROL"));
    const snapshot = toasts.snapshot(); Object.assign(snapshot[0], { text: "MUTATED", id: -1 });
    assert.equal(toasts.snapshot()[0].text, item.text, "Snapshots cannot mutate the authoritative queue.");
  } finally { toasts.clear(); terminal.dispose(); }
});

test("keyboard inspector synchronizes arrivals/expiry, preserves queued lifetimes and never retargets stale deletion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const terminal = new TestTerminal(110, 30), ui = new ChatUI(terminal, { animate: false });
  const toasts = new ExtensionToasts(terminal, () => ui.tui.requestRender());
  let subscriptions = 0;
  const subscribe = toasts.subscribe.bind(toasts);
  t.mock.method(toasts, "subscribe", (listener: () => void) => { subscriptions++; const stop = subscribe(listener); return () => { subscriptions--; stop(); }; });
  const text = () => { ui.tui.renderNow(); return plain(ui.tui.getScreenLines()); };
  ui.start();
  toasts.add("fixture", "FIRST", { timeoutMs: 1000 });
  toasts.add("fixture", "SECOND", { timeoutMs: 500 });
  toasts.add("fixture", "THIRD", { timeoutMs: 0 });
  const scope = openNotifications(ui.tui, toasts, new AbortController().signal);
  try {
    assert.equal(subscriptions, 1); assert(!ui.composer.focused); assert.match(text(), /3 pending · 1 active · 2 queued/);
    terminal.send("\x1b[B"); assert.match(text(), /Queued · #2 · info/);
    t.mock.timers.tick(1000);
    assert.equal(toasts.snapshot()[0].text, "SECOND"); assert.match(text(), /Active · #2 · info/);
    t.mock.timers.tick(499); assert.equal(toasts.snapshot()[0].text, "SECOND");
    t.mock.timers.tick(1); assert.equal(toasts.snapshot()[0].text, "THIRD");
    assert.match(text(), /selection removed/);
    terminal.send("d"); terminal.send("\x1b[3~"); assert.equal(toasts.snapshot()[0].text, "THIRD");
    toasts.add("fixture", "NEW-ARRIVAL", { timeoutMs: 0 }); assert.match(text(), /NEW-ARRIVAL/);
    terminal.send("\x1b[B"); terminal.send("d"); assert.equal(toasts.snapshot()[0].text, "NEW-ARRIVAL");
    terminal.send("d"); assert.equal(toasts.snapshot().length, 1, "Repeated delete must not dismiss a replacement selection.");
    terminal.send("\x04"); assert.match(text(), /No notifications pending/); assert(ui.tui.hasOverlay());
    terminal.send("\r"); await scope.closed;
    assert.equal(subscriptions, 0); assert(!ui.tui.hasOverlay()); assert(ui.composer.focused);
    toasts.add("fixture", "CLOSED-VIEW", { timeoutMs: 0 }); assert(!text().includes("Notifications"));
    toasts.add("fixture", "DUPLICATE-BODY", { timeoutMs: 0 }); toasts.add("fixture", "DUPLICATE-BODY", { timeoutMs: 0 });
    const overflow = openNotifications(ui.tui, toasts, new AbortController().signal);
    try {
      terminal.send("\x1b[B");
      const selected = toasts.snapshot()[1].id;
      for (let i = 0; i < 100; i++) toasts.add("fixture", `OVERFLOW-${i}`, { timeoutMs: 0 });
      assert(!toasts.snapshot().some((item) => item.id === selected)); assert.match(text(), /selection removed/);
      terminal.send("d"); assert.equal(toasts.snapshot().length, 100);
    } finally { overflow.close(); await overflow.closed; }
    assert.equal(subscriptions, 0);
  } finally { scope.close(); toasts.clear(); ui.stop(); terminal.dispose(); }
});

test("long notification inspection scrolls independently, survives resize, isolates composer keys, and restores focus/draft without dismissal", async () => {
  const terminal = new TestTerminal(110, 30), ui = new ChatUI(terminal, { animate: false });
  try {
    ui.start();
    ui.addExtensionMessage("fixture", Array.from({ length: 100 }, (_, i) => `CHAT-${i}`).join("\n"));
    ui.addExtensionToast("fixture /notify", Array.from({ length: 100 }, (_, i) => `DETAIL-${i} 你好 👩🏽‍💻`).join("\n") + "\nLAST-DETAIL", { timeoutMs: 0 });
    ui.addExtensionToast("fixture /notify", "QUEUED-DETAIL", { timeoutMs: 0 });
    ui.composer.editor.setText("preserved draft"); await terminal.flush();
    const chatTop = ui.scroll.scrollTop, before = plain(ui.transcript.render(106));
    const closed = ui.showNotifications(new AbortController().signal);
    await terminal.flush(); assert(!ui.composer.focused);
    for (const [columns, rows] of [[40, 16], [80, 24], [160, 36], [40, 16], [110, 30]]) {
      terminal.resize(columns, rows); await terminal.flush();
      terminal.send("\x1b[F"); await terminal.flush(); assert.match(terminal.text(), /LAST-DETAIL/);
      assert(ui.tui.getScreenLines().every((line) => visibleWidth(line) <= columns));
      terminal.send("\x1b[H"); await terminal.flush(); assert.match(terminal.text(), /DETAIL-0/);
    }
    const top = ui.scroll.scrollTop;
    terminal.send("\x1b[6~"); await terminal.flush(); assert.equal(ui.scroll.scrollTop, top);
    terminal.send("x"); terminal.send("\x01"); terminal.send("\x1b[B"); await terminal.flush();
    assert.match(terminal.text(), /Queued · #2 · info/); assert.match(terminal.text(), /QUEUED-DETAIL/);
    assert.equal(ui.composer.editor.getText(), "preserved draft");
    terminal.send("\r"); await closed; await terminal.flush();
    assert(!ui.tui.hasOverlay()); assert(ui.composer.focused); assert.equal(ui.composer.editor.getText(), "preserved draft");
    assert.match(terminal.text(), /DETAIL-0/); assert.match(terminal.text().split("\n")[0], /\+1/);
    assert.equal(plain(ui.transcript.render(106)), before); assert.equal(ui.scroll.scrollTop, chatTop);
    const cleared = ui.showNotifications(new AbortController().signal); await terminal.flush();
    const x = Math.min(64, terminal.columns) - 3;
    terminal.send(`\x1b[<0;${x + 1};1M`); terminal.send(`\x1b[<0;${x + 1};1m`); await terminal.flush();
    assert.match(terminal.text(), /1 pending/); assert.match(terminal.text(), /selection removed/); assert(!ui.composer.focused);
    ui.clearExtensionPresentation(); assert(!ui.tui.hasOverlay()); await cleared;
    ui.addExtensionToast("next session", "ONLY-NEW-NOTIFICATION", { timeoutMs: 0 });
    const next = ui.showNotifications(new AbortController().signal); await terminal.flush();
    assert.match(terminal.text(), /1 pending/); assert(!terminal.text().includes("QUEUED-DETAIL"));
    ui.stop(); await next; assert(!ui.tui.hasOverlay()); assert(ui.composer.focused);
  } finally { ui.stop(); terminal.dispose(); }
});

test("aborting the inspector removes its overlay/subscription/abort listener without dismissing notifications", async (t) => {
  const terminal = new TestTerminal(), ui = new ChatUI(terminal, { animate: false });
  const toasts = new ExtensionToasts(terminal, () => {}), controller = new AbortController();
  const removed = t.mock.method(controller.signal, "removeEventListener");
  ui.start(); toasts.add("fixture", "RETAINED", { timeoutMs: 0 });
  const scope = openNotifications(ui.tui, toasts, controller.signal), rejected = assert.rejects(scope.closed, /Cancelled/);
  try {
    controller.abort(new Error("Cancelled.")); await rejected;
    assert(!ui.tui.hasOverlay()); assert(ui.composer.focused); assert.equal(toasts.snapshot()[0].text, "RETAINED");
    assert.equal(removed.mock.callCount(), 1);
    assert.throws(() => openNotifications(ui.tui, toasts, controller.signal), /Cancelled/);
  } finally { scope.close(); toasts.clear(); ui.stop(); terminal.dispose(); }
});

test("a mouse close begun before expiry cannot dismiss the successor card", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const terminal = new TestTerminal(), toasts = new ExtensionToasts(terminal, () => {});
  try {
    toasts.add("fixture", "EXPIRES", { timeoutMs: 100 }); toasts.add("fixture", "SUCCESSOR", { timeoutMs: 0 });
    toasts.render(100); toasts.handleMouse({ ...closeEvent, type: "press" });
    t.mock.timers.tick(100); toasts.render(100); toasts.handleMouse(closeEvent);
    assert.equal(toasts.snapshot()[0].text, "SUCCESSOR");
    toasts.handleMouse({ ...closeEvent, type: "press" }); toasts.handleMouse(closeEvent);
    assert.equal(toasts.snapshot().length, 0);
  } finally { toasts.clear(); terminal.dispose(); }
});
