import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Verify the distributable, not a symlink back into the checkout. No live auth/model calls.
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pi-d package-")));
const workspace = join(temporary, "workspace with spaces");
mkdirSync(workspace);
const env = {
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  HOME: join(temporary, "home"), XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"),
  TERM: "xterm-256color", COLORTERM: "truecolor",
  // Reuse only the hydration cache; do not read the user's npm credentials/configuration.
  NPM_CONFIG_CACHE: process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? join(homedir(), ".npm"),
  NPM_CONFIG_USERCONFIG: join(temporary, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(temporary, "global-npmrc"),
};
function run(command, args, cwd = workspace) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const extension = join(workspace, "trusted extension.ts");
const verification = `import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { codingEnv, codingRegistry } from "./dist/coding.js";
import { Resources } from "./dist/resources.js";
import { openPersistentChat } from "./dist/session.js";
const [extension, workspace, session, config] = process.argv.slice(2);
const resources = new Resources(config, [], workspace);
const registry = await codingRegistry(resources, [extension]);
const faux = fauxProvider({ tokensPerSecond: 100000 });
faux.appendResponses([fauxAssistantMessage(fauxToolCall("install_probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Verified offline.")]);
const models = createModels(); models.setProvider(faux.provider);
const chat = await openPersistentChat(session, models, { defaults: { model: { provider: "faux", modelId: "faux-1" } }, registry, env: codingEnv, defaultCwd: workspace, onLockLost: (error) => { throw error; } });
try {
  const input = await chat.conversation.submit({ type: "input", content: "Test the installed extension." }, context);
  const receipt = await input.wait(context);
  const messages = (await chat.conversation.context(context)).messages;
  assert.equal(receipt.status, "done", JSON.stringify({ receipt, messages }));
  assert.match(JSON.stringify(messages.filter((message) => message.role === "toolResult")), /INSTALLED-EXTENSION-OK/);
  assert.match(JSON.stringify(messages), /INSTALLED-SECTION-OK/);
  assert.equal((await chat.conversation.agent(context)).cwd, workspace);
  await access(new URL("./docs/extensions.md", import.meta.url));
} finally { await chat.close(); }
`;
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root))[0];
  const files = packed.files.map((file) => file.path).sort();
  const expected = ["README.md", "LICENSE", "NOTICE", "package.json", "npm-shrinkwrap.json", "bin/pi-d.mjs", "docs/comparison.md", "docs/extensions.md", "docs/usage.md", "docs/preview.svg",
    ...readdirSync(join(root, "src")).filter((file) => file.endsWith(".ts")).map((file) => `dist/${file.replace(/\.ts$/, ".js")}`),
    ...readdirSync(join(root, "licenses")).map((file) => `licenses/${file}`)].sort();
  assert.deepEqual(files, expected, "Package only runtime JavaScript, documentation, notices and the pinned dependency closure.");
  const archive = join(temporary, packed.filename);
  const lock = JSON.parse(readFileSync(join(root, "npm-shrinkwrap.json"), "utf8"));
  const pinned = new Set(Object.entries(lock.packages).map(([path, pkg]) => `${path.split("node_modules/").at(-1)}@${pkg.version}`));
  const checkVersions = (tree) => {
    for (const [name, pkg] of Object.entries(tree.dependencies ?? {})) {
      if (name !== packed.name && pkg.version) assert(pinned.has(`${name}@${pkg.version}`), `Unreviewed installed dependency: ${name}@${pkg.version}`);
      checkVersions(pkg);
    }
  };
  writeFileSync(extension, `import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type as AIType } from "@earendil-works/pi-ai";
import { fauxText } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
export default defineExtension({ name: "install-probe", sections: [section("install_probe", () => "INSTALLED-SECTION-OK")], tools: [defineTool({ name: "install_probe", description: "Offline installation probe", parameters: Type.Object({}), execute: async (_args, api) => {
  if (AIType.String !== Type.String || !Value.Check(Type.String(), "ok") || visibleWidth("ok") !== 2) throw new Error("Host SDK resolution failed.");
  return { output: [fauxText("INSTALLED-EXTENSION-OK " + (await api.agent(BACKGROUND_CONTEXT)).cwd)] };
} })] });`);
  for (const global of [false, true]) {
    const prefix = join(temporary, global ? "global" : "consumer");
    mkdirSync(prefix);
    if (!global) writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "isolated-consumer", private: true }));
    run("npm", ["install", ...(global ? ["--global"] : []), "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", archive], prefix);
    checkVersions(JSON.parse(run("npm", ["ls", "--all", "--json", ...(global ? ["--global"] : []), "--prefix", prefix])));
    const installed = join(prefix, global ? "lib/node_modules" : "node_modules", packed.name);
    const launcher = join(prefix, global ? "bin" : "node_modules/.bin", "pi-d");
    assert.match(run(launcher, ["--help"]), /\/new/);
    assert.match(run(launcher, ["--list-models"]), /openai-codex\/gpt-6\.1-sol/);
    assert(!existsSync(env.XDG_CONFIG_HOME)); assert(!existsSync(env.XDG_DATA_HOME));
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.private, true, "GitHub publication must not enable npm registry publishing.");
    assert.equal(manifest.license, "MIT");
    assert.equal(readFileSync(join(installed, "LICENSE"), "utf8"), readFileSync(join(root, "LICENSE"), "utf8"));
    const requireEntry = join(installed, "package-verification.mjs");
    writeFileSync(requireEntry, verification);
    run(process.execPath, ["--disable-warning=ExperimentalWarning", requireEntry, extension, workspace, join(workspace, global ? "global.sqlite" : "local.sqlite"), join(workspace, "config")]);
    assert(!existsSync(join(workspace, global ? "global.sqlite.lock" : "local.sqlite.lock")));
    // Includes real fullscreen demo, local commands, saved-session/auth gate and terminal restoration.
    run("python3", [join(root, "scripts/terminal-smoke.py"), launcher]);
    console.log(`Package passed: ${global ? "global-prefix" : "local dependency"} install, launcher, SQLite, external TypeScript extension and offline PTY.`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
