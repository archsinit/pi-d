import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mountChat, type ChatHandle } from "../src/chat.ts";
import { chatCommands } from "../src/commands.ts";
import { commandCompletion } from "../src/completion.ts";
import { Resources } from "../src/resources.ts";
import { model, testModels } from "./models.ts";
import { TestTerminal } from "./terminal.ts";

const context = BACKGROUND_CONTEXT;
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for completion.");
}

test("completion covers commands, explicit-only skills, model IDs and only supported reasoning without model calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-completion-"));
  await mkdir(join(directory, "skills", "manual"), { recursive: true });
  await writeFile(join(directory, "skills", "manual", "SKILL.md"), "---\nname: manual\ndescription: Manual instructions\ndisable-model-invocation: true\n---\nFULL-BODY-NOT-IN-COMPLETION");
  const resources = new Resources(directory, [], directory);
  const { models, faux } = testModels({ models: [{ id: "faux-1", reasoning: true }, { id: "small" }] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, { agent: { model, cwd: directory } });
  const chat: ChatHandle = { harness, conversation, models, label: "test", close: () => harness.close(context) };
  const provider = commandCompletion(chat, models, resources);
  const suggestions = (text: string, force = false, signal = new AbortController().signal) => provider.getSuggestions([text], 0, text.length, { signal, force });
  try {
    assert((await suggestions("/rea"))?.items.some((item) => item.value === "reasoning"));
    assert((await suggestions("/skill:man", true))?.items.some((item) => item.value === "skill:manual"));
    assert(!JSON.stringify(await suggestions("/skill:man")).includes("FULL-BODY"));
    assert.deepEqual((await suggestions("/model faux/sm", true))?.items.map((item) => item.value), ["faux/small"]);
    assert.deepEqual((await suggestions("/reasoning hi", true))?.items.map((item) => item.value), ["high"]);
    assert.equal(await suggestions("/reasoning max"), null);
    assert.equal(await suggestions("//literal", true), null);
    assert.equal(await suggestions("src/", true), null);
    assert.equal(await suggestions("text /rea", true), null);
    const controller = new AbortController(); controller.abort();
    assert.equal(await suggestions("/", false, controller.signal), null);
    const applied = provider.applyCompletion(["/skill:man"], 0, 10, { value: "skill:manual", label: "skill:manual" }, "/skill:man");
    assert.equal(applied.lines[0], "/skill:manual ");
    assert.equal(faux.state.callCount, 0);
  } finally { await chat.close(); await rm(directory, { recursive: true, force: true }); }
});

test("stale and failed skill completion reads do not reject or poison the native editor provider", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-completion-cancel-"));
  const resources = new Resources(directory, [], directory), { models } = testModels();
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, { agent: { model, cwd: directory } });
  const chat: ChatHandle = { harness, conversation, label: "test", close: () => harness.close(context) };
  const provider = commandCompletion(chat, models, resources);
  const gate = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
  t.mock.method(resources, "skills", async () => {
    reached.resolve(); await gate.promise;
    return { skills: [{ name: "manual", description: "quiet\x1b[2J\ntext", filePath: "unused.md", disableModelInvocation: true }], diagnostics: [] };
  });
  try {
    const controller = new AbortController();
    const pending = provider.getSuggestions(["/"], 0, 1, { signal: controller.signal });
    await reached.promise; controller.abort(); gate.resolve();
    assert.equal(await pending, null);
    const next = await provider.getSuggestions(["/skill:man"], 0, 10, { signal: new AbortController().signal });
    assert(next); assert.equal(next.items[0].description, "[request] — quiet text");
    t.mock.method(resources, "skills", async () => { throw new Error("PRIVATE-PARSE-ERROR"); });
    const base = await provider.getSuggestions(["/rea"], 0, 4, { signal: new AbortController().signal });
    assert(base?.items.some((item) => item.value === "reasoning"));
    assert(!JSON.stringify(base).includes("PRIVATE-PARSE-ERROR"));
  } finally { gate.resolve(); await chat.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native completion renders below the composer, reflows, completes arguments, and Escape closes it before interrupting a run", async () => {
  const { models, faux } = testModels({ models: [{ id: "faux-1", reasoning: true }], tokensPerSecond: 30,
    responses: [fauxAssistantMessage("Slow answer. ".repeat(100))] });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, { agent: { model } });
  const chat: ChatHandle = { harness, conversation, models, label: "test", close: () => harness.close(context) };
  chat.command = chatCommands(chat, models); chat.completion = commandCompletion(chat, models);
  const terminal = new TestTerminal(100, 30), app = await mountChat(chat, terminal, false);
  try {
    terminal.send("/rea"); await until(() => app.ui.composer.editor.isShowingAutocomplete()); await terminal.flush();
    for (const [columns, rows] of [[40, 16], [80, 24], [110, 36]]) {
      terminal.resize(columns, rows); await terminal.flush();
      const screen = terminal.text().split("\n");
      const lower = screen.findLastIndex((line) => line.startsWith("╰─"));
      assert(screen.slice(lower + 1).some((line) => line.includes("reasoning")), "Menu belongs below the framed composer.");
      assert(app.ui.tui.getScreenLines().every((line) => visibleWidth(line) <= columns));
      assert.match(screen.at(-1) ?? "", /ctx ~/);
    }
    terminal.send("\t"); assert.equal(app.ui.composer.editor.getExpandedText(), "/reasoning ");
    app.ui.composer.editor.setText("/reasoning hi"); terminal.send("\t");
    await until(() => app.ui.composer.editor.getExpandedText() === "/reasoning high");
    terminal.send("\r"); await until(() => !app.ui.busy);
    assert.equal((await conversation.agent(context)).thinkingLevel, "high"); assert.equal(faux.state.callCount, 0);
    app.ui.composer.editor.setText("first input"); terminal.send("\r"); await until(() => faux.state.callCount === 1);
    terminal.send("/rea"); await until(() => app.ui.composer.editor.isShowingAutocomplete());
    terminal.send("\x1b"); await terminal.flush();
    assert(!app.ui.composer.editor.isShowingAutocomplete());
    assert((await harness.snapshot(LiveDoc, conversation.id, context))?.run, "Closing completion must not abort work.");
    terminal.send("\x1b"); await until(() => !app.ui.busy);
    assert.equal(app.ui.composer.editor.getExpandedText(), "/rea");
  } finally { await app.close(); terminal.dispose(); }
});
