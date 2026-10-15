import { Text, truncateToWidth, visibleWidth, type Component, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionMessageOptions, ExtensionMessageType, ExtensionToastOptions } from "./extensions.ts";
import { fill, paint, rule, safeText, type Tone } from "./theme.ts";

const styles: Record<ExtensionMessageType, Tone> = { info: "cyan", success: "green", error: "red" };

/** Presentation data only: never a Durable entry, document, message or task. */
export class ExtensionPresentation {
  readonly source: string;
  readonly type: ExtensionMessageType;
  readonly body: Text;
  readonly text: string;
  constructor(source: string, text: string, options: ExtensionMessageOptions = {}) {
    if (typeof text !== "string" || !options || typeof options !== "object" || Array.isArray(options)
      || (options.type !== undefined && !Object.hasOwn(styles, options.type))) throw new Error("Invalid extension message options.");
    this.source = safeText(source).replace(/\s+/g, " ").trim();
    this.type = options.type ?? "info";
    this.text = safeText(text);
    this.body = new Text(this.text, 0, 0);
  }
  get tone(): Tone { return styles[this.type]; }
  get label(): string { return `Extension · ${this.type} · ${this.source}`; }
}

export type Notification = Readonly<{ id: number; source: string; type: ExtensionMessageType; text: string; active: boolean }>;
type Toast = { id: number; presentation: ExtensionPresentation; timeoutMs: number; scrollTop: number };

// Bound pending UI state, not a notification history. Preserve the active card on overflow.
const maxNotifications = 100, maxTextBytes = 65536, maxSourceBytes = 512;
function limited(text: string, maxBytes: number, marker: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes - Buffer.byteLength(marker);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + marker;
}

/** A fixed, non-modal layout region, not a native overlay (overlays disable native scroll selection/scrollbars). */
export class ExtensionToasts implements Component {
  private readonly terminal: Terminal;
  private readonly changed: () => void;
  private readonly queue: Toast[] = [];
  private timer: NodeJS.Timeout | undefined;
  private nextId = 1;
  private pressedId: number | undefined;
  private readonly listeners = new Set<() => void>();
  private cardWidth = 0;
  private bodyHeight = 0;
  private bodyLines = 0;

  constructor(terminal: Terminal, changed: () => void) { this.terminal = terminal; this.changed = changed; }

  add(source: string, text: string, options: ExtensionToastOptions = {}): void {
    const original = new ExtensionPresentation(source, text, options);
    const presentation = new ExtensionPresentation(limited(original.source, maxSourceBytes, "…"),
      limited(original.text, maxTextBytes, "\n[Notification truncated]"), { type: original.type });
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2 ** 31 - 1) throw new Error("Invalid extension toast timeoutMs.");
    if (this.queue.length === maxNotifications) this.queue.splice(1, 1);
    this.queue.push({ id: this.nextId++, presentation, timeoutMs, scrollTop: 0 });
    if (this.queue.length === 1) this.schedule();
    this.notify();
  }

  private schedule(): void {
    const toast = this.queue[0];
    if (toast?.timeoutMs) {
      this.timer = setTimeout(() => this.dismiss(toast.id), toast.timeoutMs);
      this.timer.unref();
    }
  }

  snapshot(): readonly Notification[] {
    return this.queue.map(({ id, presentation }, index) => ({ id, source: presentation.source,
      type: presentation.type, text: presentation.text, active: index === 0 }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void { this.changed(); for (const listener of this.listeners) listener(); }

  dismiss(id: number): void {
    const index = this.queue.findIndex((toast) => toast.id === id);
    if (index < 0) return;
    if (index === 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue.splice(index, 1);
    if (index === 0) this.schedule();
    this.notify();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    this.notify();
  }

  handleMouse(event: TuiMouseEvent) {
    const toast = this.queue[0];
    if (!toast || event.x >= this.cardWidth) return undefined;
    if (event.button === "left" && event.y === 0 && event.x === (this.cardWidth >= 5 ? this.cardWidth - 3 : 0)) {
      if (event.type === "press") { this.pressedId = toast.id; return { handled: true }; }
      if (event.type === "click") {
        this.dismiss(this.pressedId ?? toast.id); this.pressedId = undefined;
        return { handled: true };
      }
    }
    if (event.type === "wheel") {
      toast.scrollTop = Math.max(0, Math.min(Math.max(0, this.bodyLines - this.bodyHeight), toast.scrollTop + (event.wheelDelta ?? 0)));
      return { handled: true };
    }
    // Let native selection/copy handle the text; never request keyboard focus or mouse capture.
    return undefined;
  }

  invalidate(): void { for (const toast of this.queue) toast.presentation.body.invalidate(); }

  render(width: number): string[] {
    const toast = this.queue[0];
    if (!toast || this.terminal.rows < 10) return [];
    const { presentation } = toast, tone = presentation.tone;
    const card = this.cardWidth = Math.min(64, Math.max(1, width));
    const inner = Math.max(1, card - 4);
    const rendered = presentation.body.render(inner), body = rendered.length ? rendered : [""];
    this.bodyLines = body.length;
    this.bodyHeight = Math.max(1, Math.min(body.length, Math.floor(this.terminal.rows / 3) - 2));
    toast.scrollTop = Math.min(toast.scrollTop, Math.max(0, body.length - this.bodyHeight));
    const queued = this.queue.length > 1 ? ` · +${this.queue.length - 1}` : "";
    const label = truncateToWidth(` Extension · ${presentation.type}${queued} · ${presentation.source} `, Math.max(0, card - 5), "");
    const heading = card >= 5 ? paint("╭" + label, tone, true)
      + paint("─".repeat(Math.max(0, card - 5 - visibleWidth(label))) + " × ╮", tone) : paint("×", tone);
    const overflow = body.length > this.bodyHeight ? paint(" wheel to scroll ", "dim") : "";
    return [heading,
      ...body.slice(toast.scrollTop, toast.scrollTop + this.bodyHeight).map((line) => paint("│ ", tone) + fill(line, inner) + paint(" │", tone)),
      rule(card, "", tone, overflow, true),
    ].map((line) => fill(line, width));
  }
}
