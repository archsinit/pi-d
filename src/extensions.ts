import type { Context } from "@earendil-works/chord/context";
import type { Conversation, Extension, Harness, ToolRegistration } from "@earendil-works/pi-durable";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

type Awaitable<T> = T | Promise<T>;

/** A local UI invocation, outside Durable's mutation line. Use native documents for persistent state. */
export interface ChatExtensionContext {
  readonly harness: Harness;
  readonly conversation: Conversation;
  readonly signal: AbortSignal;
  readonly context: Context;
}

export type ExtensionMessageType = "info" | "success" | "error";
export interface ExtensionMessageOptions {
  /** Host styling; defaults to info. Text is plain, not Markdown or terminal escapes. */
  readonly type?: ExtensionMessageType;
}
export interface ExtensionToastOptions extends ExtensionMessageOptions {
  /** Defaults to 5000 ms. Zero keeps the notification until the user dismisses it. */
  readonly timeoutMs?: number;
}

export interface ChatCommandContext extends ChatExtensionContext {
  /** Show a bottom-bar notice. Ignored after completion/cancellation; never enters the transcript. */
  notify(message: string): void;
  /**
   * Show a labeled scrollback block for this mount only. No model/context/storage effects.
   * Accepted output survives return; calls after completion/cancellation are ignored.
   */
  message(text: string, options?: ExtensionMessageOptions): void;
  /**
   * Queue a focus-free top-left notification; click × to dismiss. No model/context/storage effects.
   * Accepted output survives return; calls after completion/cancellation are ignored.
   */
  toast(text: string, options?: ExtensionToastOptions): void;
}

export interface ChatCommand {
  /** Lowercase letters, digits, underscores and hyphens; no leading slash. Built-ins are reserved. */
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly complete?: (prefix: string, context: ChatExtensionContext) => Awaitable<readonly AutocompleteItem[] | null>;
  /** Arguments are trimmed. The return value is ignored: commands never implicitly admit model input. */
  readonly execute: (argument: string, context: ChatCommandContext) => Awaitable<void>;
}

export type FooterTone = "text" | "muted" | "dim" | "green" | "cyan" | "gold" | "red" | "violet";
export interface FooterStatus {
  /** Plain text only; terminal sequences and line breaks are removed by the host. */
  readonly text: string;
  readonly tone?: FooterTone;
  readonly bold?: boolean;
  readonly strikethrough?: boolean;
}

export interface ChatContributions {
  readonly commands?: readonly ChatCommand[];
  /** Read-only, best-effort rendering on mount, native commits and local commands. No timers or effects here. */
  readonly footer?: (context: ChatExtensionContext) => Awaitable<readonly FooterStatus[] | undefined>;
}

/** A stock Durable extension with optional pi-d presentation contributions. Other Durable hosts ignore piD. */
export interface ChatExtension<Tool extends ToolRegistration = ToolRegistration> extends Extension<Tool> {
  readonly piD?: ChatContributions;
}

/** Identity helper, like Durable's defineExtension(), with types for pi-d's optional UI contributions. */
export function defineChatExtension<Tool extends ToolRegistration = ToolRegistration>(extension: ChatExtension<Tool>): ChatExtension<Tool> {
  return extension;
}
