import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRegistry, defineExtension, section, type Extension, type PromptInput } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createJiti } from "jiti";
import { validateChatExtensions } from "./extension-ui.ts";
import Subagents from "./subagents/index.ts";
import { expandPath, loadAgents, Resources, skillPrompt, skillSource, xml, type SkillSourceExtension } from "./resources.ts";

// Adapted from Pi 1.2.0's standard prompt/tool contributions; see NOTICE.
const snippets: Record<string, string> = {
  read: "Read file contents", bash: "Execute bash commands (ls, grep, find, etc.)",
  edit: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
  write: "Create or overwrite files",
};
const guidelines: Record<string, string[]> = {
  bash: ["Use bash for file operations like ls, rg, find"],
  read: ["Use read to examine files instead of cat or sed."],
  edit: ["Use edit for precise changes (edits[].oldText must match exactly)",
    "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
    "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
    "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions."],
  write: ["Use write only for new files or complete rewrites."],
};

export function codingPrompt(resources: Resources, onReport?: (message: string) => void): SkillSourceExtension {
  const cwd = (input: PromptInput) => {
    if (!input.env) throw new Error("Coding requires an execution environment.");
    return input.env.cwd;
  };
  return Object.assign(defineExtension({ name: "pi-d-prompt", sections: [
    section("preamble", () => "You are an expert coding assistant operating inside pi-d, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.", { tag: false }),
    section("tools", ({ agent }) => `${agent.tools.map((tool) => `- ${tool.name}: ${snippets[tool.name] ?? tool.description}`).join("\n") || "(none)"}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`),
    section("rules", ({ agent }) => [...agent.tools.flatMap((tool) => guidelines[tool.name] ?? []), "Be concise in your responses", "Show file paths clearly when working with files"].map((rule) => `- ${rule}`).join("\n")),
    section("host", () => `This is stock pi-durable, not Pi's session runtime. Extensions use Durable's Extension format with optional piD command/footer contributions, not Pi's ExtensionAPI. For this host's extension API and examples read ${fileURLToPath(new URL("../docs/extensions.md", import.meta.url))}. No sandbox: tools and extensions have this user's operating-system permissions. Do not claim file changes or commands succeeded unless their tool results confirm it. Before working in a subdirectory, read any more specific AGENTS.md instructions there.`),
    section("project_context", async (input) => {
      const files = await loadAgents(cwd(input), resources.configDir);
      return files.length ? "Project-specific instructions and guidelines:\n\n" + files.map(({ path, content }) => `<project_instructions path="${xml(path)}">\n${content}\n</project_instructions>`).join("\n\n") : undefined;
    }),
    section("skills", async (input) => {
      const { skills, diagnostics } = await resources.skills(cwd(input));
      if (diagnostics.length) onReport?.(diagnostics.join(" "));
      return input.agent.tools.some((tool) => tool.name === "read") ? skillPrompt(skills) : undefined;
    }),
    section("cwd", (input) => cwd(input)),
  ] }), { [skillSource]: (cwd: string) => resources.skills(cwd) });
}

export async function workspacePath(path: string): Promise<string> {
  const canonical = await realpath(expandPath(path));
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Workspace must be a directory: ${path}`);
  return canonical;
}

async function packageManifest(name: string): Promise<URL> {
  // Resolve from the host, not a guessed node_modules layout (npm can hoist dependencies).
  for (let directory = dirname(fileURLToPath(import.meta.resolve(name)));; directory = dirname(directory)) {
    const path = join(directory, "package.json");
    try {
      if (JSON.parse(await readFile(path, "utf8")).name === name) return pathToFileURL(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(directory) === directory) throw new Error(`Cannot locate the host SDK manifest for ${name}.`);
  }
}

export async function codingRegistry(resources: Resources, paths: string[] = [], onReport?: (message: string) => void) {
  const registry = createRegistry();
  registry.install(CodingTools); registry.install(codingPrompt(resources, onReport)); registry.install(Subagents);
  if (!paths.length) return registry;
  // Reuse the host SDK even for an extension outside this checkout, without a global install.
  const packages = ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/chord", "typebox"];
  const alias: Record<string, string> = {
    "pi-d-chat/extensions": fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./extensions.ts" : "./extensions.js", import.meta.url)),
    "pi-d-chat/subagents": fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./subagents/index.ts" : "./subagents/index.js", import.meta.url)),
  };
  for (const name of packages) {
    const manifest = await packageManifest(name);
    const metadata = JSON.parse(await readFile(manifest, "utf8"));
    for (const [key, value] of Object.entries(metadata.exports ?? { ".": metadata.main })) {
      const target = typeof value === "string" ? value : (value as { import?: string; default?: string }).import ?? (value as { default?: string }).default;
      if (!target) continue;
      const specifier = name + (key === "." ? "" : key.slice(1));
      // jiti resolves directory-prefix aliases, not package exports or wildcard targets.
      alias[specifier.replace(/\/\*$/, "")] = fileURLToPath(new URL(target.replace(/\/\*\.[cm]?js$/, ""), manifest));
    }
  }
  const loader = createJiti(import.meta.url, { alias, interopDefault: false, fsCache: false, nativeModules: packages });
  for (const path of paths) {
    const extension = await loader.import<Extension>(expandPath(path), { default: true });
    if (!extension || typeof extension !== "object" || typeof extension.name !== "string" || !extension.name.trim()) throw new Error(`Extension ${path} must default-export a named Durable Extension object.`);
    if (extension.name === Subagents.name) throw new Error(`Subagents are built in to pi-d. Remove the redundant pi-d-subagents configuration entry or --extension argument: ${path}`);
    if (registry.snapshot().extension(extension.name)) throw new Error(`Duplicate or reserved extension name: ${extension.name}`);
    validateChatExtensions([...registry.snapshot().installed(), extension]);
    registry.install(extension);
  }
  return registry;
}

export const codingEnv = ({ cwd }: { cwd?: string }) => {
  if (!cwd) throw new Error("This session has no workspace. Choose --cwd before using coding tools.");
  return new NodeExecutionEnv({ cwd });
};
