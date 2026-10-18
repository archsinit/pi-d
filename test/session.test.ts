import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdtemp, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { DEFAULT_CHAT_AGENT, openPersistentChat, parseModel, parseThinking } from "../src/session.ts";
import { lockLost, model, testModels } from "./models.ts";

const context = BACKGROUND_CONTEXT;

test("parse model identifiers without breaking provider/model IDs containing slashes", () => {
  assert.deepEqual(parseModel("openrouter/anthropic/claude-opus-4-7"), { provider: "openrouter", modelId: "anthropic/claude-opus-4-7" });
  for (const value of ["", "openai", "/id", "openai/", " openai/id", "openai/id\n"]) assert.throws(() => parseModel(value));
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) assert.equal(parseThinking(level), level);
  for (const value of ["", "maximum", "MAX", " max", "max\n"]) assert.throws(() => parseThinking(value));
});

test("saved chat reopens in order with its model, and reset does not erase history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-session-"));
  const path = join(directory, "private", "chat.sqlite");
  const first = testModels({ responses: [fauxAssistantMessage("First answer."), fauxAssistantMessage("Second answer.")] });
  let chat = await openPersistentChat(path, first.models, { model, onLockLost: lockLost });
  try {
    for (const content of ["First input.", "Second input."]) {
      const submission = await chat.conversation.submit({ type: "input", content }, context);
      assert.equal((await submission.wait(context)).status, "done");
    }
    await chat.close();
    const reopened = testModels();
    chat = await openPersistentChat(path, reopened.models, { onLockLost: lockLost });
    assert.deepEqual((await chat.conversation.agent(context)).model, model);
    const entries = (await chat.conversation.context(context)).entries;
    assert.deepEqual(entries.flatMap((entry) => entry.model ?? []).map((message) => message.role), ["user", "assistant", "user", "assistant"]);
    assert.match(JSON.stringify(entries), /Second answer/);
    await chat.conversation.reset(undefined, context);
    assert.equal((await chat.conversation.context(context)).entries.length, 1);
    const all = await chat.conversation.entries({}, 100, undefined, context);
    assert.match(JSON.stringify(all.items), /First answer/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);
  } finally { await chat.close(); await rm(directory, { recursive: true, force: true }); }
});

test("writer ownership rejects duplicate and symlink-alias opens, releases on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-lock-"));
  const path = join(directory, "chat.sqlite"), alias = join(directory, "alias.sqlite");
  const { models } = testModels();
  const chat = await openPersistentChat(path, models, { model, onLockLost: lockLost });
  try {
    await symlink(path, alias);
    for (const file of [path, alias]) {
      await assert.rejects(openPersistentChat(file, models, { model, onLockLost: lockLost }), /already open/);
    }
    const hardLink = join(directory, "hard-linked.sqlite");
    await link(path, hardLink);
    await assert.rejects(openPersistentChat(hardLink, models, { model, onLockLost: lockLost }), /Hard-linked/);
    await rm(hardLink);
  } finally { await chat.close(); }
  const reopened = await openPersistentChat(alias, models, { onLockLost: lockLost });
  await reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test("failed initialization releases ownership and never truncates an existing store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-init-"));
  const path = join(directory, "chat.sqlite");
  const { models } = testModels();
  try {
    await assert.rejects(openPersistentChat(path, models, { onLockLost: lockLost }), /Choose a model/);
    const chat = await openPersistentChat(path, models, { model, onLockLost: lockLost });
    await chat.close();
    await assert.rejects(openPersistentChat(path, models, { model: parseModel("faux/not-present"), onLockLost: lockLost }), /Unknown chat model/);
    const again = await openPersistentChat(path, models, { onLockLost: lockLost });
    assert.deepEqual((await again.conversation.agent(context)).model, model);
    await again.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("model overrides cannot silently switch unfinished native work to another provider/model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-model-"));
  const path = join(directory, "chat.sqlite");
  const { models } = testModels({ models: [{ id: "one" }, { id: "two" }], tokensPerSecond: 20,
    responses: [fauxAssistantMessage("A slow response. ".repeat(30))] });
  const first = await openPersistentChat(path, models, { model: { provider: "faux", modelId: "one" }, onLockLost: lockLost });
  try {
    await first.conversation.submit({ type: "input", content: "Continue later." }, context);
    await delay(150);
    await first.close();
    await assert.rejects(openPersistentChat(path, models, { model: { provider: "faux", modelId: "two" }, onLockLost: lockLost }), /Unfinished work/);
    const resumed = await openPersistentChat(path, models, { onLockLost: lockLost });
    await resumed.conversation.abort(context);
    await resumed.close();
    const changed = await openPersistentChat(path, models, { model: { provider: "faux", modelId: "two" }, onLockLost: lockLost });
    assert.equal((await changed.conversation.agent(context)).model?.modelId, "two");
    await changed.close();
  } finally { await first.close(); await rm(directory, { recursive: true, force: true }); }
});

test("new defaults use medium reasoning; saved settings survive defaults, resets and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-thinking-"));
  const path = join(directory, "chat.sqlite");
  let reasoning: string | undefined;
  const { models, faux } = testModels({ provider: DEFAULT_CHAT_AGENT.model.provider, models: [{ id: "gpt-6.1-sol", reasoning: true }, { id: "small" }],
    responses: [(_context, options) => { reasoning = options?.reasoning; return fauxAssistantMessage("Offline medium answer."); }] });
  faux.models[0].thinkingLevelMap = { max: "max", xhigh: "xhigh" };
  let chat = await openPersistentChat(path, models, { defaults: DEFAULT_CHAT_AGENT, onLockLost: lockLost });
  try {
    assert.deepEqual((await chat.conversation.agent(context)).model, DEFAULT_CHAT_AGENT.model);
    assert.equal((await chat.conversation.agent(context)).thinkingLevel, "medium");
    const input = await chat.conversation.submit({ type: "input", content: "Offline medium test." }, context);
    assert.equal((await input.wait(context)).status, "done"); assert.equal(reasoning, "medium");
    await chat.conversation.configure({ thinkingLevel: "max" }, context);
    await chat.close();
    chat = await openPersistentChat(path, models, { defaults: DEFAULT_CHAT_AGENT, onLockLost: lockLost });
    assert.equal((await chat.conversation.agent(context)).thinkingLevel, "max");
    await chat.close();
    chat = await openPersistentChat(path, models, { defaults: { model: { provider: DEFAULT_CHAT_AGENT.model.provider, modelId: "small" }, thinkingLevel: "off" }, onLockLost: lockLost });
    assert.deepEqual((await chat.conversation.agent(context)).model, DEFAULT_CHAT_AGENT.model);
    assert.equal((await chat.conversation.agent(context)).thinkingLevel, "max");
    await chat.close();
    chat = await openPersistentChat(path, models, { thinkingLevel: "high", onLockLost: lockLost });
    await chat.conversation.reset(undefined, context);
    assert.equal((await chat.conversation.agent(context)).thinkingLevel, "high");
    await chat.close();
    chat = await openPersistentChat(path, models, { onLockLost: lockLost });
    assert.equal((await chat.conversation.agent(context)).thinkingLevel, "high");
    await chat.close();
    chat = await openPersistentChat(path, models, { model: { provider: DEFAULT_CHAT_AGENT.model.provider, modelId: "small" }, onLockLost: lockLost });
    assert.equal((await chat.conversation.agent(context)).thinkingLevel, "off");
  } finally { await chat.close(); await rm(directory, { recursive: true, force: true }); }
});

test("switching an older OpenAI session to Codex is explicit and preserves its committed history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-codex-switch-"));
  const path = join(directory, "chat.sqlite");
  const oldModel = { provider: "openai", modelId: "gpt-6.1-sol" };
  const old = testModels({ provider: "openai", models: [{ id: "gpt-6.1-sol", reasoning: true }], responses: [fauxAssistantMessage("Earlier answer.")] });
  const codex = testModels({ provider: "openai-codex", models: [{ id: "gpt-6.1-sol", reasoning: true }], responses: [fauxAssistantMessage("Codex answer.")] });
  old.faux.models[0].thinkingLevelMap = codex.faux.models[0].thinkingLevelMap = { max: "max" };
  old.models.setProvider(codex.faux.provider);
  let chat = await openPersistentChat(path, old.models, { model: oldModel, thinkingLevel: "max", onLockLost: lockLost });
  try {
    const first = await chat.conversation.submit({ type: "input", content: "Earlier prompt." }, context);
    assert.equal((await first.wait(context)).status, "done"); await chat.close();
    chat = await openPersistentChat(path, old.models, { defaults: DEFAULT_CHAT_AGENT, onLockLost: lockLost });
    assert.deepEqual((await chat.conversation.agent(context)).model, oldModel); await chat.close();
    chat = await openPersistentChat(path, old.models, { ...DEFAULT_CHAT_AGENT, onLockLost: lockLost });
    assert.deepEqual((await chat.conversation.agent(context)).model, DEFAULT_CHAT_AGENT.model);
    assert.equal((await chat.conversation.agent(context)).thinkingLevel, "medium");
    const second = await chat.conversation.submit({ type: "input", content: "Codex prompt." }, context);
    assert.equal((await second.wait(context)).status, "done");
    const entries = (await chat.conversation.context(context)).entries;
    assert.deepEqual(entries.flatMap((entry) => entry.model ?? []).map((message) => message.role), ["user", "assistant", "user", "assistant"]);
    assert.match(JSON.stringify(entries), /Earlier answer/); assert.match(JSON.stringify(entries), /Codex answer/);
  } finally { await chat.close(); await rm(directory, { recursive: true, force: true }); }
});

test("unsupported thinking is rejected without silently downgrading or changing the saved model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-thinking-invalid-"));
  const path = join(directory, "chat.sqlite");
  const { models } = testModels();
  try {
    await assert.rejects(openPersistentChat(path, models, { model, thinkingLevel: "max", onLockLost: lockLost }), /does not support max/);
    await assert.rejects(stat(path), { code: "ENOENT" });
    const invalidDefault = join(directory, "invalid-default.sqlite");
    await assert.rejects(openPersistentChat(invalidDefault, models, { defaults: { model, thinkingLevel: "max" }, onLockLost: lockLost }), /does not support max/);
    const corrected = await openPersistentChat(invalidDefault, models, { defaults: { model, thinkingLevel: "off" }, onLockLost: lockLost });
    try { assert.equal((await corrected.conversation.agent(context)).thinkingLevel, "off"); }
    finally { await corrected.close(); }
    const first = await openPersistentChat(path, models, { model, onLockLost: lockLost }); await first.close();
    await assert.rejects(openPersistentChat(path, models, { thinkingLevel: "max", onLockLost: lockLost }), /does not support max/);
    models.setProvider(builtinModels().getProvider(DEFAULT_CHAT_AGENT.model.provider)!);
    // Explicit thinking on resume is validated against the saved model, not new-session defaults.
    const saved = await openPersistentChat(path, models, { thinkingLevel: "off", defaults: DEFAULT_CHAT_AGENT, onLockLost: lockLost });
    try { assert.equal((await saved.conversation.agent(context)).thinkingLevel, "off"); }
    finally { await saved.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("thinking overrides cannot change unfinished native work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-thinking-live-"));
  const path = join(directory, "chat.sqlite");
  const { models, faux } = testModels({ models: [{ id: "faux-1", reasoning: true }], tokensPerSecond: 20,
    responses: [fauxAssistantMessage("A slow reasoning response. ".repeat(30))] });
  faux.models[0].thinkingLevelMap = { max: "max" };
  const first = await openPersistentChat(path, models, { model, thinkingLevel: "high", onLockLost: lockLost });
  try {
    await first.conversation.submit({ type: "input", content: "Continue later." }, context);
    await first.close();
    await assert.rejects(openPersistentChat(path, models, { thinkingLevel: "max", onLockLost: lockLost }), /Unfinished work/);
    const resumed = await openPersistentChat(path, models, { onLockLost: lockLost });
    try { assert.equal((await resumed.conversation.agent(context)).thinkingLevel, "high"); await resumed.conversation.abort(context); }
    finally { await resumed.close(); }
    const changed = await openPersistentChat(path, models, { thinkingLevel: "max", onLockLost: lockLost });
    try { assert.equal((await changed.conversation.agent(context)).thinkingLevel, "max"); }
    finally { await changed.close(); }
  } finally { await first.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a killed native generation recovers from SQLite after the dead owner's lock expires", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-crash-"));
  const path = join(directory, "chat.sqlite");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "test/crash-child.ts", path], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  try {
    for (let i = 0; i < 100 && !output.includes("PARTIAL"); i++) {
      if (child.exitCode !== null) throw new Error(`Child exited: ${errors}`);
      await delay(30);
    }
    assert(output.includes("PARTIAL"), errors);
    const id = Number(output.match(/INPUT (\d+)/)?.[1]) as SubmissionId;
    assert(Number.isSafeInteger(id));
    child.kill("SIGKILL"); await exited;
    // The old process is confirmed dead. Advance only its lock's mtime instead of waiting five minutes.
    const past = new Date(Date.now() - 301000);
    await utimes(`${path}.lock`, past, past);
    const { models } = testModels({ responses: [fauxAssistantMessage("Recovered by stock Durable.")] });
    const chat = await openPersistentChat(path, models, { onLockLost: lockLost });
    try {
      const input = await chat.harness.submission(id, context);
      assert(input);
      chat.harness.resume();
      assert.equal((await input.wait(context)).status, "done");
      assert.match(JSON.stringify((await chat.conversation.context(context)).entries), /Recovered by stock Durable/);
    } finally { await chat.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
