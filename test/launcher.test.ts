import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("user-bin launcher resolves its checkout, forwards arguments and exit status, and leaves user data alone", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-d bin-"));
  const command = join(directory, "pi-d");
  try {
    symlinkSync(fileURLToPath(new URL("../bin/pi-d.mjs", import.meta.url)), command);
    const run = (...args: string[]) => spawnSync(command, args, {
      cwd: directory, encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data") },
    });
    const help = run("--help", "--extension", "must-not-be-loaded.ts");
    assert.equal(help.status, 0, help.stderr || String(help.error));
    assert.match(help.stdout, /pi-d · a coding terminal for stock Durable/);
    assert.equal(help.stderr, "");
    const models = run("--list-models", "--extension", "must-not-be-loaded.ts");
    assert.equal(models.status, 0, models.stderr || String(models.error));
    assert.match(models.stdout, /openai-codex\/gpt-6\.1-sol/);
    const invalid = run("--demo", "--session", "never-created.sqlite");
    assert.equal(invalid.status, 1, invalid.stderr || String(invalid.error));
    assert.match(invalid.stderr, /cannot be combined/);
    assert.deepEqual(readdirSync(directory), ["pi-d"]);
    const extensions = join(directory, "config", "pi-d", "extensions");
    mkdirSync(extensions, { recursive: true });
    writeFileSync(join(extensions, "must-not-run.mjs"), 'throw new Error("GLOBAL_EXTENSION_EXECUTED");');
    for (const args of [["--help"], ["--list-models"], ["--no-extensions", "--help"]]) {
      const result = run(...args);
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.equal(result.stderr, "");
    }
    const login = run("--login");
    assert.equal(login.status, 1); assert.match(login.stderr, /interactive terminal/);
    const disabled = run("--no-extensions");
    assert.equal(disabled.status, 1); assert.match(disabled.stderr, /interactive terminal/);
    assert(!login.stderr.includes("GLOBAL_EXTENSION_EXECUTED"));
    assert(!disabled.stderr.includes("GLOBAL_EXTENSION_EXECUTED"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
