import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { Conversation, ConversationView, ConversationWatch, Harness, LiveState, AgentState } from "@earendil-works/pi-durable";
import { matchesKey, type AutocompleteProvider, type Terminal } from "@earendil-works/pi-tui";
import { watchExtensionFooter } from "./extension-ui.ts";
import { safeText } from "./theme.ts";
import { ChatUI } from "./ui.ts";

export type SessionChoice = { file: string; label: string; description: string };
export type CommandResult = string | { type: "input"; content: string; whenBusy: "steer" | "followUp" }
  | { type: "session"; file: string; fresh?: boolean } | undefined;
export type ChatHandle = {
  harness: Harness;
  conversation: Conversation;
  label: string;
  file?: string;
  models?: Models;
  extensionNames?: string[];
  completion?: AutocompleteProvider;
  sessions?: {
    newFile: (name?: string) => Promise<string>;
    list: (signal: AbortSignal) => Promise<{ choices: SessionChoice[]; diagnostics: string[] }>;
    open: (file: string, fresh: boolean) => Promise<ChatHandle>;
  };
  beforeSubmit?: () => void;
  beforeModel?: () => Promise<void>;
  command?: (text: string, ui: ChatUI, signal: AbortSignal) => Promise<CommandResult>;
  close: () => Promise<void>;
};

export function errorText(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error));
}

// Presentation/admission only. Native submissions, inbox and tasks remain authoritative.
export async function mountChat(initial: ChatHandle, terminal: Terminal, animate = true) {
  const context = BACKGROUND_CONTEXT;
  const ui = new ChatUI(terminal, { animate, sessionLabel: initial.label });
  let chat = initial;
  let watch = await chat.conversation.watch(context);
  let footer: ReturnType<typeof watchExtensionFooter> | undefined;
  const finished = Promise.withResolvers<void>();
  let closing = false, switching = false;
  let closingPromise: Promise<void> | undefined;
  let commandController: AbortController | undefined;
  let admissionWork: Promise<void> | undefined;
  const report = (error: unknown) => { if (!closing && !ui.unavailable) ui.setNotice(errorText(error)); };
  const close = (): Promise<void> => {
    if (closingPromise) return closingPromise;
    closing = true;
    commandController?.abort(new Error("Cancelled."));
    ui.clearExtensionPresentation();
    closingPromise = (async () => {
      const stoppingFooter = footer?.stop();
      try { await admissionWork?.catch(() => {}); await stoppingFooter; await footer?.stop(); await terminal.drainInput(200, 30); }
      finally {
        try { ui.stop(); }
        finally {
          try { await watch.stop(); }
          finally { await chat.close(); }
        }
      }
    })();
    closingPromise.then(finished.resolve, finished.reject);
    return closingPromise;
  };
  const observe = async (owner: ChatHandle, observer: ConversationWatch) => {
    let entries: ConversationView["entries"] | undefined, contextTokens = 0;
    const render = async (view: ConversationView) => {
      if (closing || switching || chat !== owner) return;
      ui.setView(view);
      if (entries !== view.entries) {
        contextTokens = estimateContextTokens((await owner.conversation.context(context)).messages).tokens;
        entries = view.entries;
      }
      if (closing || switching || chat !== owner) return;
      const agent = view.docs["pi.agent"] as AgentState | undefined;
      const ref = agent?.model;
      const limit = ref && owner.models?.getModel(ref.provider, ref.modelId)?.contextWindow;
      const partial = (view.docs["pi.live"] as LiveState | undefined)?.generation?.message;
      ui.setContextUsage(limit ? contextTokens + (partial ? estimateMessageTokens(partial) : 0) : undefined, limit);
    };
    if (owner.completion) ui.composer.editor.setAutocompleteProvider(owner.completion);
    await render(observer.value);
    footer = watchExtensionFooter(owner, ui, report);
    void footer.refresh();
    observer.start(render);
    void observer.closed.then((end) => {
      if (!closing && !switching && chat === owner) {
        const reason = "error" in end ? errorText(end.error) : end.reason;
        ui.setUnavailable(`Observation stopped (${reason}). Reopen the session; Ctrl+C to quit.`);
      }
    });
    void owner.harness.closed.then((end) => {
      if (!closing && !switching && chat === owner && end.reason === "failed") ui.setUnavailable(`Storage failed: ${errorText(end.error)}. Reopen the session.`);
    });
  };
  const resume = async () => {
    try { await chat.beforeModel?.(); if (!closing) chat.harness.resume(); }
    catch (error) { report(error); } // Local diagnostics/login/interrupt remain usable while paused.
  };
  const switchSession = async (file: string, fresh: boolean, signal: AbortSignal) => {
    if (!chat.sessions) throw new Error("Session selection is unavailable.");
    if (file === chat.file) { ui.setNotice("This session is already open."); return; }
    const next = await chat.sessions.open(file, fresh);
    let nextWatch: ConversationWatch | undefined;
    let installed = false;
    try {
      nextWatch = await next.conversation.watch(context);
      signal.throwIfAborted();
      switching = true;
      ui.clearExtensionPresentation();
      // Once ownership handoff starts, complete it even if cancelled; shutdown joins this admission.
      await footer?.stop(); footer = undefined;
      await watch.stop();
      await chat.close();
      chat = next; watch = nextWatch; installed = true;
      ui.setSessionLabel(chat.label); ui.setNotice("");
      ui.tui.resetTextSelection(); ui.scroll.scrollToEnd();
      switching = false;
      await observe(chat, watch);
      await resume();
    } catch (error) {
      if (switching || installed) ui.setUnavailable("Session handoff failed. Reopen the session; Ctrl+C to quit.");
      throw error;
    } finally {
      switching = false;
      if (!installed) { try { await nextWatch?.stop(); } finally { await next.close(); } }
    }
  };
  const submit = async (original: string, controller: AbortController): Promise<void> => {
    let admitted = false;
    const owner = chat;
    try {
      let result: CommandResult;
      try { result = owner.command ? await owner.command(original, ui, controller.signal) : original; }
      finally { if (chat === owner) void footer?.refresh(); }
      if (result === undefined) return;
      if (typeof result !== "string" && result.type === "session") {
        await switchSession(result.file, result.fresh ?? false, controller.signal); return;
      }
      const content = typeof result === "string" ? result : result.content;
      const whenBusy = typeof result === "string" ? "reject" : result.whenBusy;
      await owner.beforeModel?.();
      controller.signal.throwIfAborted();
      if (closing) return;
      owner.beforeSubmit?.();
      const submission = await owner.conversation.submit({ type: "input", content, whenBusy }, context);
      admitted = true;
      if (controller.signal.aborted) {
        const withdrawn = await submission.abort(context);
        if (withdrawn === "already_placed") void owner.conversation.abort(context).catch(report);
      }
      ui.composer.editor.addToHistory(original);
      // Waiting does not hold local admission or create an app queue; Durable owns settlement/recovery.
      void submission.wait(context).then((receipt) => {
        if (!closing && chat === owner && receipt.status === "unanswered" && receipt.reason !== "aborted") {
          ui.setNotice(receipt.detail === undefined ? receipt.reason ?? "unanswered" : JSON.stringify(receipt.detail));
        }
      }, (error) => { if (chat === owner) report(error); });
    } catch (error) {
      if (!admitted && !closing) {
        const draft = ui.composer.editor.getExpandedText();
        ui.composer.editor.setText(draft ? `${original}\n\n${draft}` : original);
      }
      report(error);
    } finally {
      if (commandController === controller) {
        commandController = undefined;
        if (!closing) ui.setAdmitting(false);
      }
    }
  };
  ui.composer.editor.onSubmit = (text) => {
    if (!text.trim() || closing || ui.unavailable || commandController) return;
    ui.setNotice(""); ui.setAdmitting(true, text.startsWith("/") && !text.startsWith("//") ? "command" : "saving");
    commandController = new AbortController();
    admissionWork = submit(text, commandController);
  };
  ui.tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      if (ui.tui.hasActiveSelection()) {
        void ui.tui.copyActiveSelectionToClipboard().catch(report); return { consume: true };
      }
      if (commandController) commandController.abort(new Error("Cancelled."));
      else void close().catch(() => {});
      return { consume: true };
    }
    if (matchesKey(data, "escape") && ui.composer.editor.isShowingAutocomplete()) return undefined;
    if (matchesKey(data, "escape") && commandController) {
      commandController.abort(new Error("Cancelled.")); return { consume: true };
    }
    if (matchesKey(data, "escape") && ui.busy) {
      void chat.conversation.abort(context).catch(report);
      return { consume: true };
    }
    return undefined;
  });
  try {
    await observe(chat, watch);
    ui.start();
    await resume();
  } catch (error) {
    await close().catch(() => {});
    await finished.promise.catch(() => {});
    throw error;
  }
  return { ui, close, closed: finished.promise, get chat() { return chat; } };
}
