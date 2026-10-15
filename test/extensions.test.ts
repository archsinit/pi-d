import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codingRegistry } from "../src/coding.ts";
import { Resources } from "../src/resources.ts";

test("missing global extension directories are optional and discovery creates no files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-extensions-empty-"));
  try {
    assert.deepEqual(await new Resources(join(directory, "config")).extensionPaths(), []);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("global discovery is sorted, shallow, supports TS/JS entry points, and never executes code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-extensions-discovery-"));
  const config = join(directory, "config"), root = join(config, "extensions");
  const names = ["z.cjs", "d.mjs", "b.js", "a.ts", ".hidden.ts", "types.d.ts", "readme.md", "a.js.map"];
  const folders = ["c-folder", "e-module", "f-commonjs", "nested/deeper", ".hidden", "node_modules"];
  try {
    for (const folder of folders) await mkdir(join(root, folder), { recursive: true });
    for (const name of names) await writeFile(join(root, name), 'throw new Error("Discovery must not execute files");');
    for (const name of ["c-folder/index.ts", "c-folder/index.js", "c-folder/helper.ts", "e-module/index.mjs", "f-commonjs/index.cjs", "nested/deeper/index.ts", ".hidden/index.ts", "node_modules/index.js"]) {
      await writeFile(join(root, name), 'throw new Error("Discovery must not execute files");');
    }
    const expected = ["a.ts", "b.js", "c-folder/index.ts", "d.mjs", "e-module/index.mjs", "f-commonjs/index.cjs", "z.cjs"];
    assert.deepEqual(await new Resources(config).extensionPaths(), await Promise.all(expected.map((name) => realpath(join(root, name)))));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("global and explicit paths preserve order and deduplicate file/directory symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-extensions-alias-"));
  const config = join(directory, "config"), root = join(config, "extensions");
  const source = join(directory, "source"), entry = join(source, "index.mjs"), explicit = join(directory, "explicit.ts");
  try {
    await mkdir(root, { recursive: true }); await mkdir(source);
    await writeFile(entry, 'export default { name: "shared" };'); await writeFile(explicit, 'export default { name: "explicit" };');
    await symlink(entry, join(root, "a-alias.mjs")); await symlink(source, join(root, "b-folder"));
    await symlink(join(directory, "missing"), join(root, "broken.js"));
    const resources = new Resources(config);
    assert.deepEqual(await resources.extensionPaths([entry, join(root, "a-alias.mjs"), explicit, explicit]), [await realpath(entry), await realpath(explicit)]);
    assert.deepEqual(await resources.extensionPaths([explicit, entry], false), [await realpath(explicit), await realpath(entry)]);
    await assert.rejects(resources.extensionPaths([join(directory, "missing.ts")]), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("opting out bypasses discovery entirely but preserves explicitly supplied files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-extensions-disabled-"));
  const config = join(directory, "config"), explicit = join(directory, "explicit.js");
  try {
    await mkdir(config); await writeFile(join(config, "extensions"), "not a directory");
    await writeFile(explicit, 'export default { name: "explicit" };');
    const resources = new Resources(config);
    assert.deepEqual(await resources.extensionPaths([], false), []);
    assert.deepEqual(await resources.extensionPaths([explicit], false), [await realpath(explicit)]);
    await assert.rejects(resources.extensionPaths(), { code: "ENOTDIR" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("symlinked extension folders load only their entry point, resolve helpers, and retain duplicate-name errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-extensions-load-"));
  const config = join(directory, "config"), root = join(config, "extensions"), source = join(directory, "source");
  try {
    await mkdir(root, { recursive: true }); await mkdir(source);
    await writeFile(join(source, "helper.mjs"), 'export const name = "global-with-helper";');
    await writeFile(join(source, "index.mjs"), 'import { defineExtension } from "@earendil-works/pi-durable"; import { name } from "./helper.mjs"; export default defineExtension({ name });');
    await symlink(source, join(root, "extension"));
    const resources = new Resources(config), registry = await codingRegistry(resources, await resources.extensionPaths());
    assert(registry.snapshot().extension("global-with-helper"));
    const duplicate = join(directory, "duplicate.ts");
    await writeFile(duplicate, 'export default { name: "global-with-helper" };');
    await assert.rejects(codingRegistry(resources, await resources.extensionPaths([duplicate])), /Duplicate/);
    const reserved = join(root, "reserved.mjs");
    await writeFile(reserved, 'export default { name: "pi-d-prompt" };');
    await assert.rejects(codingRegistry(resources, await resources.extensionPaths()), /reserved/);
    await rm(reserved);
    const invalid = join(root, "invalid.ts");
    await writeFile(invalid, 'export default function () {};');
    await assert.rejects(codingRegistry(resources, await resources.extensionPaths()), /Durable Extension object/);
    await rm(invalid);
    await writeFile(join(root, "throws.ts"), 'throw new Error("Fixture import failed"); export default { name: "throws" };');
    await assert.rejects(codingRegistry(resources, await resources.extensionPaths()), /Fixture import failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
