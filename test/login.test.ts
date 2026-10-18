import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { chatModels, SubscriptionCredentials } from "../src/auth.ts";
import { loginSubscription } from "../src/login.ts";
import { subscriptionCredential } from "./models.ts";

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for the offline login prompt.");
}
const tokenResponse = () => Response.json({
  access_token: subscriptionCredential.access, refresh_token: subscriptionCredential.refresh, expires_in: 3600,
});

test("stock browser login uses Pi's fixed Codex client, not named-agent registration", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-native-login-"));
  const credentials = new SubscriptionCredentials(join(directory, "private", "auth.json"));
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", (chunk) => { text += chunk; });
  // Exercise the native port-busy fallback without opening any socket or touching a live login.
  const listen = t.mock.method(Server.prototype, "listen", function (this: Server) {
    queueMicrotask(() => this.emit("error", Object.assign(new Error("Simulated occupied port"), { code: "EADDRINUSE" })));
    return this;
  });
  let authorization: URL | undefined;
  const fetch = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), "https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(String(options?.body));
    assert.equal(body.get("client_id"), authorization?.searchParams.get("client_id"));
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "test-native-code");
    assert.equal(body.get("redirect_uri"), "http://localhost:1455/auth/callback");
    assert(body.get("code_verifier"));
    return tokenResponse();
  });
  const done = loginSubscription(chatModels(credentials), input, output).then(() => undefined, (error: unknown) => error);
  try {
    await waitFor(() => text.includes("Method [1]:")); input.write("\n");
    await waitFor(() => text.includes("\n> "));
    const match = text.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?\S+/);
    assert(match, "Expected the fixed-client authorization URL.");
    authorization = new URL(match[0]);
    assert.equal(authorization.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(authorization.searchParams.get("originator"), "pi");
    assert.equal(authorization.searchParams.get("codex_cli_simplified_flow"), "true");
    assert(!authorization.searchParams.has("agent_name_hint"));
    assert(!authorization.searchParams.has("ext_agent_host_id"));
    const callback = new URL("http://localhost:1455/auth/callback");
    callback.searchParams.set("code", "test-native-code");
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    input.write(callback.toString() + "\n");
    assert.equal(await done, undefined);
    assert.equal(listen.mock.callCount(), 1); assert.equal(fetch.mock.callCount(), 1);
    const saved = await credentials.read("openai-codex") as OAuthCredential;
    assert.equal(saved.access, subscriptionCredential.access); assert.equal(saved.accountId, "test-account");
    assert.equal(await credentials.read("openai"), undefined);
    assert(text.includes("openai-codex/gpt-6.1-sol --thinking medium"));
    assert(!text.includes(subscriptionCredential.access)); assert(!text.includes(subscriptionCredential.refresh));
    assert(!text.includes("test-native-code"));
  } finally {
    input.end(); await done; output.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stock device-code login shows the URL/code and persists only Codex credentials", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-native-device-"));
  const credentials = new SubscriptionCredentials(join(directory, "private", "auth.json"));
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", (chunk) => { text += chunk; });
  const listen = t.mock.method(Server.prototype, "listen", () => { throw new Error("Device login must not bind a callback port."); });
  const fetch = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    switch (String(url)) {
      case "https://auth.openai.com/api/accounts/deviceauth/usercode": {
        assert.equal(JSON.parse(String(options?.body)).client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
        return Response.json({ device_auth_id: "test-device-id", user_code: "TEST-1234", interval: 0 });
      }
      case "https://auth.openai.com/api/accounts/deviceauth/token":
        assert.deepEqual(JSON.parse(String(options?.body)), { device_auth_id: "test-device-id", user_code: "TEST-1234" });
        return Response.json({ authorization_code: "test-device-code", code_verifier: "test-device-verifier" });
      case "https://auth.openai.com/oauth/token": {
        const body = new URLSearchParams(String(options?.body));
        assert.equal(body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
        assert.equal(body.get("code"), "test-device-code");
        assert.equal(body.get("code_verifier"), "test-device-verifier");
        assert.equal(body.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
        return tokenResponse();
      }
      default: throw new Error("Unexpected request; no real network is permitted.");
    }
  });
  const done = loginSubscription(chatModels(credentials), input, output).then(() => undefined, (error: unknown) => error);
  try {
    await waitFor(() => text.includes("Method [1]:")); input.write("2\n");
    assert.equal(await done, undefined);
    assert.equal(listen.mock.callCount(), 0); assert.equal(fetch.mock.callCount(), 3);
    assert(text.includes("https://auth.openai.com/codex/device")); assert(text.includes("TEST-1234"));
    assert.equal((await credentials.read("openai-codex") as OAuthCredential).accountId, "test-account");
    assert.equal(await credentials.read("openai"), undefined);
    assert(!text.includes(subscriptionCredential.access)); assert(!text.includes(subscriptionCredential.refresh));
  } finally {
    input.end(); await done; output.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
