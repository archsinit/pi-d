import { Text, truncateToWidth, visibleWidth, type Component, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionMessageOptions, ExtensionMessageType, ExtensionToastOptions } from "./extensions.ts";
import { fill, paint, rule, safeText, type Tone } from "./theme.ts";

const styles: Record<ExtensionMessageType, Tone> = { info: "cyan", success: "green", error: "red" };

/** Presentation data only: never a Durable entry, document, message or task. */
export class ExtensionPresentation {
  readonly source: string;
  readonly type: ExtensionMessageType;
  readonly body: Text;
  constructor(source: string, text: string, options: ExtensionMessageOptions = {}) {
    if (typeof text !== "string" || !options || typeof options !== "object" || Array.isArray(options)
      || (options.type !== undefined && !Object.hasOwn(styles, options.type))) throw new Error("Invalid extension message options.");
    this.source = safeText(source).replace(/\s+/g, " ").trim();
    this.type = options.type ?? "info";
    this.body = new Text(safeText(text), 0, 0);
  }
  get tone(): Tone { return styles[this.type]; }
  get label(): string { return `Extension · ${this.type} · ${this.source}`; }
}

type Toast = { presentation: ExtensionPresentation; timeoutMs: number; scrollTop: number };

/** A fixed, non-modal layout region, not a native overlay (overlays disable native scroll selection/scrollbars). */
export class ExtensionToasts implements Component {
  private readonly terminal: Terminal;
  private readonly changed: () => void;
  private readonly queue: Toast[] = [];
  private timer: NodeJS.Timeout | undefined;
  private cardWidth = 0;
  private bodyHeight = 0;
  private bodyLines = 0;

  constructor(terminal: Terminal, changed: () => void) { this.terminal = terminal; this.changed = changed; }

  add(source: string, text: string, options: ExtensionToastOptions = {}): void {
    const presentation = new ExtensionPresentation(source, text, options);
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2 ** 31 - 1) throw new Error("Invalid extension toast timeoutMs.");
    this.queue.push({ presentation, timeoutMs, scrollTop: 0 });
    if (this.queue.length === 1) this.schedule();
    this.changed();
  }

  private schedule(): void {
    const toast = this.queue[0];
    if (toast?.timeoutMs) {
      this.timer = setTimeout(() => this.dismiss(), toast.timeoutMs);
      this.timer.unref();
    }
  }

  private dismiss(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.shift();
    this.schedule();
    this.changed();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    this.changed();
  }

  handleMouse(event: TuiMouseEvent) {
    const toast = this.queue[0];
    if (!toast || event.x >= this.cardWidth) return undefined;
    if (event.type === "click" && event.button === "left" && event.y === 0
      && event.x === (this.cardWidth >= 5 ? this.cardWidth - 3 : 0)) {
      this.dismiss(); return { handled: true };
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
