import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { chatModels, SubscriptionCredentials } from "../src/auth.ts";
import { mountChat, type ChatHandle } from "../src/chat.ts";
import { chatCommands, requireSubscription } from "../src/commands.ts";
import { Resources } from "../src/resources.ts";
import { openPersistentChat } from "../src/session.ts";
import { lockLost, model, subscriptionCredential, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for command/overlay.");
}

async function setup(models: ReturnType<typeof testModels>["models"], resources?: Resources, selected = model) {
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, { agent: { model: selected, cwd: resources?.configDir } });
  const chat: ChatHandle = { harness, conversation, label: "offline", close: () => harness.close(context) };
  chat.command = chatCommands(chat, models, resources);
  chat.beforeModel = () => requireSubscription(chat, models);
  const terminal = new TestTerminal(100, 30), app = await mountChat(chat, terminal, false);
  return { chat, terminal, app };
}

async function enter(fixture: Awaited<ReturnType<typeof setup>>, text: string) {
  fixture.terminal.send(`\x1b[200~${text}\x1b[201~`); fixture.terminal.send("\r");
  await fixture.terminal.flush();
}

function clearDraft(fixture: Awaited<ReturnType<typeof setup>>) { fixture.app.ui.composer.editor.setText(""); }

for (const command of ["new", "clear"]) {
  test(`/${command} resets active context locally, keeping stored history, settings and a newer draft`, async (t) => {
    let nextMessages = "";
    const { models, faux } = testModels({ models: [{ id: "faux-1", reasoning: true }], responses: [
      fauxAssistantMessage("Earlier answer."),
      (transcript) => { nextMessages = JSON.stringify(transcript.messages); return fauxAssistantMessage("Fresh answer."); },
    ] });
    const fixture = await setup(models), { app, terminal, chat } = fixture;
    const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    try {
      await chat.conversation.configure({ thinkingLevel: "high" }, context);
      const agent = await chat.conversation.agent(context);
      await enter(fixture, "Earlier input."); await until(() => faux.state.callCount === 1);
      await chat.conversation.waitForIdle(context); await terminal.flush();
      const reset = chat.conversation.reset.bind(chat.conversation);
      t.mock.method(chat.conversation, "reset", async (...args: Parameters<typeof reset>) => {
        reached.resolve(); await release.promise; return reset(...args);
      });
      const preflight = t.mock.fn(() => requireSubscription(chat, models));
      chat.beforeModel = preflight;
      const selection = t.mock.method(app.ui.tui, "resetTextSelection");
      const scroll = t.mock.method(app.ui.scroll, "scrollToEnd");
      await enter(fixture, `/${command}`); await reached.promise;
      app.ui.composer.editor.setText("next draft");
      release.resolve(); await until(() => !app.ui.busy); await terminal.flush();
      const active = await chat.conversation.context(context);
      assert.equal(active.entries.length, 1); assert.equal(active.messages.length, 0);
      const stored = await chat.conversation.entries({}, 100, undefined, context);
      assert.match(JSON.stringify(stored.items), /Earlier input/); assert.match(JSON.stringify(stored.items), /Earlier answer/);
      assert(!JSON.stringify(stored.items).includes(`/${command}`));
      assert.deepEqual(await chat.conversation.agent(context), agent);
      assert.equal(app.ui.composer.editor.getExpandedText(), "next draft");
      assert.equal(faux.state.callCount, 1); assert.equal(preflight.mock.callCount(), 0);
      assert.equal(selection.mock.callCount(), 1); assert(scroll.mock.callCount() > 0);
      assert(!terminal.text().includes("Earlier input.")); assert(!terminal.text().includes("Earlier answer."));
      clearDraft(fixture); await enter(fixture, "Fresh input."); await until(() => faux.state.callCount === 2);
      await chat.conversation.waitForIdle(context);
      assert.match(nextMessages, /Fresh input/); assert(!nextMessages.includes("Earlier input")); assert(!nextMessages.includes("Earlier answer"));
    } finally { release.resolve(); await app.close(); terminal.dispose(); }
  });
}

test("reset commands refuse unfinished work and arguments without resetting or making model requests", async (t) => {
  const { models, faux } = testModels({ tokensPerSecond: 20, responses: [fauxAssistantMessage("Slow answer. ".repeat(100))] });
  const fixture = await setup(models), { app, terminal, chat } = fixture;
  const reset = t.mock.method(chat.conversation, "reset");
  try {
    await enter(fixture, "Keep this input."); await until(() => faux.state.callCount === 1);
    for (const command of ["new", "clear"]) {
      clearDraft(fixture); await enter(fixture, `/${command}`);
      await until(() => app.ui.composer.editor.getText() === `/${command}`); await terminal.flush();
      assert.match(terminal.text(), /Unfinished work/);
      assert(app.ui.busy);
      assert((await chat.conversation.context(context)).messages.some((message) => message.role === "user" && message.content === "Keep this input."));
    }
    await chat.conversation.abort(context); await chat.conversation.waitForIdle(context); await terminal.flush();
    for (const command of ["new", "clear"]) {
      clearDraft(fixture); await enter(fixture, `/${command} extra`); await until(() => !app.ui.busy); await terminal.flush();
      assert.match(terminal.text(), /without arguments/);
      assert.equal(app.ui.composer.editor.getText(), `/${command} extra`);
    }
    assert.equal(reset.mock.callCount(), 0); assert.equal(faux.state.callCount, 1);
  } finally { await app.close(); terminal.dispose(); }
});

test("model/reasoning commands are local, filterable and validated; cancellation restores the command and newer draft", async () => {
  const { models } = testModels({ models: [{ id: "faux-1", reasoning: true }] });
  const fixture = await setup(models), { app, terminal, chat } = fixture;
  try {
    await enter(fixture, "/reasoning high"); await until(() => !app.ui.busy);
    assert.equal((await chat.conversation.agent(context)).thinkingLevel, "high");
    await enter(fixture, "/reasoning max"); await until(() => !app.ui.busy);
    assert.match(terminal.text(), /Unsupported reasoning/); assert.equal((await chat.conversation.agent(context)).thinkingLevel, "high");
    clearDraft(fixture); await enter(fixture, "/model"); await until(() => terminal.text().includes("Choose a model"));
    terminal.send("faux/"); terminal.send("\r"); await until(() => !app.ui.busy);
    assert.deepEqual((await chat.conversation.agent(context)).model, model);
    assert.equal((await chat.conversation.agent(context)).thinkingLevel, "high", "Selecting the same model must retain reasoning.");
    await enter(fixture, "/model missing/no-model"); await until(() => !app.ui.busy);
    assert.match(terminal.text(), /Unknown chat model/); assert.deepEqual((await chat.conversation.agent(context)).model, model);
    clearDraft(fixture); await enter(fixture, "/reasoning"); await until(() => terminal.text().includes("Choose reasoning"));
    app.ui.composer.editor.setText("new draft"); terminal.send("\x1b"); await until(() => !app.ui.busy);
    assert.equal(app.ui.composer.editor.getExpandedText(), "/reasoning\n\nnew draft");
    assert.equal((await chat.conversation.context(context)).messages.filter((message) => message.role === "user").length, 0);
  } finally { await app.close(); terminal.dispose(); }
});

test("a missing subscription blocks model admission without API-key fallback, while reset commands remain local", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-command-auth-"));
  const credentials = new SubscriptionCredentials(join(directory, "config", "auth.json")), models = chatModels(credentials);
  const request = t.mock.method(globalThis, "fetch", async () => { throw new Error("No network is permitted."); });
  const fixture = await setup(models, new Resources(join(directory, "config"), [], directory), { provider: "openai-codex", modelId: "gpt-6.1-sol" });
  try {
    assert.equal((await fixture.chat.harness.inspect(context)).scheduling, "paused");
    assert.equal(fixture.app.ui.unavailable, false);
    await enter(fixture, "Must not be admitted."); await until(() => !fixture.app.ui.busy);
    assert.match(fixture.terminal.text(), /ChatGPT is not connected/);
    assert.equal(fixture.app.ui.composer.editor.getText(), "Must not be admitted.");
    assert.equal((await fixture.chat.conversation.context(context)).entries.length, 0);
    for (const command of ["new", "clear"]) {
      clearDraft(fixture); await enter(fixture, `/${command}`); await until(() => !fixture.app.ui.busy);
      assert.equal(fixture.app.ui.composer.editor.getText(), "");
      const active = await fixture.chat.conversation.context(context);
      assert.equal(active.entries.length, 1); assert.equal(active.messages.length, 0);
    }
    clearDraft(fixture); await enter(fixture, "Still must not be admitted."); await until(() => !fixture.app.ui.busy);
    assert.equal(fixture.app.ui.composer.editor.getText(), "Still must not be admitted.");
    assert.equal((await fixture.chat.conversation.context(context)).messages.length, 0);
    assert.equal(request.mock.callCount(), 0);
  } finally { await fixture.app.close(); fixture.terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("/skill loads explicit-only instructions as one admitted input, while list/help/unknown commands never become chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-command-skills-")), path = join(directory, "skills", "manual", "SKILL.md");
  await mkdir(join(directory, "skills", "manual"), { recursive: true });
  await writeFile(path, "---\nname: manual\ndescription: Fixture skill\ndisable-model-invocation: true\n---\nFULL EXPLICIT INSTRUCTIONS");
  const { models, faux } = testModels();
  const fixture = await setup(models, new Resources(directory, [], directory));
  try {
    await enter(fixture, "/skills"); await until(() => fixture.terminal.text().includes("explicit only"));
    fixture.terminal.send("\r"); await until(() => !fixture.app.ui.busy);
    await enter(fixture, "/help"); await until(() => fixture.terminal.text().includes("Workspace:"));
    assert.match(fixture.terminal.text(), /\/new.*Reset active context/);
    assert.match(fixture.terminal.text(), /\/clear.*Same as \/new/);
    assert(!fixture.terminal.text().includes("Ctrl+N"));
    fixture.terminal.send("\r"); await until(() => !fixture.app.ui.busy);
    assert.equal((await fixture.chat.conversation.context(context)).entries.length, 0);
    await enter(fixture, "/not-a-command"); await until(() => !fixture.app.ui.busy);
    assert.equal(faux.state.callCount, 0); clearDraft(fixture);
    await enter(fixture, "/skill:manual apply it"); await until(() => faux.state.callCount > 0); await fixture.chat.conversation.waitForIdle(context);
    const users = (await fixture.chat.conversation.context(context)).messages.filter((message) => message.role === "user");
    assert.equal(users.length, 1); assert.match(JSON.stringify(users[0]), /FULL EXPLICIT INSTRUCTIONS/); assert.match(JSON.stringify(users[0]), /apply it/);
    await fixture.terminal.flush(); await enter(fixture, "//literal-command"); await until(() => faux.state.callCount > 1); await fixture.chat.conversation.waitForIdle(context);
    assert((await fixture.chat.conversation.context(context)).messages.some((message) => message.role === "user" && message.content === "/literal-command"));
  } finally { await fixture.app.close(); fixture.terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("in-app native Codex browser login uses a local callback overlay, persists privately, and logout stays outside history", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-overlay-login-"));
  const credentials = new SubscriptionCredentials(join(directory, "config", "auth.json")), models = chatModels(credentials);
  const fixture = await setup(models, new Resources(join(directory, "config"), [], directory), { provider: "openai-codex", modelId: "gpt-6.1-sol" });
  let authorization: URL | undefined;
  const originalLogin = models.login.bind(models);
  t.mock.method(models, "login", async (...[provider, method, interaction]: Parameters<typeof models.login>) => originalLogin(provider, method, { ...interaction, notify: (event) => {
    if (event.type === "auth_url") authorization = new URL(event.url);
    interaction.notify(event);
  } }));
  const listen = t.mock.method(Server.prototype, "listen", function (this: Server) {
    queueMicrotask(() => this.emit("error", Object.assign(new Error("Offline callback test"), { code: "EADDRINUSE" }))); return this;
  });
  const request = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), "https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(String(options?.body));
    assert.equal(body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann"); assert.equal(body.get("code"), "offline-overlay-code");
    return Response.json({ access_token: subscriptionCredential.access, refresh_token: subscriptionCredential.refresh, expires_in: 3600 });
  });
  try {
    await enter(fixture, "/login"); await until(() => fixture.terminal.text().includes("Browser"));
    fixture.terminal.send("\r"); await until(() => !!authorization); await fixture.terminal.flush();
    assert.equal(authorization!.searchParams.get("originator"), "pi");
    const callback = new URL("http://localhost:1455/auth/callback"); callback.searchParams.set("code", "offline-overlay-code"); callback.searchParams.set("state", authorization!.searchParams.get("state")!);
    await until(() => /paste the authorization code/i.test(fixture.terminal.text()));
    fixture.terminal.send(`\x1b[200~${callback}\x1b[201~`); fixture.terminal.send("\r");
    await until(() => !fixture.app.ui.busy); await fixture.terminal.flush();
    assert.match(fixture.terminal.text(), /ChatGPT connected/);
    assert.equal((await credentials.read("openai-codex") as OAuthCredential).access, subscriptionCredential.access);
    assert.equal(listen.mock.callCount(), 1); assert.equal(request.mock.callCount(), 1);
    assert(!fixture.terminal.text().includes(subscriptionCredential.access)); assert(!fixture.terminal.text().includes("offline-overlay-code"));
    await enter(fixture, "/logout"); await until(() => !fixture.app.ui.busy);
    assert.equal(await credentials.read("openai-codex"), undefined);
    assert.equal((await fixture.chat.conversation.context(context)).entries.length, 0);
    t.mock.method(models, "login", async () => { throw new Error("SECRET-LOGIN-ERROR-BODY"); });
    await enter(fixture, "/login"); await until(() => !fixture.app.ui.busy); await fixture.terminal.flush();
    assert.match(fixture.terminal.text(), /ChatGPT sign-in failed/);
    assert(!fixture.terminal.text().includes("SECRET-LOGIN-ERROR-BODY"));
  } finally { await fixture.app.close(); fixture.terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("/login is available for paused unfinished native work and resumes it without discarding its input", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-paused-login-")), file = join(directory, "session.sqlite");
  const credentials = new SubscriptionCredentials(join(directory, "config", "auth.json")), models = chatModels(credentials);
  const { faux } = testModels({ provider: "openai-codex", models: [{ id: "gpt-6.1-sol" }], tokensPerSecond: 60,
    responses: [fauxAssistantMessage("Paused native answer. ".repeat(500)), fauxAssistantMessage("Recovered answer.")] });
  models.setProvider({ ...faux.provider, auth: models.getProvider("openai-codex")!.auth });
  await credentials.modify("openai-codex", async () => subscriptionCredential);
  let chat = await openPersistentChat(file, models, { model: { provider: "openai-codex", modelId: "gpt-6.1-sol" }, defaultCwd: directory, onLockLost: lockLost, gateModelWork: true });
  let app: Awaited<ReturnType<typeof mountChat>> | undefined;
  const terminal = new TestTerminal(100, 30);
  const requests = t.mock.method(globalThis, "fetch", async () => { throw new Error("No network is permitted."); });
  try {
    chat.allowModel!();
    await chat.conversation.submit({ type: "input", content: "Keep this admitted input." }, context);
    for (let i = 0; i < 200; i++) {
      const live = await chat.harness.snapshot(LiveDoc, chat.conversation.id, context);
      if (live?.generation?.message?.content.some((part) => part.type === "text" && part.text.length > 0)) break;
      await delay(10);
    }
    assert((await chat.harness.snapshot(LiveDoc, chat.conversation.id, context))?.run);
    await chat.close(); await models.logout("openai-codex");
    await assert.rejects(openPersistentChat(file, models, { cwd: join(directory, "other"), onLockLost: lockLost }), /Unfinished work/);
    chat = await openPersistentChat(file, models, { onLockLost: lockLost, gateModelWork: true });
    chat.beforeModel = () => requireSubscription(chat, models);
    chat.command = chatCommands(chat, models, new Resources(join(directory, "config"), [], directory));
    t.mock.method(models, "login", async (...[provider, type, interaction]: Parameters<typeof models.login>) => {
      assert.equal(provider, "openai-codex"); assert.equal(type, "oauth");
      await interaction.prompt({ type: "select", message: "Offline paused login", options: [{ id: "fixture", label: "Fixture approval" }] });
      await credentials.modify("openai-codex", async () => subscriptionCredential);
    });
    app = await mountChat(chat, terminal, false); await terminal.flush();
    assert(app.ui.busy); assert.equal((await chat.harness.inspect(context)).scheduling, "paused"); assert.equal(faux.state.callCount, 1);
    // Native control operations can resume scheduling without authorizing traffic. Login must still be available.
    chat.harness.resume(); await delay(30); assert.equal((await chat.harness.inspect(context)).scheduling, "running"); assert.equal(faux.state.callCount, 1);
    terminal.send("/login"); assert.equal(app.ui.composer.editor.disableSubmit, false); terminal.send("\r");
    await until(() => terminal.text().includes("Fixture approval")); terminal.send("\r");
    await until(() => faux.state.callCount === 2); await chat.conversation.waitForIdle(context);
    const users = (await chat.conversation.context(context)).messages.filter((message) => message.role === "user");
    assert.equal(users.length, 1); assert.match(JSON.stringify(users[0]), /Keep this admitted input/);
    assert.equal(requests.mock.callCount(), 0);
  } finally { await app?.close(); await chat.close(); terminal.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("Escape cancels an in-flight auth preflight without admitting input or losing a newer draft", async (t) => {
  const { models, faux } = testModels(), fixture = await setup(models);
  const authorize = t.mock.fn(); fixture.chat.allowModel = authorize;
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  fixture.chat.beforeModel = async () => { reached.resolve(); await release.promise; };
  try {
    await enter(fixture, "pending input"); await reached.promise;
    fixture.app.ui.composer.editor.setText("next draft");
    fixture.terminal.send("\x1b"); release.resolve(); await until(() => !fixture.app.ui.busy);
    assert.equal(fixture.app.ui.composer.editor.getExpandedText(), "pending input\n\nnext draft");
    assert.equal(authorize.mock.callCount(), 0, "A cancelled preflight must not release background model work.");
    assert.equal(faux.state.callCount, 0);
    assert.equal((await fixture.chat.conversation.context(context)).entries.length, 0);
  } finally { release.resolve(); await fixture.app.close(); fixture.terminal.dispose(); }
});

test("shutdown aborts and joins an open local command before restoring the terminal and closing Durable", async () => {
  const { models } = testModels(), fixture = await setup(models);
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  fixture.chat.command = async (_text, _ui, signal) => {
    reached.resolve(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await release.promise; return;
  };
  try {
    await enter(fixture, "/wait"); await reached.promise;
    let closed = false; const closing = fixture.app.close().then(() => { closed = true; });
    await delay(30); assert.equal(closed, false); assert.equal(fixture.terminal.stopped, false);
    release.resolve(); await closing;
    assert(fixture.terminal.stopped); assert.equal((await fixture.chat.harness.closed).reason, "closed");
  } finally { release.resolve(); await fixture.app.close(); fixture.terminal.dispose(); }
});
