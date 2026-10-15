import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { InboxDoc, type SubmissionId, type UserInput } from "@earendil-works/pi-durable";
import type { SlashCommand } from "@earendil-works/pi-tui";
import type { ChatHandle } from "./chat.ts";
import { Dialog, showDialog } from "./dialog.ts";
import { commands } from "./command-list.ts";
import { executeExtensionCommand, extensionCommands } from "./extension-ui.ts";
import type { ChatExtension } from "./extensions.ts";
import { connectSubscription } from "./login.ts";
import { Resources, xml } from "./resources.ts";
import { parseModel, parseThinking } from "./session.ts";
import { pickSession } from "./sessions.ts";
import { requireRecoveryReady, sessionStatus } from "./status.ts";
import type { ChatUI } from "./ui.ts";

const help = (extra: SlashCommand[]) => [...commands, ...extra].map((command) => `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""} · ${command.description}`).join("\n")
  + "\n/skill:name [request] · Load full skill instructions\n\nCommands are local except /skill, /steer and /followup, which admit model input. Prefix // to send a literal slash command.\nTab completes · Escape cancels · Ctrl+C closes";

export async function requireSubscription(chat: ChatHandle, models: Models): Promise<void> {
  const provider = (await chat.conversation.agent(BACKGROUND_CONTEXT)).model?.provider;
  if (provider && ["openai", "openai-codex"].includes(provider) && (await models.checkAuth(provider))?.type !== "oauth") {
    throw new Error(`ChatGPT is not connected for ${provider}. Use /login, then /model openai-codex/gpt-6.1-sol if needed. OpenAI API keys are not used.`);
  }
}

const inboxText = (input: UserInput) => typeof input === "string" ? input : input.map((part) => part.type === "text" ? part.text : "[image]").join("\n");

async function idle(chat: ChatHandle, action = "changing settings or authentication"): Promise<void> {
  const inspection = await chat.harness.inspect(BACKGROUND_CONTEXT);
  if (inspection.tasks.length || inspection.submissions.length) throw new Error(`Unfinished work exists. /interrupt or Escape stops foreground work; wait for background work before ${action}.`);
}

async function login(models: Models, ui: ChatUI, parent: AbortSignal): Promise<void> {
  await models.checkAuth("openai-codex"); // Validate existing private credentials before starting the browser flow.
  const controller = new AbortController(), signal = AbortSignal.any([parent, controller.signal]);
  const waiting = new Dialog(ui.tui, "ChatGPT subscription login. No model request is made.");
  waiting.onCancel = () => controller.abort(new Error("Login cancelled."));
  const overlay = ui.tui.showOverlay(waiting, { width: "90%", maxHeight: "100%", margin: 1 });
  let current: Dialog | undefined;
  try {
    await connectSubscription(models, { signal,
      notify: (event) => {
        const text = event.type === "auth_url" ? `Open this link in your browser:\n${event.url}` : event.type === "device_code" ? `${event.verificationUri}\nEnter this code in your browser: ${event.userCode}` : event.message;
        if (event.type === "auth_url" || event.type === "device_code") waiting.info = text;
        else waiting.message = text;
        if (current) current.info = waiting.info;
        ui.tui.requestRender();
      },
      prompt: async (prompt) => {
        if (prompt.type !== "select" && prompt.type !== "manual_code") throw new Error("Unexpected ChatGPT login prompt.");
        if (prompt.type === "select" && !prompt.options.length) throw new Error("No ChatGPT login methods available.");
        const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
        current = new Dialog(ui.tui, prompt.message, prompt.type === "select" ? prompt.options.map((item) => ({ value: item.id, label: item.label, description: item.description })) : undefined);
        current.info = waiting.info;
        try { return await showDialog(ui.tui, current, promptSignal); }
        catch (error) { if (!promptSignal.aborted) controller.abort(new Error("Login cancelled.")); throw error; }
        finally { current = undefined; }
      },
    });
  } finally { overlay.hide(); }
}

/** Local controls return no input; model-bound commands return native admission intent. */
export function chatCommands(chat: ChatHandle, models: Models, resources?: Resources): NonNullable<ChatHandle["command"]> {
  return async (text, ui, signal) => {
    signal.throwIfAborted();
    if (text.startsWith("//")) return text.slice(1);
    const match = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return text;
    const [, command, raw = ""] = match, argument = raw.trim(), context = BACKGROUND_CONTEXT;
    if (command === "help") { await showDialog(ui.tui, new Dialog(ui.tui, `Workspace: ${(await chat.conversation.agent(context)).cwd ?? "offline demo"}\n\n${help(await extensionCommands(chat, signal))}`), signal); return; }
    if (command === "status") {
      if (argument) throw new Error("Use /status without arguments.");
      await showDialog(ui.tui, new Dialog(ui.tui, await sessionStatus(chat, models)), signal); return;
    }
    if (command === "steer" || command === "followup") {
      if (!argument) throw new Error(`Use /${command} followed by the input to send.`);
      return { type: "input", content: raw, whenBusy: command === "steer" ? "steer" : "followUp" };
    }
    if (command === "interrupt") {
      if (argument) throw new Error("Use /interrupt without arguments.");
      signal.throwIfAborted();
      await chat.conversation.abort(context);
      ui.setNotice("Foreground work interrupted; queued inputs withdrawn. Background work is not stopped; file effects are not undone."); return;
    }
    if (command === "queue" || command === "withdraw") {
      const items = (await chat.harness.snapshot(InboxDoc, chat.conversation.id, context))?.items.filter((item) => item.mode !== "write") ?? [];
      if (command === "queue") {
        if (argument) throw new Error("Use /queue without arguments.");
        await showDialog(ui.tui, new Dialog(ui.tui, "Queued inputs (native Durable inbox):\n\n" + (items.map((item) => `${item.id} · ${item.mode}\n${inboxText(item.content)}`).join("\n\n") || "none") + "\n\nUse /withdraw id to remove one; /interrupt removes all queued inputs and stops foreground work."), signal); return;
      }
      if (!items.length) throw new Error("No queued inputs to withdraw.");
      const selected = argument || await showDialog(ui.tui, new Dialog(ui.tui, "Withdraw a queued input", items.map((item) => ({ value: String(item.id), label: `${item.id} · ${item.mode}`, description: typeof item.content === "string" ? item.content : "input with attachments" }))), signal);
      if (!/^\d+$/.test(selected) || !Number.isSafeInteger(Number(selected)) || !items.some((item) => item.id === Number(selected))) throw new Error("Choose an ID from /queue.");
      signal.throwIfAborted();
      const result = await chat.harness.abortSubmission(Number(selected) as SubmissionId, context, chat.conversation.id);
      ui.setNotice(result === "aborted" ? `Queued input ${selected} withdrawn.` : `Input ${selected} is ${result}; already-placed work was not interrupted.`); return;
    }
    if (command === "session-new" || command === "resume") {
      if (!chat.sessions) throw new Error("Session selection is disabled in this chat.");
      if (command === "resume" && argument) throw new Error("Use /resume without arguments, or --session path on startup.");
      await idle(chat, "switching sessions");
      const file = command === "session-new" ? await chat.sessions.newFile(argument) : await (async () => {
        const { choices, diagnostics } = await chat.sessions!.list(signal);
        return pickSession(ui, choices, diagnostics, signal);
      })();
      signal.throwIfAborted(); await idle(chat, "switching sessions");
      return { type: "session", file, fresh: command === "session-new" };
    }
    if (command === "new" || command === "clear") {
      if (argument) throw new Error(`Use /${command} without arguments.`);
      await idle(chat, "resetting context");
      signal.throwIfAborted();
      await chat.conversation.reset(undefined, context);
      ui.tui.resetTextSelection(); ui.scroll.scrollToEnd(); ui.setNotice("");
      return;
    }
    if (command === "model" || command === "reasoning") {
      await idle(chat);
      const current = await chat.conversation.agent(context);
      if (command === "model") {
        const choices = models.getModels().map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}` })).sort((a, b) => a.value.localeCompare(b.value));
        const dialog = new Dialog(ui.tui, "Choose a model · type to filter", choices);
        dialog.list?.setSelectedIndex(Math.max(0, choices.findIndex((item) => item.value === `${current.model?.provider}/${current.model?.modelId}`)));
        const selected = argument || await showDialog(ui.tui, dialog, signal);
        const ref = parseModel(selected);
        if (!models.getModel(ref.provider, ref.modelId)) throw new Error(`Unknown chat model ${selected}.`);
        signal.throwIfAborted(); await idle(chat);
        if (ref.provider !== current.model?.provider || ref.modelId !== current.model.modelId) await chat.conversation.configure({ model: ref, thinkingLevel: null }, context);
        ui.setNotice(`Model: ${selected}. Reasoning: ${(await chat.conversation.agent(context)).thinkingLevel}.`);
        try { await requireSubscription(chat, models); if (!signal.aborted) chat.harness.resume(); } catch (error) { ui.setNotice((error as Error).message); }
      } else {
        const model = current.model && models.getModel(current.model.provider, current.model.modelId);
        if (!model) throw new Error("Choose a model first with /model.");
        const levels = getSupportedThinkingLevels(model);
        const dialog = new Dialog(ui.tui, "Choose reasoning", levels.map((level) => ({ value: level, label: level })));
        dialog.list?.setSelectedIndex(Math.max(0, levels.indexOf(current.thinkingLevel)));
        const selected = argument || await showDialog(ui.tui, dialog, signal);
        const level = parseThinking(selected);
        if (!levels.includes(level)) throw new Error(`Unsupported reasoning. Supported: ${levels.join(", ")}.`);
        signal.throwIfAborted(); await idle(chat);
        await chat.conversation.configure({ thinkingLevel: level }, context);
        ui.setNotice(`Reasoning: ${level}.`);
      }
      return;
    }
    if (command === "login" || command === "logout") {
      if (!resources) throw new Error("Authentication is disabled in the offline demo.");
      if (argument) throw new Error(`Use /${command} without arguments.`);
      if (command === "logout" || (await chat.harness.inspect(context)).scheduling !== "paused") await idle(chat);
      if (command === "login") {
        await login(models, ui, signal);
        signal.throwIfAborted();
        await requireSubscription(chat, models);
        await requireRecoveryReady(chat);
        signal.throwIfAborted();
        chat.harness.resume(); ui.setNotice("ChatGPT connected.");
      } else {
        for (const provider of ["openai", "openai-codex"]) await models.logout(provider);
        ui.setNotice("Local ChatGPT credentials removed. Server grants are not revoked.");
      }
      return;
    }
    if (command === "extensions") {
      const selected = (await chat.conversation.agent(context)).extensions as readonly ChatExtension[];
      const details = selected.map((extension) => `${extension.name}: ${[
        ...(extension.tools ?? []).map((tool) => tool.name),
        ...(extension.piD?.commands ?? []).map((item) => `/${item.name}`),
        ...(extension.piD?.footer ? ["footer"] : []),
      ].join(", ") || "sections/hooks/tasks"}`).join("\n");
      await showDialog(ui.tui, new Dialog(ui.tui, "Selected Durable extensions:\n" + details + "\n\nTrusted global extensions load from the config extensions/ directory; --extension adds files. Restart after code changes."), signal);
      return;
    }
    if (command === "skills" || command.startsWith("skill:")) {
      if (!resources) throw new Error("Skills are disabled in the offline demo.");
      const cwd = (await chat.conversation.agent(context)).cwd;
      if (!cwd) throw new Error("This session has no workspace.");
      const { skills, diagnostics } = await resources.skills(cwd);
      signal.throwIfAborted();
      if (command === "skills") {
        await showDialog(ui.tui, new Dialog(ui.tui, skills.map((skill) => `${skill.name}${skill.disableModelInvocation ? " (explicit only)" : ""}: ${skill.description}\n${skill.filePath}`).join("\n\n") + (diagnostics.length ? "\n\n" + diagnostics.join("\n") : "") || "No skills found. Use --skill path or ~/.config/pi-d/skills/."), signal);
        return;
      }
      const skill = skills.find((skill) => skill.name === command.slice(6));
      if (!skill) throw new Error(`Unknown skill ${command.slice(6)}. Use /skills.`);
      const content = await readFile(skill.filePath, "utf8");
      return `<skill name="${xml(skill.name)}" location="${xml(skill.filePath)}">\nResolve relative paths against ${dirname(skill.filePath)}.\n${content}\n</skill>${argument ? "\n\n" + raw : ""}`;
    }
    if (await executeExtensionCommand(chat, command, argument, ui, signal)) return;
    throw new Error(`Unknown command /${command}. Use /help, or // to send it as text.`);
  };
}
