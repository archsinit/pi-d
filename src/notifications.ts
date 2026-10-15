import { matchesKey, ScrollView, SelectList, Text, type Component, type Focusable, type TuiAltScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionToasts, Notification } from "./extension-presentation.ts";
import { fill, paint, rule } from "./theme.ts";

/** An explicit, keyboard-capturing inspector of the existing pending queue, not a history/store. */
class Notifications implements Component, Focusable {
  focused = false;
  onClose: () => void = () => {};
  onCancel: () => void = () => {};
  private items: readonly Notification[] = [];
  private selectedId: number | undefined;
  private selectionRemoved = false;
  private list!: SelectList;
  private visibleRows = 0;
  private body = new Text("", 0, 0);
  private bodyText = "";
  private bodyId: number | undefined;
  private scrollEdge: "start" | "end" | undefined;
  private scrollPages = 0;
  private scrollLines = 0;
  private readonly scroll = new ScrollView({ render: (width) => this.body.render(width), invalidate: () => this.body.invalidate() }, { scrollbar: "hidden" });
  private readonly tui: TuiAltScreen;
  private readonly toasts: ExtensionToasts;
  constructor(tui: TuiAltScreen, toasts: ExtensionToasts) {
    this.tui = tui; this.toasts = toasts;
    this.selectedId = toasts.snapshot()[0]?.id;
    this.sync();
  }
  sync(): void {
    this.items = this.toasts.snapshot();
    if (this.selectedId !== undefined && !this.items.some((item) => item.id === this.selectedId)) {
      this.selectedId = undefined; this.selectionRemoved = true;
    }
    this.makeList(); this.updateBody();
  }
  private makeList(): void {
    this.visibleRows = Math.max(1, Math.min(5, Math.floor((this.tui.terminal.rows - 8) / 2)));
    const choices = this.items.map((item) => ({ value: String(item.id),
      label: `${item.active ? "Active" : "Queued"} · #${item.id} · ${item.type} · ${item.source}`,
      description: item.text.replace(/\s+/g, " ").slice(0, 100) }));
    // Do not silently retarget a delete key when the selected item expires/is removed.
    if (this.items.length && this.selectedId === undefined) choices.unshift({ value: "",
      label: this.selectionRemoved ? "Choose a notification (selection removed)" : "Choose a notification (↑/↓)", description: "" });
    this.list = new SelectList(choices, this.visibleRows, {
      selectedPrefix: (s) => paint(s, "green"), selectedText: (s) => paint(s, "title", true),
      description: (s) => paint(s, "dim"), scrollInfo: (s) => paint(s, "dim"), noMatch: (s) => paint(s, "dim"),
    });
    this.list.setSelectedIndex(Math.max(0, choices.findIndex((item) => item.value === String(this.selectedId))));
    this.list.onSelectionChange = (item) => {
      this.selectedId = item.value ? Number(item.value) : undefined;
      if (this.selectedId !== undefined) this.selectionRemoved = false;
      this.makeList(); this.updateBody();
    };
  }
  private updateBody(): void {
    const selected = this.items.find((item) => item.id === this.selectedId);
    const text = selected ? `Source: ${selected.source}\n\n${selected.text}` : this.items.length
      ? "Use ↑/↓ to choose a notification. Removed selections are not automatically replaced." : "No notifications pending.";
    if (this.bodyId !== this.selectedId || this.bodyText !== text) {
      this.bodyId = this.selectedId; this.bodyText = text;
      this.body = new Text(text, 0, 0); this.scroll.scrollToStart();
      this.scrollEdge = undefined; this.scrollPages = this.scrollLines = 0;
    }
  }
  handleInput(data: string): void {
    if (matchesKey(data, "enter")) { this.onClose(); return; }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.onCancel(); return; }
    if (matchesKey(data, "ctrl+d")) this.toasts.clear();
    else if (data === "d" || matchesKey(data, "delete")) { if (this.selectedId !== undefined) this.toasts.dismiss(this.selectedId); }
    else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) this.scrollPages += matchesKey(data, "pageUp") ? -1 : 1;
    else if (matchesKey(data, "home") || matchesKey(data, "end")) {
      this.scrollEdge = matchesKey(data, "home") ? "start" : "end"; this.scrollPages = this.scrollLines = 0;
    }
    else if (matchesKey(data, "up") || matchesKey(data, "down")) this.list.handleInput(data);
    this.tui.requestRender();
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "wheel") { this.scrollLines += event.wheelDelta ?? 0; return { handled: true, render: true }; }
    return undefined;
  }
  invalidate(): void { this.list.invalidate(); this.body.invalidate(); }
  render(width: number): string[] {
    if (this.visibleRows !== Math.max(1, Math.min(5, Math.floor((this.tui.terminal.rows - 8) / 2)))) this.makeList();
    const inner = Math.max(1, width - 4), list = this.items.length ? this.list.render(inner) : [];
    const controls = new Text("↑/↓ select · d/Del dismiss · Ctrl+D all\nPgUp/Dn/Home/End scroll · Enter/Esc close", 0, 0).render(inner);
    const text = this.scroll.render(inner), available = Math.max(1, this.tui.terminal.rows - list.length - controls.length - 5);
    this.scroll.updateLayout(text.length, available, () => this.tui.requestRender());
    // Selection/resize and navigation keys can precede the next frame; use the new body's measurements.
    if (this.scrollEdge === "start") this.scroll.scrollToStart();
    if (this.scrollEdge === "end") this.scroll.scrollToEnd();
    this.scroll.scrollBy(this.scrollPages * Math.max(1, available - 1) + this.scrollLines);
    this.scrollEdge = undefined; this.scrollPages = this.scrollLines = 0;
    const selected = this.items.find((item) => item.id === this.selectedId);
    const detail = selected ? `${selected.active ? "Active" : "Queued"} · #${selected.id} · ${selected.type} · ${this.scroll.scrollTop + 1}/${text.length}` : "Details";
    const rows = [...list, paint(detail, "cyan"), ...text.slice(this.scroll.scrollTop, this.scroll.scrollTop + available), ...controls.map((line) => paint(line, "dim"))];
    const counts = this.items.length ? `${this.items.length} pending · 1 active · ${this.items.length - 1} queued` : "empty";
    return [rule(width, paint(` Notifications · ${counts} `, "title", true), "inputBorder"),
      ...rows.map((line) => fill(paint("│ ", "inputBorder") + fill(line, inner) + paint(" │", "inputBorder"), width)),
      rule(width, "", "inputBorder", "", true)];
  }
}

export function openNotifications(tui: TuiAltScreen, toasts: ExtensionToasts, signal: AbortSignal): { close: () => void; closed: Promise<void> } {
  signal.throwIfAborted();
  const result = Promise.withResolvers<void>(), view = new Notifications(tui, toasts);
  const handle = tui.showOverlay(view, { width: "90%", maxHeight: "100%", margin: 1 });
  const unsubscribe = toasts.subscribe(() => { view.sync(); tui.requestRender(); });
  let closed = false;
  const finish = (error?: unknown) => {
    if (closed) return;
    closed = true; unsubscribe(); signal.removeEventListener("abort", abort); handle.hide();
    if (error === undefined) result.resolve(); else result.reject(error);
  };
  const abort = () => finish(signal.reason ?? new Error("Cancelled."));
  view.onClose = () => finish(); view.onCancel = () => finish(new Error("Cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  return { close: () => finish(), closed: result.promise };
}
