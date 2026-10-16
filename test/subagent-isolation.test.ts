import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../bin/pi-d-subagents.mjs", import.meta.url));
type Plan = { experiment: string; session: string; workspace: string; executable: string; args: string[]; environment: Record<string, string> };

test("isolated helper uses only private experiment paths and an explicit credential-free child environment", { skip: process.platform === "win32" }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-d isolation 你好-")));
  const home = join(directory, "normal-home"), config = join(directory, "normal-config"), data = join(directory, "normal-data");
  for (const path of [home, join(config, "pi-d"), join(data, "pi-d")]) await mkdir(path, { recursive: true, mode: 0o700 });
  const credential = join(config, "pi-d", "auth.json"), database = join(data, "pi-d", "default.sqlite");
  await writeFile(credential, "FAKE-CREDENTIAL-MUST-NOT-BE-READ", { mode: 0o600 }); await writeFile(database, "DO-NOT-OPEN-THIS-TEST-SENTINEL", { mode: 0o600 });
  const env = { PATH: "/not-the-child-path", HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, TMPDIR: directory, LANG: "en_US.UTF-8",
    OPENAI_API_KEY: "DUMMY-OPENAI", ANTHROPIC_API_KEY: "DUMMY-ANTHROPIC", AWS_PROFILE: "DUMMY-AWS", AWS_SHARED_CREDENTIALS_FILE: credential,
    GOOGLE_APPLICATION_CREDENTIALS: credential, HTTP_PROXY: "DUMMY-PROXY", SSH_AUTH_SOCK: "DUMMY-SSH", NODE_OPTIONS: "--no-warnings",
    NPM_CONFIG_USERCONFIG: credential, GIT_CONFIG_GLOBAL: credential };
  const run = (...args: string[]) => spawnSync(process.execPath, [helper, ...args], { env, cwd: directory, encoding: "utf8", timeout: 10000 });
  let plan: Plan | undefined;
  try {
    const result = run("--check"); assert.equal(result.status, 0, result.stderr); plan = JSON.parse(result.stdout);
    assert(plan); assert(plan.experiment.startsWith(directory + "/pi-d-subagents-"));
    assert.equal(plan.executable, process.execPath); assert.equal(plan.session, join(plan.environment.XDG_DATA_HOME, "pi-d", "experiment.sqlite"));
    assert.equal(plan.environment.HOME, join(plan.experiment, "home")); assert.equal(plan.workspace, join(plan.experiment, "workspace"));
    assert(!("extension" in plan));
    assert.deepEqual(plan.args, ["--disable-warning=ExperimentalWarning", join(dirname(helper), "pi-d.mjs"), "--no-extensions",
      "--session", plan.session, "--cwd", plan.workspace, "--no-animation"]);
    assert(!result.stdout.includes("DUMMY-")); assert(!plan.environment.PATH.includes("/not-the-child-path"));
    assert.equal(plan.environment.NODE_OPTIONS, undefined); assert.equal(plan.environment.AWS_SHARED_CREDENTIALS_FILE, undefined);
    assert.equal(plan.environment.NPM_CONFIG_USERCONFIG, undefined); assert.equal(plan.environment.TMPDIR, undefined);
    assert.equal(plan.environment.GIT_CONFIG_NOSYSTEM, "1"); assert.notEqual(plan.environment.GIT_CONFIG_GLOBAL, credential);
    const repeat = run("--experiment", plan.experiment, "--check"); assert.equal(repeat.status, 0, repeat.stderr); assert.deepEqual(JSON.parse(repeat.stdout), plan);
    const arbitrary = run("--experiment", directory, "--check"); assert.equal(arbitrary.status, 1); assert.match(arbitrary.stderr, /Not a helper-created/);
    for (const option of ["--session", "--cwd", "--extension"]) assert.equal(run(option, database, "--check").status, 1);
    await symlink(database, plan.session); const linked = run("--experiment", plan.experiment, "--check"); assert.equal(linked.status, 1); assert.match(linked.stderr, /symlinks/); await rm(plan.session);
    await chmod(plan.experiment, 0o755); const publicDirectory = run("--experiment", plan.experiment, "--check"); assert.equal(publicDirectory.status, 1); assert.match(publicDirectory.stderr, /private/); await chmod(plan.experiment, 0o700);
    assert.equal(await readFile(credential, "utf8"), "FAKE-CREDENTIAL-MUST-NOT-BE-READ"); assert.equal(await readFile(database, "utf8"), "DO-NOT-OPEN-THIS-TEST-SENTINEL");
    assert.equal(await readFile(join(plan.workspace, "README.md"), "utf8"), "# Isolated subagent experiment\n\nA disposable workspace, not a sandbox. Workers have normal coding tools and no execution budgets. Only the coordinator may delegate; ask it to stop individual workers or whole jobs when needed.\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
