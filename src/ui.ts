import type { AgentState, ConversationView, InboxState, LiveState, UsageState } from "@earendil-works/pi-durable";
import {
  Editor, getTerminalColorMode, HStack, ScrollView, stripTerminalSequences, styleText, truncateToWidth, TuiAltScreen, VStack, visibleWidth,
  type Component, type Focusable, type Terminal, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { ExtensionToasts } from "./extension-presentation.ts";
import { openNotifications } from "./notifications.ts";
import type { ExtensionMessageOptions, ExtensionToastOptions, FooterStatus } from "./extensions.ts";
import { editorTheme, fill, paint, rule, safeText, type Tone } from "./theme.ts";
import { Transcript } from "./transcript.ts";

class SurfaceTui extends TuiAltScreen {
  protected override applyLineResets(lines: string[]): string[] {
    // Style the completed native frame, including blank viewport rows, search and other overlays.
    // shortcut: this app renders text/placeholders only; preserve graphics lines when adding native Image components.
    return super.applyLineResets(lines.map((line) => fill(line, this.terminal.columns)));
  }
}

class Line implements Component {
  private readonly draw: (width: number) => string;
  constructor(draw: (width: number) => string) { this.draw = draw; }
  render(width: number): string[] { return [fill(this.draw(width), width)]; }
  invalidate(): void {}
}

class Rail implements Component {
  private readonly terminal: Terminal;
  private readonly tone: Tone;
  private readonly right: boolean;
  constructor(terminal: Terminal, tone: Tone, right = false) {
    this.terminal = terminal; this.tone = tone; this.right = right;
  }
  render(width: number): string[] {
    return Array.from({ length: this.terminal.rows }, () => fill(paint(this.right ? " │" : "│ ", this.tone), width));
  }
  invalidate(): void {}
}

export class Composer implements Component, Focusable {
  readonly editor: Editor;
  constructor(tui: TuiAltScreen) {
    this.editor = new Editor(tui, editorTheme);
  }
  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  handleInput(data: string): void { this.editor.handleInput(data); }
  handleMouse(event: TuiMouseEvent) {
    return this.editor.handleMouse({ ...event, x: event.x - 2, width: Math.max(1, event.width - 4) });
  }
  invalidate(): void { this.editor.invalidate(); }
  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const rows = this.editor.render(inner);
    const help = width >= 68 ? paint(" Enter send · Alt+Enter newline ", "dim") : "";
    const above = stripTerminalSequences(rows[0] ?? "").replaceAll("─", "").trim();
    // Native Editor appends completion rows after its styled lower border. Keep them outside the frame
    // at the same coordinates, including for native mouse selection and hidden-line hints.
    const lower = this.editor.isShowingAutocomplete()
      ? rows.findIndex((line, index) => index > 0 && line === editorTheme.borderColor(stripTerminalSequences(line))) : rows.length - 1;
    const bottom = lower < 0 ? rows.length - 1 : lower;
    const below = stripTerminalSequences(rows[bottom] ?? "").replaceAll("─", "").trim();
    return [rule(width, "", "inputBorder", above ? paint(` ${above} `, "gold") : help),
      ...rows.slice(1, bottom).map((line) => fill(paint("│ ", "inputBorder") + fill(line, inner) + paint(" │", "inputBorder"), width)),
      rule(width, "", "inputBorder", below ? paint(` ${below} `, "gold") : "", true),
      ...rows.slice(bottom + 1).map((line) => fill("  " + line, width))];
  }
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class ChatUI {
  readonly tui: TuiAltScreen;
  readonly transcript = new Transcript();
  readonly scroll: ScrollView;
  readonly composer: Composer;
  private view: ConversationView | undefined;
  private notice = "";
  private admitting = false;
  private admissionLabel = "saving";
  unavailable = false;
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly animate: boolean;
  private sessionLabel: string;
  private contextTokens: number | undefined;
  private contextLimit: number | undefined;
  private extensionStatus: readonly FooterStatus[] = [];
  private readonly toasts: ExtensionToasts;
  private presentationStopped = false;
  private notificationList: ReturnType<typeof openNotifications> | undefined;

  constructor(terminal: Terminal, options: { animate?: boolean; sessionLabel?: string } = {}) {
    this.animate = options.animate ?? true;
    this.sessionLabel = safeText(options.sessionLabel ?? "demo · ephemeral").replace(/\s+/g, " ");
    this.tui = new SurfaceTui(terminal, false, undefined, {
      scrollToEndIndicator: () => paint(" ↓ latest ", "gold", true),
      searchMatchStyle: (s) => paint(s, "gold", false, null), searchCurrentMatchStyle: (s) => paint(s, "red", true, null),
    });
    this.scroll = new ScrollView(this.transcript, {
      follow: "end", primary: true, scrollbar: "auto",
      scrollbarTrackStyle: (s) => paint(s, "line"), scrollbarThumbStyle: (s) => paint(s, "green"),
    });
    this.composer = new Composer(this.tui);
    this.toasts = new ExtensionToasts(terminal, () => this.tui.requestRender());
    const chat = new VStack([
      new Line((width) => rule(width, paint(" pi-d ", "title", true), "chatBorder",
        width >= 66 ? paint(` ${this.sessionLabel} `, "dim") : "")),
      { component: new HStack([
        { component: new Rail(terminal, "chatBorder"), basis: 2 },
        { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
        { component: new Rail(terminal, "chatBorder", true), basis: 2 },
      ]), basis: 0, grow: 1, minSize: 1 },
      new Line((width) => rule(width, "", "chatBorder", "", true)),
    ]);
    this.tui.setLayoutRoot(new VStack([
      { component: this.toasts, basis: "auto", shrink: 0 },
      { component: chat, basis: 0, grow: 1, minSize: 3 },
      { component: this.composer, basis: "auto", shrink: 1, minSize: 3 },
      new Line((width) => this.status(width)),
    ]));
    this.tui.setFocus(this.composer);
    this.composer.editor.onChange = () => { this.syncSubmission(); this.tui.requestRender(); };
  }

  get busy(): boolean {
    const live = this.view?.docs["pi.live"] as LiveState | undefined;
    return !this.unavailable && (this.admitting || !!live?.run || !!live?.compactions?.some((compaction) => compaction.blocking || compaction.reason === "manual"));
  }

  private get active(): boolean {
    const live = this.view?.docs["pi.live"] as LiveState | undefined;
    return !this.unavailable && (this.busy || !!live?.compactions?.length);
  }

  private syncSubmission(): void {
    const draft = this.composer.editor.getExpandedText();
    const command = /^\/(?!\/)[a-z][\w:-]*(?:\s|$)/.test(draft);
    this.composer.editor.disableSubmit = this.unavailable || this.admitting || (this.busy && !command);
  }

  setView(view: ConversationView): void {
    this.view = view;
    this.transcript.view = view;
    this.syncSubmission();
    this.syncAnimation();
    this.tui.requestRender();
  }

  setAdmitting(value: boolean, label = "saving"): void {
    this.admitting = value; this.admissionLabel = label;
    this.syncSubmission();
    this.syncAnimation();
    this.tui.requestRender();
  }

  setNotice(message: string): void {
    this.notice = safeText(message).replace(/\s+/g, " ");
    this.tui.requestRender();
  }

  addExtensionMessage(source: string, text: string, options?: ExtensionMessageOptions): void {
    if (this.presentationStopped) return;
    this.transcript.addExtensionMessage(source, text, options);
    this.tui.requestRender();
  }

  addExtensionToast(source: string, text: string, options?: ExtensionToastOptions): void {
    if (!this.presentationStopped) this.toasts.add(source, text, options);
  }

  async showNotifications(signal: AbortSignal): Promise<void> {
    if (this.presentationStopped) return;
    if (this.notificationList) throw new Error("Notifications are already open.");
    const list = this.notificationList = openNotifications(this.tui, this.toasts, signal);
    try { await list.closed; }
    finally { if (this.notificationList === list) this.notificationList = undefined; }
  }

  clearExtensionPresentation(): void {
    this.notificationList?.close(); this.notificationList = undefined;
    this.transcript.clearExtensionMessages();
    this.toasts.clear();
  }

  setSessionLabel(label: string): void {
    this.sessionLabel = safeText(label).replace(/\s+/g, " ");
    this.tui.requestRender();
  }

  setContextUsage(tokens?: number, limit?: number): void {
    this.contextTokens = tokens;
    this.contextLimit = limit;
    this.tui.requestRender();
  }

  setExtensionStatus(items: readonly FooterStatus[]): void {
    this.extensionStatus = items.map((item) => ({ ...item, text: safeText(item.text).replace(/\s+/g, " ").trim() })).filter((item) => item.text);
    this.tui.requestRender();
  }

  setUnavailable(message: string): void {
    this.unavailable = true;
    this.composer.editor.disableSubmit = true;
    this.syncAnimation();
    this.setNotice(message);
  }

  start(): void { this.tui.start(); }
  stop(): void {
    this.presentationStopped = true;
    this.clearExtensionPresentation();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.tui.stop({ preserveScreen: true });
  }

  private syncAnimation(): void {
    if (this.active && this.animate && !this.timer) {
      this.timer = setInterval(() => { this.frame++; this.tui.requestRender(); }, 100);
      this.timer.unref();
    } else if (!this.active && this.timer) {
      clearInterval(this.timer); this.timer = undefined; this.frame = 0;
    }
  }

  private status(width: number): string {
    const percent = this.contextLimit && this.contextTokens !== undefined ? Math.round(this.contextTokens / this.contextLimit * 100) : undefined;
    const context = percent === undefined ? "" : paint(width >= 100
      ? ` ctx ~${compact.format(this.contextTokens!)}/${compact.format(this.contextLimit!)} (${percent}%) ` : ` ctx ~${percent}% `,
      percent >= 90 ? "red" : percent >= 75 ? "gold" : "dim");
    const statuses = this.extensionStatus.map((item) => {
      const text = paint(item.text, item.tone ?? "muted", item.bold);
      return item.strikethrough ? styleText(text, { strikethrough: true }, getTerminalColorMode()) : text;
    }).join(" ");
    // Contributions share a bounded tail; they cannot replace activity, reasoning or usage indicators.
    const extensions = statuses ? truncateToWidth(` ${statuses} `, Math.floor(width / 3), "") : "";
    const warning = (text: string) => truncateToWidth(paint(` ! ${text}`, "red"), Math.max(0, width - visibleWidth(context + extensions))) + context + extensions;
    if (this.notice) return warning(this.notice);
    const live = this.view?.docs["pi.live"] as LiveState | undefined;
    const agent = this.view?.docs["pi.agent"] as AgentState | undefined;
    const usage = this.view?.docs["pi.usage"] as UsageState | undefined;
    if (live?.compactionFailure && !live.run && !this.admitting && !live.compactions?.length) return warning(safeText(live.compactionFailure.error).replace(/\s+/g, " "));
    const phase = this.admitting ? this.admissionLabel : live?.generation?.retry ? "retrying" : live?.tools?.some((tool) => tool.status !== "done") ? "executing" : live?.run ? "responding" : live?.compactions?.length ? "compacting" : "ready";
    const indicator = this.active ? spinner[this.frame % spinner.length] : "●";
    const background = width >= 66 && live?.run && live.compactions?.some((compaction) => !compaction.blocking) ? " · compacting" : "";
    const queued = (this.view?.docs["pi.inbox"] as InboxState | undefined)?.items.filter((item) => item.mode !== "write").length ?? 0;
    const activity = paint(` ${indicator} ${phase}${background}${queued ? ` ·q${queued}` : ""}`, this.active ? "gold" : "green");
    const model = agent?.model ? safeText(`${agent.model.provider}/${agent.model.modelId}`).replace(/\s+/g, " ") : "choose --model provider/id";
    let input = 0, output = 0, cost = 0;
    for (const value of [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})]) {
      input += value.input + value.cacheRead + value.cacheWrite;
      output += value.output; cost += value.cost.total;
    }
    const billing = ["openai", "openai-codex"].includes(agent?.model?.provider ?? "") ? "subscription " : `~$${cost.toFixed(4)} `;
    const totals = width >= 78 ? paint(` ↑${compact.format(input)} ↓${compact.format(output)} `, "violet") + paint(billing, "gold") : "";
    const thinking = agent?.thinkingLevel ? paint(` · ${safeText(agent.thinkingLevel).replace(/\s+/g, " ")}`, "gold") : "";
    const tail = context + totals + extensions;
    const state = truncateToWidth(activity, Math.max(0, width - visibleWidth(tail + thinking) - 1));
    const modelLabel = truncateToWidth(paint(`  ${model}`, "muted"), Math.max(0, width - visibleWidth(state + tail + thinking) - 1)) + thinking;
    const gap = Math.max(1, width - visibleWidth(state + modelLabel + tail));
    return state + modelLabel + " ".repeat(gap) + tail;
  }
}
