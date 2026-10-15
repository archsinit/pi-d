import { mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { AgentDoc, createRegistry, createSession, Harness, ROOT_CONVERSATION_ID, type HarnessOptions, type ModelRef, type Registry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase, type NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import type { ChatHandle } from "./chat.ts";
import { LoadedExtensions } from "./status.ts";

export const DEFAULT_CHAT_AGENT = {
  model: { provider: "openai-codex", modelId: "gpt-6.1-sol" }, thinkingLevel: "max",
} satisfies { model: ModelRef; thinkingLevel: ModelThinkingLevel };

export function parseThinking(value: string): ModelThinkingLevel {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const level = levels.find((level) => level === value);
  if (!level) throw new Error(`Thinking must be one of: ${levels.join(", ")}.`);
  return level;
}

export function parseModel(value: string): ModelRef {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || /\s/.test(value)) {
    throw new Error("Model must be provider/model-id (for example openai-codex/gpt-6.1-sol).");
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

async function lockSession(path: string, onLockLost: (error: Error) => never) {
  if ((await stat(path)).nlink !== 1) throw new Error("Hard-linked session files are not supported. Copy a closed store instead.");
  return lockfile.lock(path, { retries: 0, stale: 300000, update: 15000, onCompromised: onLockLost }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOCKED") throw new Error(`Session is already open: ${path}`);
    throw error;
  });
}

/** Read native metadata under normal ownership, without constructing a Harness or normalizing/running tasks. */
export async function readSessionInfo(file: string, onLockLost: (error: Error) => never) {
  const path = await realpath(file), release = await lockSession(path, onLockLost);
  try {
    const database = await openNodeSqliteDatabase(path);
    let storage: SqliteStorage;
    try { await database.exec("PRAGMA synchronous = FULL"); storage = await SqliteStorage.open(database); }
    catch (error) { await database.close(); throw error; }
    const session = createSession(storage), context = BACKGROUND_CONTEXT;
    try {
      const agent = await session.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context);
      let unfinished = false;
      for (const status of ["pending", "running", "waiting", "completing"] as const) {
        if ((await storage.scanTasks({ status }, 1, undefined, context)).items.length) { unfinished = true; break; }
      }
      for (const status of ["queued", "placed"] as const) {
        if ((await storage.scanSubmissions({ status }, 1, undefined, context)).items.length) { unfinished = true; break; }
      }
      return { file: path, cwd: agent?.cwd, unfinished };
    } finally { await session.close(context); }
  } finally { await release(); }
}

export async function openPersistentChat(
  file: string, models: Models,
  options: {
    model?: ModelRef; thinkingLevel?: ModelThinkingLevel;
    defaults?: { model: ModelRef; thinkingLevel?: ModelThinkingLevel };
    registry?: Registry; env?: HarnessOptions["env"]; cwd?: string; defaultCwd?: string;
    onReport?: (error: unknown) => void; onLockLost: (error: Error) => never;
  },
): Promise<ChatHandle> {
  const context = BACKGROUND_CONTEXT;
  const initialModel = options.model ?? options.defaults?.model;
  const isDefaultModel = initialModel?.provider === options.defaults?.model.provider && initialModel?.modelId === options.defaults?.model.modelId;
  const initialThinking = options.thinkingLevel ?? (isDefaultModel ? options.defaults?.thinkingLevel : undefined);
  const validate = (ref: ModelRef, thinking?: ModelThinkingLevel) => {
    const model = models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`Unknown chat model ${ref.provider}/${ref.modelId}. Use --list-models.`);
    if (thinking !== undefined && !getSupportedThinkingLevels(model).includes(thinking)) {
      throw new Error(`${ref.provider}/${ref.modelId} does not support ${thinking} thinking. Supported: ${getSupportedThinkingLevels(model).join(", ")}.`);
    }
  };
  if (options.model) validate(options.model, initialThinking);
  const requested = resolve(file);
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
  // Reserve a private file without truncation, so proper-lockfile can canonicalize it.
  const placeholder = await open(requested, "a", 0o600);
  await placeholder.close();
  const path = await realpath(requested);
  const release = await lockSession(path, options.onLockLost);
  let database: NodeSqliteDatabase | undefined;
  let harness: Harness | undefined;
  try {
    database = await openNodeSqliteDatabase(path);
    await database.exec("PRAGMA synchronous = FULL");
    const storage = await SqliteStorage.open(database);
    harness = await Harness.open(storage, {
      models, registry: options.registry ?? createRegistry(), env: options.env, onReport: options.onReport,
      settings: { progress: { partialIntervalMs: 200 } },
    }, context);
    const conversation = await harness.root(context, initialModel ? {
      agent: { model: initialModel, thinkingLevel: initialThinking, cwd: options.cwd ?? options.defaultCwd },
      init: () => validate(initialModel, initialThinking),
    } : undefined);
    const current = await conversation.agent(context);
    const selected = options.model ?? current.model ?? initialModel;
    if (!selected) throw new Error("Choose a model with --model provider/model-id. Use --list-models to see the pinned catalog.");
    const modelChanged = current.model?.provider !== selected.provider || current.model.modelId !== selected.modelId;
    const thinking = options.thinkingLevel ?? (modelChanged ? initialThinking : undefined);
    validate(selected, thinking);
    const cwdChanged = options.cwd !== undefined && options.cwd !== current.cwd;
    if (modelChanged || cwdChanged || (thinking !== undefined && thinking !== current.thinkingLevel)) {
      const pending = await harness.inspect(context);
      if (pending.tasks.length || pending.submissions.length) throw new Error("Unfinished work exists. Reopen without model/thinking/workspace overrides; /interrupt stops foreground work, and background work must finish before changing settings.");
      await conversation.configure({ model: modelChanged ? selected : undefined, thinkingLevel: modelChanged ? thinking ?? null : thinking, cwd: cwdChanged ? options.cwd : undefined }, context);
    }
    // Bind an older chat-only store before resuming, only after settings validation.
    if (!current.cwd && options.defaultCwd && !options.cwd) await conversation.configure({ cwd: options.defaultCwd }, context);
    const extensionNames = (options.registry?.snapshot().installed() ?? []).map((extension) => extension.name);
    const inspection = await harness.inspect(context);
    const required = await harness.snapshot(LoadedExtensions, context);
    // Keep the last loaded set while recovery is pending; an idle reopen may deliberately omit extensions.
    if (!required || (!inspection.tasks.length && !inspection.submissions.length)) {
      await harness.commit(async (tx) => { (await tx.doc(LoadedExtensions)).names = extensionNames; }, context);
    }
    const owner = harness;
    let closed: Promise<void> | undefined;
    return {
      harness, conversation, models, file: path, extensionNames, label: basename(path),
      close: () => closed ??= owner.close(context).finally(release),
    };
  } catch (error) {
    try {
      if (harness) await harness.close(context);
      else await database?.close();
    } finally { await release(); }
    throw error;
  }
}
