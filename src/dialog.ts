import { Input, matchesKey, ScrollView, SelectList, Text, type Component, type Focusable, type SelectItem, type TuiAltScreen } from "@earendil-works/pi-tui";
import { fill, paint, rule, safeText } from "./theme.ts";

/** Small native-component overlay shared by commands and OAuth; never part of the transcript. */
export class Dialog implements Component, Focusable {
  readonly input = new Input({ prompt: "> " });
  list: SelectList | undefined;
  private readonly items: SelectItem[];
  private readonly filter: ((item: SelectItem, query: string) => boolean) | undefined;
  focused = false;
  message: string;
  info = "";
  onSubmit: (value: string) => void = () => {};
  onCancel: () => void = () => {};
  private readonly tui: TuiAltScreen;
  private readonly scroll = new ScrollView({
    render: (width) => new Text(safeText(this.message + (this.info ? "\n\n" + this.info : "")), 0, 0).render(width),
    invalidate: () => {},
  }, { scrollbar: "hidden" });
  constructor(tui: TuiAltScreen, message: string, items?: SelectItem[], filter?: (item: SelectItem, query: string) => boolean) {
    this.tui = tui; this.message = message; this.filter = filter;
    this.items = (items ?? []).map((item) => ({ ...item,
      label: safeText(item.label).replace(/\s+/g, " "),
      description: item.description === undefined ? undefined : safeText(item.description).replace(/\s+/g, " "),
    }));
    if (items) this.list = this.selectList(this.items);
    this.input.onSubmit = (value) => this.onSubmit(value);
    this.input.onEscape = () => this.onCancel();
  }
  private selectList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, 6, {
      selectedPrefix: (s) => paint(s, "green"), selectedText: (s) => paint(s, "title", true),
      description: (s) => paint(s, "dim"), scrollInfo: (s) => paint(s, "dim"), noMatch: (s) => paint(s, "red"),
    });
    list.onSelect = (item) => this.onSubmit(item.value);
    list.onCancel = () => this.onCancel();
    return list;
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { this.onCancel(); return; }
    if (!this.list && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
      this.scroll.scrollBy((matchesKey(data, "pageUp") ? -1 : 1) * Math.max(1, this.scroll.viewportHeight - 1));
      this.tui.requestRender(); return;
    }
    if (this.list && (["up", "down", "enter", "pageUp", "pageDown"] as const).some((key) => matchesKey(data, key))) this.list.handleInput(data);
    else {
      this.input.handleInput(data);
      const query = this.input.getValue();
      if (this.filter) this.list = this.selectList(this.items.filter((item) => this.filter!(item, query)));
      else this.list?.setFilter(query);
    }
    this.tui.requestRender();
  }
  invalidate(): void { this.input.invalidate(); this.list?.invalidate(); }
  render(width: number): string[] {
    this.input.focused = this.focused;
    const inner = Math.max(1, width - 4);
    const controls = [...this.input.render(inner), ...(this.list?.render(inner) ?? [])];
    const text = this.scroll.render(inner);
    const available = Math.max(1, this.tui.terminal.rows - controls.length - 6);
    this.scroll.updateLayout(text.length, available, () => this.tui.requestRender());
    const rows = [...text.slice(this.scroll.scrollTop, this.scroll.scrollTop + available), "", ...controls];
    return [rule(width, paint(" pi-d ", "title", true), "inputBorder"),
      ...rows.map((line) => fill(paint("│ ", "inputBorder") + fill(line, inner) + paint(" │", "inputBorder"), width)),
      rule(width, "", "inputBorder", paint(" Enter choose · Esc cancel · PgUp/Dn ", "dim"), true)];
  }
}

export async function showDialog(tui: TuiAltScreen, dialog: Dialog, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const result = Promise.withResolvers<string>();
  const handle = tui.showOverlay(dialog, { width: "90%", maxHeight: "100%", margin: 1 });
  const abort = () => result.reject(signal.reason ?? new Error("Cancelled."));
  dialog.onSubmit = result.resolve;
  dialog.onCancel = () => result.reject(new Error("Cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  try { return await result.promise; }
  finally { signal.removeEventListener("abort", abort); handle.hide(); }
}
