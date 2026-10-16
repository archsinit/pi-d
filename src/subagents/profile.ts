import { readFile } from "node:fs/promises";
import type { Context } from "@earendil-works/chord/context";
import type { Agent } from "@earendil-works/pi-durable";
import { skillSource, xml, type SkillSourceExtension } from "../resources.ts";
import { workerTools, legacyTools } from "./tools.ts";
import type { AssignedSkill, Assignment, Capabilities } from "./state.ts";

export const orchestrationTools = new Set(["delegate", "agent_results", "agent_stop", "agent_message"]);
export function skillInstructions(capabilities: Capabilities | undefined): string | undefined {
  if (!capabilities?.skills.length) return;
  return ["The coordinator explicitly assigned these skill instructions. Resolve their relative paths against the skill file's directory; use absolute paths in tools.",
    ...capabilities.skills.map((skill) => `<assigned_skill name="${xml(skill.name)}" path="${xml(skill.filePath)}">\n${skill.content}\n</assigned_skill>`),
  ].join("\n\n");
}
type Selection = { name: string; task: string; role?: string; skills?: string[]; extensions?: string[] };
function names(values: string[] | undefined, kind: "skill" | "extension"): string[] {
  // Native extension names are opaque identifiers; do not narrow their allowed spelling.
  const result = (values ?? []).map((value) => kind === "skill" ? value.trim() : value);
  if (result.some((value) => !value.trim())) throw new Error(`Assigned ${kind} names must not be blank.`);
  if (new Set(result).size !== result.length) throw new Error(`Assigned ${kind} names must not repeat.`);
  return result;
}

/** Resolve only the calling agent's selections, outside the mutation line; never save code or extension paths to load. */
export async function assignments(selections: Selection[], agent: Agent, cwd: string, context: Context): Promise<Assignment[]> {
  const requests = selections.map((selection) => ({ name: selection.name.trim(), task: selection.task.trim(), role: selection.role?.trim() || "worker",
    skills: names(selection.skills, "skill"), extensions: names(selection.extensions, "extension") }));
  if (requests.some((request) => !request.name || !request.task)) throw new Error("Worker names and tasks must not be blank.");
  for (const request of requests) for (const name of request.extensions) {
    if (!agent.extensions.some((extension) => extension.name === name)) throw new Error(`Extension ${JSON.stringify(name)} is not enabled for the orchestrator.`);
  }
  const requestedSkills = [...new Set(requests.flatMap((request) => request.skills))], loaded = new Map<string, AssignedSkill>();
  if (requestedSkills.length) {
    const source = (agent.extensions.find((extension) => extension.name === "pi-d-prompt") as SkillSourceExtension | undefined)?.[skillSource];
    if (typeof source !== "function") throw new Error("The orchestrator has no skill catalog.");
    const { skills } = await source(cwd);
    context.abortSignal?.throwIfAborted();
    for (const name of requestedSkills) {
      const skill = skills.find((skill) => skill.name === name);
      if (!skill) throw new Error(`Skill ${JSON.stringify(name)} is not available to the orchestrator.`);
      let content: string;
      try { content = (await readFile(skill.filePath, { encoding: "utf8", signal: context.abortSignal })).replace(/^\uFEFF/, ""); }
      catch { context.abortSignal?.throwIfAborted(); throw new Error(`Assigned skill ${JSON.stringify(name)} cannot be read.`); }
      loaded.set(name, { name, filePath: skill.filePath, content });
    }
  }
  const available = [...agent.tools, ...agent.callable, ...agent.deferred], enabled = new Set(available.map((tool) => tool.name));
  const modelTools = new Set(agent.tools.map((tool) => tool.name)), callable = new Set(agent.callable.map((tool) => tool.name));
  const modelCallable = new Set(available.filter((tool) => tool.callers === undefined || tool.callers.includes("model")).map((tool) => tool.name));
  const legacy = new Set(legacyTools.map((tool) => tool.name));
  context.abortSignal?.throwIfAborted();
  return requests.map((request) => {
    // Preserve the parent's composition order, even when names were supplied in a different order.
    const extensions = agent.extensions.filter((extension) => request.extensions.includes(extension.name));
    const tools = [...new Set([...workerTools, ...extensions.flatMap((extension) => extension.tools ?? [])].map((tool) => tool.name))]
      .filter((name) => enabled.has(name) && !orchestrationTools.has(name) && !legacy.has(name));
    return { name: request.name, task: request.task, role: request.role, capabilities: {
      skills: request.skills.map((name) => loaded.get(name)!), extensions: extensions.map((extension) => extension.name),
      tools, modelTools: tools.filter((name) => modelTools.has(name)), modelCallable: tools.filter((name) => modelCallable.has(name)), callable: tools.filter((name) => callable.has(name)),
    } };
  });
}
