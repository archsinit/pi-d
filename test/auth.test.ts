import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, ModelsError } from "@earendil-works/pi-ai/models";
import { chatModels, SubscriptionCredentials } from "../src/auth.ts";
import { loginSubscription } from "../src/login.ts";
import { DEFAULT_CHAT_AGENT } from "../src/session.ts";

import { subscriptionCredential as credential } from "./models.ts";
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-auth-"));
  return { directory, credentials: new SubscriptionCredentials(join(directory, "private", "auth.json")) };
}
async function eventually(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for offline operation.");
}

test("Codex credentials reopen privately without relabelling old OpenAI tokens or discarding metadata", async () => {
  const { directory, credentials } = await temporary();
  try {
    const old = { ...credential, access: "test-modern-access", refresh: "test-modern-refresh", clientId: "test-issued-client-id", scopes: ["chatgpt.tokens.use.direct"] };
    const deviceId = "e05c9a64-46be-421e-a37d-1bc7dfb7abe2";
    await credentials.modify("openai", async () => old);
    await writeFile(credentials.file, JSON.stringify({ deviceId, openai: old }));
    const models = chatModels(credentials);
    assert.equal(await models.getAuth("openai-codex"), undefined);
    await credentials.modify("openai-codex", async () => credential);
    const reopened = new SubscriptionCredentials(credentials.file);
    assert.deepEqual(await reopened.read("openai"), old);
    assert.deepEqual(await reopened.read("openai-codex"), credential);
    assert.deepEqual(await reopened.list(), ["openai", "openai-codex"].map((providerId) => ({ providerId, type: "oauth" })));
    assert.equal(await reopened.read("anthropic"), undefined);
    assert.equal((await stat(credentials.file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);
    await models.logout("openai-codex");
    assert.equal(await reopened.read("openai-codex"), undefined);
    assert.deepEqual(await reopened.read("openai"), old);
    await models.logout("openai");
    assert.deepEqual(await reopened.list(), []);
    assert.deepEqual(JSON.parse(await readFile(credentials.file, "utf8")), { deviceId });
    assert.deepEqual(await readdir(join(directory, "private")), ["auth.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("OpenAI is OAuth-only even with ambient or explicit API keys, and failed refresh never falls back", async () => {
  const { directory, credentials } = await temporary();
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-key-that-must-never-be-used";
  try {
    const models = chatModels(credentials);
    for (const id of ["openai", "openai-codex"]) {
      assert.equal(models.getProvider(id)!.auth.apiKey, undefined);
      assert.equal(await models.checkAuth(id), undefined);
      assert.equal(await models.getAuth(id, { apiKey: "sk-test-override" }), undefined);
      await credentials.modify(id, async () => credential);
      assert.equal((await models.checkAuth(id))?.type, "oauth");
      assert.deepEqual(await models.getAuth(id), { source: "OAuth", auth: { apiKey: credential.access } });
      await credentials.modify(id, async () => ({ ...credential, expires: 0 }));
      const provider = models.getProvider(id)!;
      let refreshes = 0;
      models.setProvider({ ...provider, auth: { oauth: { ...provider.auth.oauth!, refresh: async () => { refreshes++; throw new Error("simulated revoked grant"); } } } });
      await assert.rejects(models.getAuth(id), (error) => error instanceof ModelsError && error.code === "oauth");
      assert.equal(refreshes, 1);
      assert.equal((await credentials.read(id) as OAuthCredential).refresh, credential.refresh);
      await models.logout(id);
      assert.equal(await models.getAuth(id), undefined);
      assert.equal(await models.checkAuth(id), undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const reasoning of ["medium", "max"] as const) test(`native Codex builds gpt-6.1-sol/${reasoning} with subscription fields, stopped before any network request`, async () => {
  const { directory, credentials } = await temporary();
  try {
    await credentials.modify("openai-codex", async () => credential);
    const models = chatModels(credentials);
    const model = models.getModel(DEFAULT_CHAT_AGENT.model.provider, DEFAULT_CHAT_AGENT.model.modelId)!;
    assert.equal(model.provider, "openai-codex"); assert.equal(model.api, "openai-codex-responses");
    assert(getSupportedThinkingLevels(model).includes("max"));
    assert.equal(model.thinkingLevelMap?.max, "max");
    let payload: unknown, fetches = 0;
    const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Offline payload test.", timestamp: Date.now() }] }, {
      reasoning: reasoning === "medium" ? DEFAULT_CHAT_AGENT.thinkingLevel : reasoning, transport: "sse",
      fetch: async () => { fetches++; throw new Error("Network forbidden."); },
      onPayload: (value) => { payload = value; throw new Error("Stopped before network."); },
    });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /Stopped before network/);
    const body = payload as { model: string; reasoning: { effort: string }; max_output_tokens?: number; temperature?: number };
    assert.equal(body.model, "gpt-6.1-sol"); assert.equal(body.reasoning.effort, reasoning);
    assert.equal(body.max_output_tokens, undefined); assert.equal(body.temperature, undefined);
    assert.equal(fetches, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native OAuth refresh persists its rotated token even when the requesting caller cancels", async () => {
  const { directory, credentials } = await temporary();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  try {
    await credentials.modify("openai-codex", async () => ({ ...credential, expires: 0 }));
    const models = chatModels(credentials);
    const provider = models.getProvider("openai-codex")!;
    let refreshes = 0;
    models.setProvider({ ...provider, auth: { oauth: { ...provider.auth.oauth!, refresh: async (current) => {
      refreshes++; started.resolve(); await finish.promise;
      return { ...current, refresh: "test-rotated-refresh", expires: Date.now() + 3600000 };
    } } } });
    const controller = new AbortController();
    const request = models.getAuth("openai-codex", { signal: controller.signal });
    const cancelled = assert.rejects(request);
    await started.promise; controller.abort(); await cancelled;
    finish.resolve();
    await eventually(async () => (await credentials.read("openai-codex") as OAuthCredential)?.refresh === "test-rotated-refresh");
    assert.equal((await models.getAuth("openai-codex"))?.source, "OAuth");
    await credentials.modify("openai-codex", async () => undefined); // Join the detached native refresh before cleanup.
    assert.equal(refreshes, 1);
  } finally { finish.resolve(); await rm(directory, { recursive: true, force: true }); }
});

test("two processes refresh one expired OAuth credential only once under the shared store lock", { timeout: 15000 }, async () => {
  const { directory, credentials } = await temporary();
  const children: ReturnType<typeof spawn>[] = [];
  try {
    await credentials.modify("openai-codex", async () => ({ ...credential, expires: 0 }));
    const results = [0, 1].map(() => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "test/auth-refresh-child.ts", credentials.file], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let output = "", errors = "";
      child.stdout!.on("data", (chunk) => { output += chunk; });
      child.stderr!.on("data", (chunk) => { errors += chunk; });
      return new Promise<string>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (status) => status === 0 ? resolve(output) : reject(new Error(`Offline refresh helper exited ${status}: ${errors}`)));
      });
    });
    const outputs = await Promise.all(results);
    assert.equal(outputs.join("").split("REFRESH").length - 1, 1);
    assert(outputs.every((output) => output.includes("AUTH")));
    assert.equal((await credentials.read("openai-codex") as OAuthCredential).refresh, "test-rotated-refresh");
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL"); await exited;
      }
    }));
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential mutation failures roll back; cancellation while waiting never invokes the mutation", async () => {
  const { directory, credentials } = await temporary();
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  try {
    await credentials.modify("openai", async () => credential);
    await assert.rejects(credentials.modify("openai", async () => { throw new Error("mutation failed"); }), /mutation failed/);
    assert.deepEqual(await credentials.modify("openai", async (current) => { (current as OAuthCredential).access = "not-committed"; return undefined; }), credential);
    const owner = credentials.modify("openai", async () => { entered.resolve(); await finish.promise; return credential; });
    await entered.promise;
    const controller = new AbortController();
    let invoked = false;
    const waiter = new SubscriptionCredentials(credentials.file).modify("openai", async () => { invoked = true; return credential; }, { signal: controller.signal });
    const cancelled = assert.rejects(waiter);
    await delay(30); controller.abort(); await cancelled;
    finish.resolve(); await owner;
    assert.equal(invoked, false);
    assert.deepEqual(await credentials.read("openai"), credential);
  } finally { finish.resolve(); await rm(directory, { recursive: true, force: true }); }
});

test("invalid, exposed, linked or API-key credentials fail closed without leaking their content", async () => {
  const { directory, credentials } = await temporary();
  try {
    await credentials.modify("openai-codex", async () => undefined);
    for (const value of [{ type: "api_key", key: "sk-test-secret" }, { ...credential, access: "sk-test-secret" }, { ...credential, access: " sk-test-secret " }, { ...credential, expires: NaN }]) {
      await assert.rejects(credentials.modify("openai", async () => value as OAuthCredential), /API keys are not accepted/);
      assert.equal(await credentials.read("openai"), undefined);
    }
    const marker = "test-secret-that-must-not-appear-in-errors";
    await writeFile(credentials.file, `{broken-json:${marker}`);
    await assert.rejects(credentials.read("openai"), (error) => error instanceof Error && !error.message.includes(marker));
    await writeFile(credentials.file, "{}");
    await chmod(credentials.file, 0o644);
    await assert.rejects(credentials.read("openai"), /private/);
    await chmod(credentials.file, 0o600);
    const alias = join(directory, "private", "alias.json");
    await symlink(credentials.file, alias);
    await assert.rejects(new SubscriptionCredentials(alias).read("openai"), /not a symlink/);
    await rm(alias); await link(credentials.file, alias);
    await assert.rejects(credentials.read("openai"), /single-link/);
    await rm(alias);
    await chmod(join(directory, "private"), 0o755);
    await assert.rejects(credentials.read("openai"), /directory must be private/);
    await assert.rejects(credentials.modify("openai-codex", async () => credential), /directory must be private/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("login delegates to Codex with native defaults, method selection and no printed tokens", async () => {
  const { directory, credentials } = await temporary();
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", (chunk) => { text += chunk; });
  const before = process.listenerCount("SIGTERM");
  try {
    const models = chatModels(credentials);
    const provider = models.getProvider("openai-codex")!;
    models.setProvider({ ...provider, auth: { oauth: { ...provider.auth.oauth!, login: async (interaction, options) => {
      assert.equal(options, undefined);
      assert.equal(await interaction.prompt({ type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }, { id: "device_code", label: "Device code" }] }), "browser");
      interaction.notify({ type: "auth_url", url: "https://auth.example.invalid/offline" });
      const callback = await interaction.prompt({ type: "manual_code", message: "Browser callback", signal: interaction.signal });
      assert.equal(callback, "http://127.0.0.1:1455/auth/callback?code=test-private-code");
      return credential;
    } } } });
    const login = loginSubscription(models, input, output);
    await eventually(() => text.includes("Method [1]:")); input.write("99\n");
    await eventually(() => text.includes("Choose a number")); input.write("\n");
    await eventually(() => text.includes("> "));
    input.write("http://127.0.0.1:1455/auth/callback?code=test-private-code\n");
    await login;
    assert.deepEqual(await credentials.read("openai-codex"), credential);
    assert.equal(await credentials.read("openai"), undefined);
    assert.equal(JSON.parse(await readFile(credentials.file, "utf8")).deviceId, undefined);
    assert.match(text, /ChatGPT connected/);
    for (const secret of [credential.access, credential.refresh, "test-private-code"]) assert(!text.includes(secret));
    assert.equal(process.listenerCount("SIGTERM"), before);
  } finally { input.destroy(); output.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test("provider login errors do not print response bodies or callback secrets", async () => {
  const { directory, credentials } = await temporary();
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", (chunk) => { text += chunk; });
  try {
    const models = chatModels(credentials), provider = models.getProvider("openai-codex")!;
    models.setProvider({ ...provider, auth: { oauth: { ...provider.auth.oauth!, login: async () => { throw new Error(`provider response: ${credential.refresh}`); } } } });
    await assert.rejects(loginSubscription(models, input, output), (error) => error instanceof Error &&
      error.message.includes("ChatGPT sign-in failed") && !error.message.includes(credential.refresh));
    assert(!text.includes(credential.refresh)); assert.equal(await credentials.read("openai"), undefined);
  } finally { input.destroy(); output.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test("closing the login input cancels provider work, cleans signal handlers and stores no credential", async () => {
  const { directory, credentials } = await temporary();
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", (chunk) => { text += chunk; });
  const before = process.listenerCount("SIGINT");
  try {
    const models = chatModels(credentials), provider = models.getProvider("openai-codex")!;
    models.setProvider({ ...provider, auth: { oauth: { ...provider.auth.oauth!, login: async (interaction) => {
      await interaction.prompt({ type: "manual_code", message: "Browser callback", signal: interaction.signal });
      return credential;
    } } } });
    const cancelled = assert.rejects(loginSubscription(models, input, output), /Login cancelled/);
    await eventually(() => text.includes("> ")); input.end(); await cancelled;
    assert.equal(await credentials.read("openai"), undefined);
    assert.equal(process.listenerCount("SIGINT"), before);
  } finally { input.destroy(); output.destroy(); await rm(directory, { recursive: true, force: true }); }
});
