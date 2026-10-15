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

export interface ChatCommandContext extends ChatExtensionContext {
  /** Show a plain-text notice during this command. Ignored after completion/cancellation; never enters the transcript. */
  notify(message: string): void;
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
