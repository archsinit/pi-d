import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const failure of [false, true]) {
  test(`CLI releases provider session resources after ${failure ? "failure" : "success"}`, { timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-d-cli-shutdown-"));
    try {
      const preload = join(directory, "provider-resource.mjs");
      // Model the SDK's cached transport: a referenced timer survives a completed request
      // until the process owner invokes its registered cleanup. No network or credentials.
      await writeFile(preload, `
import { registerSessionResourceCleanup } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const timer = setTimeout(() => {}, 300000);
registerSessionResourceCleanup(() => {
  clearTimeout(timer);
  process.stdout.write("PROVIDER_RESOURCE_CLEANED\\n");
});
`);
      const result = await new Promise<{ code: string | number; killed: boolean; stdout: string; stderr: string }>((resolve) => {
        execFile(process.execPath, ["--import", preload, fileURLToPath(new URL("../src/cli.ts", import.meta.url)), failure ? "--invalid-option" : "--help"], {
          cwd: directory, timeout: 5000,
          env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data") },
        }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, killed: error?.killed ?? false, stdout, stderr }));
      });
      assert.equal(result.killed, false, "Provider resource kept Node alive after CLI completion");
      assert.equal(result.code, failure ? 1 : 0, result.stderr);
      assert.equal(result.stdout.split("PROVIDER_RESOURCE_CLEANED").length - 1, 1);
      if (failure) assert.match(result.stderr, /invalid-option/);
      else assert(result.stdout.indexOf("Usage:") < result.stdout.indexOf("PROVIDER_RESOURCE_CLEANED"), "Cleanup must follow CLI work");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
