import type { Message } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { Markdown, stripTerminalSequences, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { ExtensionPresentation } from "./extension-presentation.ts";
import { COMPLETION_ENTRY } from "./subagents/state.ts";
import type { ExtensionMessageOptions } from "./extensions.ts";
import { fill, markdownTheme, paint, safeText } from "./theme.ts";

export function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "thinking") {
      const text = part.redacted ? "[Reasoning redacted]" : part.thinking;
      if (!text.trim()) return "";
      return "> **Thinking**\n>\n" + text.split("\n").map((line) => `> ${line}`).join("\n");
    }
    if (part.type === "image") return "[image]";
    if (part.type === "toolCall") return `${part.name} ${JSON.stringify(part.arguments)}`;
    return "";
  }).filter(Boolean).join("\n\n");
}

class Patch implements Component {
  private readonly patch: string;
  constructor(patch: string) { this.patch = patch; }
  invalidate(): void {}
  render(width: number): string[] {
    return safeText(this.patch).split("\n").flatMap((line) => new Text(
      paint(line, line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : line.startsWith("@@") ? "cyan" : "muted"), 0, 0,
    ).render(width));
  }
}

type BodyBlock = { kind: "text" | "thinking" | "patch"; body: Component } | { kind: "tool"; name: string; body: Component };

export class Transcript implements Component {
  view: ConversationView | undefined;
  private readonly bodies = new WeakMap<object, BodyBlock[]>();
  private readonly summaries = new WeakMap<object, Component>();
  private cachedView: ConversationView | undefined;
  private cachedWidth = -1;
  private lines: string[] = [];
  private readonly extensionMessages: { after: ConversationView["entries"][number]["id"] | undefined; presentation: ExtensionPresentation }[] = [];

  addExtensionMessage(source: string, text: string, options?: ExtensionMessageOptions): void {
    this.extensionMessages.push({ after: this.view?.entries.at(-1)?.id, presentation: new ExtensionPresentation(source, text, options) });
    this.invalidate();
  }

  clearExtensionMessages(): void { this.extensionMessages.length = 0; this.invalidate(); }

  invalidate(): void { this.cachedWidth = -1; }

  render(width: number): string[] {
    if (this.cachedView === this.view && this.cachedWidth === width) return this.lines;
    this.cachedView = this.view;
    this.cachedWidth = width;
    const column = Math.max(1, width);
    const rows: string[] = [];
    const entries = this.view?.entries ?? [];
    const anchors = new Set(entries.map((entry) => entry.id));
    const messages = new Map<ConversationView["entries"][number]["id"] | undefined, ExtensionPresentation[]>();
    for (const { after, presentation } of this.extensionMessages) {
      // Compaction/reset can retire an anchor. Keep its UI-only output before the remaining active entries.
      const anchor = after !== undefined && anchors.has(after) ? after : undefined;
      const bucket = messages.get(anchor) ?? [];
      bucket.push(presentation); messages.set(anchor, bucket);
    }
    const appendExtensions = (anchor: ConversationView["entries"][number]["id"] | undefined) => {
      for (const message of messages.get(anchor) ?? []) {
        rows.push(...new Text(paint(`◇ ${message.label}`, message.tone, true), 0, 0).render(column));
        rows.push(...message.body.render(column), "");
      }
    };
    appendExtensions(undefined);
    for (const entry of entries) {
      if (entry.kind === "pi.compaction") {
        let body = this.summaries.get(entry);
        if (!body) {
          const text = (entry.model ?? []).map(messageText).join("\n\n");
          // Unwrap stock Durable's summary envelope for display only; preserve unfamiliar formats.
          const summary = text.match(/^The conversation history before this point was compacted into the following summary:\n\n<summary>\n([\s\S]*)\n<\/summary>$/)?.[1] ?? text;
          body = new Markdown(safeText(summary), 0, 0, markdownTheme, { color: (s) => paint(s) });
          this.summaries.set(entry, body);
        }
        rows.push(...new Text(paint("◇ Compaction summary", "green", true), 0, 0).render(column));
        rows.push(...body.render(column), "");
      } else {
        for (const message of entry.model ?? []) {
          if (message.role === "system") continue;
          this.appendMessage(rows, message, column, false, entry.kind === COMPLETION_ENTRY ? "◇ Subagent completion" : undefined);
        }
      }
      appendExtensions(entry.id);
    }
    const live = this.view?.docs["pi.live"] as LiveState | undefined;
    for (const tool of [...(live?.tools ?? []), ...(live?.nestedTools ?? [])]) {
      if (tool.status === "done") continue;
      this.appendTool(rows, tool.name, tool.status, new Text(safeText(tool.output ?? ""), 0, 0), column);
      rows.push("");
    }
    if (live?.generation?.message) {
      this.appendMessage(rows, live.generation.message, column, true);
    }
    this.lines = rows.map((line) => fill(truncateToWidth(line, column, ""), width));
    return this.lines;
  }

  private blocks(message: Message): BodyBlock[] {
    const cached = this.bodies.get(message);
    if (cached) return cached;
    const blocks: BodyBlock[] = [];
    if (message.role !== "assistant") {
      blocks.push({ kind: "text", body: new Text(safeText(messageText(message)), 0, 0) });
      if (message.role === "toolResult" && message.toolName === "edit" && !message.isError) {
        const details = message.details;
        if (details && typeof details === "object" && !Array.isArray(details)) {
          const data = details as Record<string, unknown>;
          const patch = typeof data.patch === "string" ? data.patch : typeof data.diff === "string" ? data.diff : undefined;
          if (patch) blocks.push({ kind: "patch", body: new Patch(patch) });
        }
      }
    } else {
      const text: string[] = [];
      const markdown = (value: string) => new Markdown(safeText(value), 0, 0, markdownTheme, { color: (s) => paint(s) });
      const flush = () => {
        const content = text.filter(Boolean).join("\n\n");
        if (content) blocks.push({ kind: "text", body: markdown(content) });
        text.length = 0;
      };
      for (const part of message.content) {
        if (part.type === "text") { text.push(part.text); continue; }
        flush();
        if (part.type === "thinking") {
          const content = safeText(part.redacted ? "[Reasoning redacted]" : part.thinking);
          if (content.trim()) blocks.push({ kind: "thinking", body: markdown(content) });
        } else if (part.type === "toolCall") {
          blocks.push({ kind: "tool", name: part.name, body: new Text(safeText(JSON.stringify(part.arguments)), 0, 0) });
        }
      }
      flush();
    }
    this.bodies.set(message, blocks);
    return blocks;
  }

  private appendTool(rows: string[], name: string, phase: string, body: Component, width: number, failed = false): void {
    const inset = Math.min(2, width - 1), bodyInset = Math.min(4, width - 1);
    const label = failed ? "Tool failed" : phase === "call" ? "Tool call" : phase === "result" ? "Tool result" : "Tool";
    const status = phase === "call" || phase === "result" ? "" : ` · ${phase}`;
    const header = new Text(paint(`↳ ${label} · ${safeText(name).replace(/\s+/g, " ")}${status}`, failed ? "red" : "violet", true), 0, 0);
    rows.push(...header.render(width - inset).map((line) => " ".repeat(inset) + line));
    rows.push(...body.render(width - bodyInset).map((line) => " ".repeat(bodyInset) + line));
    if (failed) rows.push(" ".repeat(bodyInset) + paint("! tool failed", "red"));
  }

  private appendMessage(rows: string[], message: Message, width: number, live: boolean, userLabel?: string): void {
    const blocks = this.blocks(message);
    if (message.role === "user") {
      if (!rows.length) rows.push(""); // Later messages reuse the previous message's spacer.
      rows.push("", paint(userLabel ?? "❯ You", userLabel ? "gold" : "cyan", true));
      for (const block of blocks) rows.push(...block.body.render(width));
      rows.push("");
    } else if (message.role === "toolResult") {
      this.appendTool(rows, message.toolName, "result", blocks[0].body, width, message.isError);
      for (const block of blocks.slice(1)) {
        const inset = Math.min(4, width - 1);
        rows.push(...block.body.render(width - inset).map((line) => " ".repeat(inset) + line));
      }
    } else {
      // A pure tool-call round is an action, not another assistant answer heading.
      if (!blocks.length || blocks.some((block) => block.kind !== "tool")) {
        rows.push(paint("● ", "green") + paint("Assistant", "title", true) + (live ? paint(" · live", "dim") : ""));
      }
      for (const [index, block] of blocks.entries()) {
        if (index) rows.push("");
        if (block.kind === "tool") this.appendTool(rows, block.name, "call", block.body, width);
        else if (block.kind === "thinking") {
          const inset = Math.min(2, width - 1), bodyInset = Math.min(4, width - 1);
          rows.push(" ".repeat(inset) + paint("┆ Thinking", "muted", true));
          rows.push(...block.body.render(width - bodyInset).map((line) => " ".repeat(bodyInset) + paint(stripTerminalSequences(line), "muted")));
        } else rows.push(...block.body.render(width));
      }
    }
    if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
      rows.push(...new Text(paint(`! ${safeText(message.errorMessage ?? message.stopReason)}`, "red"), 0, 0).render(width));
    }
    rows.push("");
  }
}
