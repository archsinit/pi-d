import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, LiveDoc, type HarnessInspection } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ChatHandle } from "./chat.ts";

// Inert names only, in the authoritative store. Never an executable startup configuration.
export const LoadedExtensions = defineDoc<{ names: string[] }>({
  kind: "pi-d.loaded-extensions", version: 1, scope: "session", initial: () => ({ names: [] }),
});

export async function recoveryStatus(chat: ChatHandle) {
  const context = BACKGROUND_CONTEXT;
  const inspection = await chat.harness.inspect(context);
  const required = await chat.harness.snapshot(LoadedExtensions, context);
  const missing = (required?.names ?? []).filter((name) => !chat.extensionNames?.includes(name));
  const blocked = inspection.tasks.filter((task) => task.state.kind === "blocked");
  return { inspection, missing, blocked };
}

export async function requireRecoveryReady(chat: ChatHandle): Promise<void> {
  const { inspection, missing, blocked } = await recoveryStatus(chat);
  if (blocked.length || (missing.length && (inspection.tasks.length || inspection.submissions.length))) {
    throw new Error(`Recovery is blocked${missing.length ? `; missing extensions: ${missing.join(", ")}` : ""}. Use /status; restore the trusted extensions in the config extensions/ directory or with --extension, or /interrupt to stop foreground work.`);
  }
}

function taskText(task: HarnessInspection["tasks"][number]): string {
  const { record, state } = task;
  return `${record.id} · ${record.kind} · ${state.kind}${state.kind === "blocked" ? ` (${state.reason})` : ""}${record.background ? " · background" : ""}`;
}

/** Read-only diagnostics: no resume, wait, token refresh, module loading or provider request. */
export async function sessionStatus(chat: ChatHandle, models: Models): Promise<string> {
  const context = BACKGROUND_CONTEXT;
  const { inspection, missing, blocked } = await recoveryStatus(chat);
  const agent = await chat.conversation.agent(context);
  const live = await chat.harness.snapshot(LiveDoc, chat.conversation.id, context);
  const auth = agent.model && await models.checkAuth(agent.model.provider);
  const retry = live?.generation?.retry;
  const tokens = estimateContextTokens((await chat.conversation.context(context)).messages).tokens;
  const limit = agent.model && models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow;
  return [
    `Session: ${chat.file ?? chat.label}`,
    `Conversation: ${chat.conversation.id}`,
    `Workspace: ${agent.cwd ?? "offline demo"}`,
    `Model: ${agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "not selected"} · ${agent.thinkingLevel}`,
    `Active context: ~${tokens} tokens${limit ? ` / ${limit} (${Math.round(tokens / limit * 100)}%)` : " (model limit unavailable)"}; not subscription quota`,
    `Authentication: ${auth?.type ?? "not connected"} (local status only)`,
    "Paused authentication requires /login or the provider's environment credentials; inspecting status never connects or resumes work.",
    `Scheduling: ${inspection.scheduling}`,
    `Selected extensions: ${agent.extensions.map((extension) => extension.name).join(", ") || "none"}`,
    `Missing recovery extensions: ${missing.join(", ") || "none"}`,
    `Blocked tasks: ${blocked.length}`,
    ...(retry ? [`Provider retry: attempt ${live!.generation!.attempt} · in ${Math.max(0, Math.ceil((retry.at - Date.now()) / 1000))}s`] : []),
    `Compactions: ${live?.compactions?.map((item) => `${item.reason}${item.retry ? " (retrying)" : ""}`).join(", ") || "none"}${live?.compactionFailure ? " · latest compaction failed" : ""}`,
    `Unsettled submissions: ${inspection.submissions.length}`,
    "\nLive tasks:", ...inspection.tasks.map(taskText),
    ...(inspection.tasks.length ? [] : ["none"]),
    "\nOpening a session can replay model requests. /interrupt stops foreground work and withdraws queued inputs; background work survives. File effects are not undone.",
    ...(missing.length ? ["Restore trusted extensions in the config extensions/ directory or with --extension; stored names never execute code."] : []),
  ].join("\n");
}
