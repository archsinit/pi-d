import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Extension } from "@earendil-works/pi-durable";
import type { AutocompleteItem, SlashCommand } from "@earendil-works/pi-tui";
import type { ChatHandle } from "./chat.ts";
import { commands } from "./command-list.ts";
import type { ChatExtension, ChatExtensionContext, FooterStatus } from "./extensions.ts";
import { safeText } from "./theme.ts";
import type { ChatUI } from "./ui.ts";

type Owner = Pick<ChatHandle, "harness" | "conversation">;
const commandName = /^[a-z][a-z0-9_-]*$/;
const tones = new Set(["text", "muted", "dim", "green", "cyan", "gold", "red", "violet"]);
const oneLine = (text: string) => safeText(text).replace(/\s+/g, " ");

/** Validate at load time, including collisions with disabled extensions, rather than silently shadowing controls. */
export function validateChatExtensions(extensions: readonly Extension[]): void {
  const names = new Set(commands.map((command) => command.name));
  for (const extension of extensions as readonly ChatExtension[]) {
    const contribution = extension.piD;
    const invalid = () => new Error(`Extension ${extension.name} has invalid piD contributions.`);
    if (contribution === undefined) continue;
    if (!contribution || typeof contribution !== "object" || Array.isArray(contribution)) throw invalid();
    if (contribution.footer !== undefined && typeof contribution.footer !== "function") throw invalid();
    if (contribution.commands !== undefined && !Array.isArray(contribution.commands)) throw invalid();
    for (const command of contribution.commands ?? []) {
      if (!command || typeof command.name !== "string" || !commandName.test(command.name)
        || typeof command.description !== "string" || !command.description.trim() || typeof command.execute !== "function"
        || (command.argumentHint !== undefined && typeof command.argumentHint !== "string")
        || (command.complete !== undefined && typeof command.complete !== "function")) throw invalid();
      if (names.has(command.name)) throw new Error(`Duplicate or reserved command /${command.name} in extension ${extension.name}.`);
      names.add(command.name);
    }
  }
}

export function extensionContext(owner: Owner, signal: AbortSignal): ChatExtensionContext {
  return { harness: owner.harness, conversation: owner.conversation, signal, context: withAbortSignal(signal, BACKGROUND_CONTEXT) };
}

async function selected(owner: Owner, signal: AbortSignal, validate = true): Promise<readonly ChatExtension[]> {
  signal.throwIfAborted();
  const extensions = (await owner.conversation.agent(withAbortSignal(signal, BACKGROUND_CONTEXT))).extensions;
  signal.throwIfAborted();
  if (validate) validateChatExtensions(extensions);
  return extensions;
}

/** Help and completion always use the current native agent selection, not an installed-only cache. */
export async function extensionCommands(owner: Owner, signal: AbortSignal): Promise<SlashCommand[]> {
  return (await selected(owner, signal)).flatMap((extension) => (extension.piD?.commands ?? []).map((command): SlashCommand => ({
    name: command.name, description: oneLine(command.description),
    argumentHint: command.argumentHint === undefined ? undefined : oneLine(command.argumentHint),
    getArgumentCompletions: command.complete ? async (prefix) => {
      try {
        signal.throwIfAborted();
        const items = await command.complete!(prefix, extensionContext(owner, signal));
        if (signal.aborted || items === null) return null;
        return items.map((item): AutocompleteItem => ({
          value: oneLine(item.value), label: oneLine(item.label),
          description: item.description === undefined ? undefined : oneLine(item.description),
        }));
      } catch { return null; }
    } : undefined,
  })));
}

export async function executeExtensionCommand(owner: Owner, name: string, argument: string, ui: ChatUI, signal: AbortSignal): Promise<boolean> {
  const match = (await selected(owner, signal)).flatMap((extension) => (extension.piD?.commands ?? []).map((command) => ({ extension, command })))
    .find(({ command }) => command.name === name);
  if (!match) return false;
  signal.throwIfAborted();
  const { command, extension } = match, source = `${extension.name} /${command.name}`;
  let active = true;
  const visible = () => active && !signal.aborted;
  try {
    const execution = command.execute(argument, {
      ...extensionContext(owner, signal),
      notify: (message) => { if (visible()) ui.setNotice(message); },
      message: (text, options) => { if (visible()) ui.addExtensionMessage(source, text, options); },
      toast: (text, options) => { if (visible()) ui.addExtensionToast(source, text, options); },
    });
    // Synchronous handlers end now, not after an await that could admit their queued late callbacks.
    if (execution && typeof execution.then === "function") await execution;
  } finally { active = false; }
  return true; // Even an untyped extension's return value is never submitted to the model.
}

function footerItems(value: unknown): readonly FooterStatus[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid footer status.");
  const items: FooterStatus[] = [];
  for (let index = 0; index < value.length; index++) {
    // Indexed validation must see holes; never pass provider objects/accessors/iterators to the renderer.
    if (!Object.hasOwn(value, index)) throw new Error("Invalid footer status.");
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid footer status.");
    const { text, tone, bold, strikethrough } = item;
    if (typeof text !== "string" || (tone !== undefined && !tones.has(tone))
      || (bold !== undefined && typeof bold !== "boolean")
      || (strikethrough !== undefined && typeof strikethrough !== "boolean")) throw new Error("Invalid footer status.");
    const normalized = oneLine(text).trim();
    if (normalized) items.push({ text: normalized, tone, bold, strikethrough });
  }
  return items;
}

/** Mounted-session resources only. Callbacks run off the mutation line; custom session docs need no polling. */
export function watchExtensionFooter(owner: Owner, ui: ChatUI, report: (error: unknown) => void) {
  const controller = new AbortController(), signal = controller.signal;
  const failed = new Set<string>();
  let dirty = false, pending: Promise<void> | undefined, stopped: Promise<void> | undefined;
  const render = async () => {
    const items: FooterStatus[] = [];
    // Declarations are validated at load; do not invoke provider accessors outside their boundary on refresh.
    for (const extension of await selected(owner, signal, false)) {
      signal.throwIfAborted();
      try {
        const provider = extension.piD?.footer;
        if (provider === undefined) continue;
        const contribution = footerItems(await provider.call(extension.piD, extensionContext(owner, signal)));
        for (const item of contribution) items.push(item);
        failed.delete(extension.name);
      } catch {
        if (!signal.aborted && !failed.has(extension.name)) {
          failed.add(extension.name);
          report(new Error(`Extension ${extension.name}: footer failed.`));
        }
      }
    }
    if (!signal.aborted) ui.setExtensionStatus(items);
  };
  const refresh = (): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    dirty = true;
    // A commit subscriber must not await reads on the mutation line it observes.
    return pending ??= Promise.resolve().then(async () => {
      while (dirty && !signal.aborted) {
        dirty = false;
        try { await render(); }
        catch { if (!signal.aborted) report(new Error("Extension footer refresh failed.")); }
      }
    }).finally(() => { pending = undefined; if (dirty && !signal.aborted) void refresh(); });
  };
  const unsubscribe = owner.harness.subscribeCommits(() => { void refresh(); });
  return {
    refresh,
    stop: () => stopped ??= (async () => {
      unsubscribe(); controller.abort(new Error("Chat UI detached."));
      ui.setExtensionStatus([]);
      await pending;
    })(),
  };
}
