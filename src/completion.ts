import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { CombinedAutocompleteProvider, type AutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import type { ChatHandle } from "./chat.ts";
import type { Resources } from "./resources.ts";
import { safeText } from "./theme.ts";

export const commands: SlashCommand[] = [
  { name: "new", description: "Reset active context; keep stored history and draft" },
  { name: "clear", description: "Same as /new" },
  { name: "session-new", argumentHint: "[name]", description: "Create a separate session for this workspace" },
  { name: "resume", description: "Choose a saved session for this workspace" },
  { name: "status", description: "Session, workspace, authentication and recovery diagnostics" },
  { name: "login", description: "ChatGPT subscription login" },
  { name: "logout", description: "Remove pi-d's local ChatGPT credentials" },
  { name: "model", argumentHint: "[provider/id]", description: "Select a model" },
  { name: "reasoning", argumentHint: "[level]", description: "Select supported thinking" },
  { name: "skills", description: "List skills and diagnostics" },
  { name: "extensions", description: "List installed Durable extensions" },
  { name: "steer", argumentHint: "text", description: "Guide the current run after its tool round" },
  { name: "followup", argumentHint: "text", description: "Queue input for after the current run" },
  { name: "interrupt", description: "Stop foreground work and withdraw queued inputs (same as Escape)" },
  { name: "queue", description: "Show Durable's queued inputs" },
  { name: "withdraw", argumentHint: "[id]", description: "Withdraw one queued input" },
  { name: "help", description: "Commands and workspace" },
];

/** Command-only completion: no implicit filesystem crawl, attachment expansion or model request. */
export function commandCompletion(chat: ChatHandle, models: Models, resources?: Resources): AutocompleteProvider {
  const apply = new CombinedAutocompleteProvider([], ".");
  return {
    triggerCharacters: ["/"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
      if (cursorLine !== 0 || !text.startsWith("/") || text.startsWith("//")) return null;
      try {
        if (options.signal.aborted) return null;
        const choices = commands.map((command) => ({ ...command }));
        choices.find((command) => command.name === "model")!.getArgumentCompletions = (prefix) => models.getModels()
          .map((model) => `${model.provider}/${model.id}`).sort().filter((id) => id.startsWith(prefix))
          .map((value) => ({ value, label: value }));
        choices.find((command) => command.name === "reasoning")!.getArgumentCompletions = async (prefix) => {
          const ref = (await chat.conversation.agent(BACKGROUND_CONTEXT)).model;
          const model = ref && models.getModel(ref.provider, ref.modelId);
          return model ? getSupportedThinkingLevels(model).filter((level) => level.startsWith(prefix)).map((value) => ({ value, label: value })) : [];
        };
        if (resources && !/\s/.test(text)) {
          const cwd = (await chat.conversation.agent(BACKGROUND_CONTEXT)).cwd;
          if (cwd) {
            // Discovery diagnostics belong in /skills; don't expose parse errors in the editor.
            try {
              const { skills } = await resources.skills(cwd);
              choices.push(...skills.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, argumentHint: "[request]" })));
            } catch { /* Base commands remain usable when a skill root cannot be read. */ }
          }
        }
        if (options.signal.aborted) return null;
        for (const choice of choices) choice.description = safeText(choice.description ?? "").replace(/\s+/g, " ");
        // Native forced Tab otherwise switches to file completion; this provider is deliberately commands only.
        return await new CombinedAutocompleteProvider(choices, ".").getSuggestions(lines, cursorLine, cursorCol, { ...options, force: false });
      } catch { return null; } // Native Editor does not catch rejected providers; stale/failed reads must not poison it.
    },
    applyCompletion: (...args) => apply.applyCompletion(...args),
    shouldTriggerFileCompletion: (lines, line, col) => line === 0 && /^\/(?!\/)/.test((lines[line] ?? "").slice(0, col)),
  };
}
