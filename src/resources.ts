import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";

export type Skill = { name: string; description: string; filePath: string; disableModelInvocation: boolean };
export const expandPath = (path: string) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
export const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

async function optionalFile(path: string): Promise<string | undefined> {
  try { return (await readFile(path, "utf8")).replace(/^\uFEFF/, ""); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function loadAgents(cwd: string, configDir: string) {
  const directories: string[] = [];
  for (let path = resolve(cwd);; path = dirname(path)) {
    directories.unshift(path);
    if (dirname(path) === path) break;
  }
  const files: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const directory of [configDir, ...directories]) {
    for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
      const path = join(directory, name), content = await optionalFile(path);
      if (content === undefined) continue;
      const canonical = await realpath(path);
      if (!seen.has(canonical)) { files.push({ path, content }); seen.add(canonical); }
      break;
    }
  }
  return files;
}

async function optionalStat(path: string) {
  try { return await stat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export class Resources {
  readonly configDir: string;
  readonly skillPaths: string[];
  private readonly home: string;
  constructor(configDir: string, skillPaths: string[] = [], home = homedir()) {
    this.configDir = configDir; this.skillPaths = skillPaths.map(expandPath); this.home = home;
  }

  /** Only the user-controlled config directory is executable by default, never a project. */
  async extensionPaths(paths: string[] = [], autoDiscover = true): Promise<string[]> {
    const files: string[] = [];
    if (autoDiscover) {
      const root = join(this.configDir, "extensions");
      let names: string[];
      try { names = await readdir(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
      for (const name of names.sort()) {
        if (name.startsWith(".") || name === "node_modules") continue;
        const path = join(root, name), info = await optionalStat(path);
        if (info?.isFile() && /\.(?:ts|[cm]?js)$/.test(name) && !name.endsWith(".d.ts")) files.push(path);
        else if (info?.isDirectory()) {
          // One entry point per extension; helpers are not scanned recursively.
          for (const entry of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
            const candidate = join(path, entry);
            if ((await optionalStat(candidate))?.isFile()) { files.push(candidate); break; }
          }
        }
      }
    }
    const canonical = new Set<string>();
    // Resolve symlinks before loading so relative imports use the source directory.
    for (const path of [...files, ...paths.map(expandPath)]) canonical.add(await realpath(path));
    return [...canonical];
  }

  async skills(cwd: string): Promise<{ skills: Skill[]; diagnostics: string[] }> {
    const roots = [join(this.configDir, "skills"), join(this.home, ".agents", "skills"), join(cwd, ".pi-d", "skills"), join(cwd, ".pi", "skills")];
    for (let path = resolve(cwd);; path = dirname(path)) {
      roots.push(join(path, ".agents", "skills"));
      if (await optionalGit(path) || dirname(path) === path) break;
    }
    const skills = new Map<string, Skill>(), seen = new Set<string>(), diagnostics: string[] = [];
    const visit = async (path: string, explicit = false): Promise<void> => {
      let info;
      try { info = await stat(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || explicit) diagnostics.push(`${path}: cannot read skill path.`);
        return;
      }
      const canonical = await realpath(path);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      if (info.isDirectory()) {
        const entries = (await readdir(path)).sort();
        if (entries.includes("SKILL.md")) { await visit(join(path, "SKILL.md")); return; }
        for (const name of entries) if (!name.startsWith(".") && name !== "node_modules") await visit(join(path, name));
        return;
      }
      if (!info.isFile() || !path.endsWith(".md")) return;
      const content = await optionalFile(path);
      const header = content?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      let metadata: unknown;
      try { metadata = header === undefined ? undefined : parse(header, { maxAliasCount: 0, logLevel: "silent" }); } catch { /* Report below without exposing file contents. */ }
      const fields = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
      const name = fields.name ?? basename(dirname(path));
      if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || typeof fields.description !== "string" || !fields.description.trim() || fields.description.length > 1024 || (fields["disable-model-invocation"] !== undefined && typeof fields["disable-model-invocation"] !== "boolean")) {
        if (basename(path) === "SKILL.md" || explicit) diagnostics.push(`${path}: invalid skill name, description or frontmatter.`);
        return;
      }
      if (skills.has(name)) { diagnostics.push(`${path}: duplicate skill ${name}; keeping ${skills.get(name)!.filePath}.`); return; }
      skills.set(name, { name, description: fields.description, filePath: path, disableModelInvocation: fields["disable-model-invocation"] === true });
    };
    for (const root of roots) await visit(root);
    for (const path of this.skillPaths) await visit(path, true);
    return { skills: [...skills.values()], diagnostics };
  }
}

async function optionalGit(path: string): Promise<boolean> {
  try { await stat(join(path, ".git")); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

// Pi/Agent Skills prompt wording; keep full instructions lazy until read or /skill:name.
export function skillPrompt(skills: Skill[]): string | undefined {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (!visible.length) return undefined;
  return `The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
${visible.map((skill) => `  <skill>\n    <name>${xml(skill.name)}</name>\n    <description>${xml(skill.description)}</description>\n    <location>${xml(skill.filePath)}</location>\n  </skill>`).join("\n")}
</available_skills>`;
}
