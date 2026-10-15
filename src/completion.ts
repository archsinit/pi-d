import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { CombinedAutocompleteProvider, type AutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import type { ChatHandle } from "./chat.ts";
import { commands } from "./command-list.ts";
import { extensionCommands } from "./extension-ui.ts";
import type { Resources } from "./resources.ts";
import { safeText } from "./theme.ts";

export { commands } from "./command-list.ts";

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
        const choices: SlashCommand[] = [...commands.map((command) => ({ ...command })), ...await extensionCommands(chat, options.signal)];
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
