import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgents, Resources, skillPrompt } from "../src/resources.ts";

test("AGENTS inherit in order, prefer overrides, deduplicate symlinks and refresh changed/deleted files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-resources-"));
  const config = join(directory, "config"), cwd = join(directory, "repo", "src");
  await mkdir(config); await mkdir(cwd, { recursive: true });
  try {
    await writeFile(join(config, "AGENTS.md"), "global");
    await writeFile(join(directory, "AGENTS.md"), "ancestor");
    await writeFile(join(directory, "repo", "AGENTS.md"), "shadowed");
    await writeFile(join(directory, "repo", "AGENTS.override.md"), "override");
    await writeFile(join(cwd, "AGENTS.md"), "cwd");
    assert.deepEqual((await loadAgents(cwd, config)).map((file) => file.content), ["global", "ancestor", "override", "cwd"]);
    await writeFile(join(cwd, "AGENTS.md"), "updated");
    assert.equal((await loadAgents(cwd, config)).at(-1)?.content, "updated");
    await rm(join(cwd, "AGENTS.md")); await symlink(join(config, "AGENTS.md"), join(cwd, "AGENTS.md"));
    assert.deepEqual((await loadAgents(cwd, config)).map((file) => file.content), ["global", "ancestor", "override"]);
    await rm(join(directory, "repo", "AGENTS.override.md"));
    assert.equal((await loadAgents(cwd, config)).at(-1)?.content, "shadowed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("skills use real YAML, deterministic collision handling, explicit-only metadata, lazy bodies and cycle-safe discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-skills-"));
  const config = join(directory, "config"), cwd = join(directory, "repo");
  const skillsRoot = join(config, "skills");
  await mkdir(join(skillsRoot, "nested", "sample"), { recursive: true });
  await mkdir(join(cwd, ".pi-d", "skills", "sample"), { recursive: true });
  await mkdir(join(cwd, ".pi", "skills", "manual"), { recursive: true });
  await mkdir(join(cwd, ".agents", "skills", "bad"), { recursive: true });
  await writeFile(join(cwd, ".git"), "fixture");
  const sample = join(skillsRoot, "nested", "sample", "SKILL.md");
  await writeFile(sample, '---\nname: sample\ndescription: >\n  Read <files>\n  and report.\n---\nFULL BODY MUST STAY LAZY');
  await writeFile(join(cwd, ".pi-d", "skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: Loser\n---\n");
  await writeFile(join(cwd, ".pi", "skills", "manual", "SKILL.md"), "---\nname: manual\ndescription: Only explicit\ndisable-model-invocation: true\n---\nPRIVATE MANUAL BODY");
  await writeFile(join(cwd, ".agents", "skills", "bad", "SKILL.md"), "---\nname: [invalid\ndescription: SECRET MALFORMED CONTENT\n---\n");
  await symlink(skillsRoot, join(skillsRoot, "cycle"));
  const resources = new Resources(config, [sample, join(directory, "missing.md")], directory);
  try {
    const result = await resources.skills(cwd);
    assert.deepEqual(result.skills.map((skill) => skill.name), ["sample", "manual"]);
    assert.equal(result.skills[0]?.description, "Read <files> and report.\n");
    assert(result.diagnostics.some((message) => message.includes("duplicate skill sample")));
    assert(result.diagnostics.some((message) => message.includes("invalid skill")));
    assert(result.diagnostics.some((message) => message.includes("cannot read skill path")));
    assert(!result.diagnostics.join(" ").includes("SECRET"));
    const prompt = skillPrompt(result.skills); assert(prompt);
    assert.match(prompt, /Read &lt;files&gt;/); assert(prompt.includes(sample));
    assert(!prompt.includes("FULL BODY")); assert(!prompt.includes("PRIVATE MANUAL BODY")); assert(!prompt.includes("<name>manual"));
    await writeFile(sample, "---\nname: sample\ndescription: Updated\n---\nNEW BODY");
    assert.equal((await resources.skills(cwd)).skills[0]?.description, "Updated");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
