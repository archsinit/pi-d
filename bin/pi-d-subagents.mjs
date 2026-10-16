#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Explicit experiment launcher, never used by bin/pi-d.mjs. Configuration isolation is not an OS sandbox.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";

const help = `pi-d subagents · isolated workspace for built-in subagents

Usage: node bin/pi-d-subagents.mjs [--experiment path] [--check]

With no path, create a new private temporary experiment. Reopen only a directory
created by this helper. --check prints the launch plan without opening SQLite,
loading extensions, starting a model, or signing in. No arbitrary pi-d flags.

The child gets separate HOME, XDG config/data/cache, a fresh workspace, a fixed
session, built-in subagents without external extensions, and no inherited API keys, OAuth,
proxy, Node-preload or cloud-credential environment. The normal launcher and
configuration are not changed. Sign in explicitly inside the experiment if wanted.
Workers and the coordinator have normal coding tools and account permissions.
There are no worker-count, concurrency, time or tool-call budgets; only the
coordinator may delegate or manage workers. This is NOT an OS sandbox. Data is retained.
`;
const marker = ".pi-d-subagents-experiment", signature = "pi-d-subagents experiment v1\n";
function privateDirectory(path, create = false) {
  if (create) mkdirSync(path, { recursive: false, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Experiment directories must be private, owned directories, not symlinks.");
  }
}
function plain(path, directory = false) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))) throw new Error("Experiment state paths must not be symlinks or special files.");
}
async function main() {
  const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" }, check: { type: "boolean" }, experiment: { type: "string" } } });
  if (values.help) { console.log(help); return; }
  if (process.platform === "win32") throw new Error("This experiment helper requires POSIX directory permissions.");
  const fresh = values.experiment === undefined;
  const experiment = fresh ? realpathSync(mkdtempSync(join(tmpdir(), "pi-d-subagents-"))) : resolve(values.experiment);
  privateDirectory(experiment);
  if (!fresh) {
    const stamp = join(experiment, marker); plain(stamp);
    const stat = lstatSync(stamp, { throwIfNoEntry: false });
    if (!stat || stat.size !== Buffer.byteLength(signature) || readFileSync(stamp, "utf8") !== signature) throw new Error("Not a helper-created pi-d subagent experiment.");
  }
  const home = join(experiment, "home"), config = join(experiment, "config"), data = join(experiment, "data"), cache = join(experiment, "cache"), workspace = join(experiment, "workspace");
  for (const path of [home, config, data, cache, workspace, join(config, "pi-d"), join(data, "pi-d")]) {
    privateDirectory(path, fresh);
  }
  const session = join(data, "pi-d", "experiment.sqlite"), auth = join(config, "pi-d", "auth.json");
  for (const path of [session, `${session}-wal`, `${session}-shm`, auth]) plain(path);
  for (const path of [`${session}.lock`, `${auth}.lock`]) plain(path, true);
  if (fresh) {
    writeFileSync(join(workspace, "README.md"), "# Isolated subagent experiment\n\nA disposable workspace, not a sandbox. Workers have normal coding tools and no execution budgets. Only the coordinator may delegate; ask it to stop individual workers or whole jobs when needed.\n", { mode: 0o600, flag: "wx" });
    writeFileSync(join(experiment, marker), signature, { mode: 0o600, flag: "wx" });
  }
  const launcher = fileURLToPath(new URL("./pi-d.mjs", import.meta.url));
  const args = ["--disable-warning=ExperimentalWarning", launcher, "--no-extensions", "--session", session, "--cwd", workspace, "--no-animation"];
  const env = { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, PWD: workspace,
    PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") };
  for (const key of ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const plan = { experiment, workspace, session, executable: process.execPath, args, environment: env };
  if (values.check) { console.log(JSON.stringify(plan, null, 2)); return; }
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const reopen = [process.execPath, fileURLToPath(import.meta.url), "--experiment", experiment].map(quote).join(" ");
  console.error(`Subagent experiment: ${experiment}\nNormal pi-d configuration/session are not selected. This is not an OS sandbox.\nReopen: ${reopen}`);
  const child = spawn(process.execPath, args, { env, cwd: workspace, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"], forwards = signals.map((signal) => () => { child.kill(signal); });
  for (const [index, signal] of signals.entries()) process.on(signal, forwards[index]);
  try {
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject); child.once("exit", (code) => resolveExit(code ?? 1));
    });
  } finally { for (const [index, signal] of signals.entries()) process.off(signal, forwards[index]); }
}
await main().catch((error) => { console.error(`pi-d subagents: ${error instanceof Error ? error.message : "Launch failed."}`); process.exitCode = 1; });
