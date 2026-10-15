import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import lockfile from "proper-lockfile";

const subscriptionProviders = ["openai", "openai-codex"] as const;
type SubscriptionProvider = typeof subscriptionProviders[number];
type StoredAuth = { deviceId?: string } & Partial<Record<SubscriptionProvider, OAuthCredential>>;
function isSubscriptionProvider(id: string): id is SubscriptionProvider {
  return subscriptionProviders.some((provider) => provider === id);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

export function credentialFile(): string {
  const home = process.env.XDG_CONFIG_HOME;
  return join(home && isAbsolute(home) ? home : join(homedir(), ".config"), "pi-d", "auth.json");
}

function validateCredential(value: unknown): asserts value is OAuthCredential {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "oauth" ||
    !("access" in value) || typeof value.access !== "string" || !value.access.trim() || value.access.trim().startsWith("sk-") ||
    !("refresh" in value) || typeof value.refresh !== "string" || !value.refresh.trim() ||
    !("expires" in value) || typeof value.expires !== "number" || !Number.isFinite(value.expires)) {
    throw new Error("Invalid pi-d ChatGPT credential. Use --login; API keys are not accepted for OpenAI.");
  }
}

// App-owned persistence only; pi-ai owns login, token refresh and request authentication.
export class SubscriptionCredentials implements CredentialStore {
  readonly file: string;
  constructor(file = credentialFile()) { this.file = resolve(file); }

  private async load(): Promise<StoredAuth> {
    let text: string;
    try {
      const directory = await lstat(dirname(this.file));
      if (!directory.isDirectory() || (directory.mode & 0o077)) throw new Error("pi-d's credential directory must be private (0700).");
      const info = await lstat(this.file);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077)) {
        throw new Error("pi-d auth.json must be a private, single-link regular file (0600), not a symlink.");
      }
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (code(error) === "ENOENT") return {};
      throw error;
    }
    let data: StoredAuth;
    try { data = text === "" ? {} : JSON.parse(text); }
    catch { throw new Error("Invalid pi-d auth.json. Restore a private backup or move it aside and use --login."); }
    if (!data || typeof data !== "object" || Array.isArray(data) ||
      (data.deviceId !== undefined && (typeof data.deviceId !== "string" || !uuid.test(data.deviceId)))) {
      throw new Error("Invalid pi-d auth.json installation ID.");
    }
    for (const provider of subscriptionProviders) {
      if (data[provider] !== undefined) validateCredential(data[provider]);
    }
    return data;
  }

  private async save(data: StoredAuth): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(data) + "\n"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.file);
      const directory = await open(dirname(this.file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }

  private async update(fn: (data: StoredAuth) => Promise<StoredAuth | undefined>, options?: AuthOperationOptions): Promise<StoredAuth> {
    options?.signal?.throwIfAborted();
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await this.load(); // Validate privacy before reserving the file and taking a canonical-path lock.
    try { const file = await open(this.file, "ax", 0o600); await file.close(); }
    catch (error) { if (code(error) !== "EEXIST") throw error; }
    let lost: Error | undefined;
    let release: (() => Promise<void>) | undefined;
    while (!release) {
      options?.signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.file, {
          retries: 0, stale: 300000, update: 15000, onCompromised: (error) => { lost = error; },
        });
      } catch (error) {
        if (code(error) !== "ELOCKED") throw error;
        await delay(100, undefined, { signal: options?.signal });
      }
    }
    try {
      options?.signal?.throwIfAborted();
      const current = await this.load();
      const next = await fn(current);
      if (lost) throw new Error("pi-d credential ownership lost; sign in again.");
      // Once fn starts, finish persistence even after cancellation: refresh may have rotated the token.
      if (next) await this.save(next);
      return next ?? current;
    } finally { await release(); }
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const credential = isSubscriptionProvider(providerId) ? (await this.load())[providerId] : undefined;
    options?.signal?.throwIfAborted();
    return credential;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const data = await this.load();
    options?.signal?.throwIfAborted();
    return subscriptionProviders.filter((id) => data[id]).map((providerId) => ({ providerId, type: "oauth" }));
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (!isSubscriptionProvider(providerId)) throw new Error("pi-d only stores OpenAI subscription credentials.");
    const data = await this.update(async (current) => {
      const next = await fn(current[providerId] ? structuredClone(current[providerId]) : undefined);
      if (next === undefined) return undefined;
      validateCredential(next);
      return { ...current, [providerId]: next };
    }, options);
    return data[providerId];
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (!isSubscriptionProvider(providerId)) return;
    await this.update(async (current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    }, options);
  }
}

export function chatModels(credentials: CredentialStore) {
  const models = builtinModels({ credentials });
  for (const id of subscriptionProviders) {
    const provider = models.getProvider(id)!;
    if (!provider.auth.oauth?.isSubscription) throw new Error(`The pinned ${id} subscription provider is missing.`);
    // Missing credentials, logout and refresh failure must never fall back to OPENAI_API_KEY.
    models.setProvider({ ...provider, auth: { oauth: provider.auth.oauth } });
  }
  return models;
}
