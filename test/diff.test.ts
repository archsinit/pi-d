import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { codingEnv } from "../src/coding.ts";
import { openPersistentChat } from "../src/session.ts";
import { Transcript } from "../src/transcript.ts";
import { lockLost, model, testModels } from "./models.ts";

const context = BACKGROUND_CONTEXT;

test("successful stock edits render their committed unified patch, including color, narrow reflow and SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-edit-patch-")), file = join(directory, "session.sqlite");
  await writeFile(join(directory, "sample.ts"), "// heading\nconst value = 1;\n// tail\n");
  const registry = createRegistry(); registry.install(CodingTools);
  const { models } = testModels({ responses: [
    fauxAssistantMessage(fauxToolCall("edit", { path: "sample.ts", edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Edit complete."),
  ] });
  let chat = await openPersistentChat(file, models, { model, registry, env: codingEnv, defaultCwd: directory, onLockLost: lockLost });
  const transcript = new Transcript();
  const render = async () => {
    const state = await chat.conversation.viewState(context); transcript.view = state.value; state.dispose();
    for (const width of [36, 76, 156]) {
      const rows = transcript.render(width), text = rows.map(stripTerminalSequences).join("\n");
      for (const value of ["--- sample.ts", "+++ sample.ts", "@@", "-const value = 1;", "+const value = 2;"]) assert(text.includes(value), value);
      assert(rows.every((row) => visibleWidth(row) <= width));
      assert.equal((text.match(/--- sample.ts/g) ?? []).length, 1);
      const removed = rows.find((row) => stripTerminalSequences(row).includes("-const value = 1;"));
      const added = rows.find((row) => stripTerminalSequences(row).includes("+const value = 2;"));
      assert(removed?.includes("\x1b[38;")); assert(added?.includes("\x1b[38;"));
    }
  };
  try {
    const input = await chat.conversation.submit({ type: "input", content: "Update the sample." }, context); assert.equal((await input.wait(context)).status, "done");
    assert.match(await readFile(join(directory, "sample.ts"), "utf8"), /value = 2/);
    await render(); await chat.close();
    chat = await openPersistentChat(file, models, { registry, env: codingEnv, onLockLost: lockLost }); await render();
    const messages = (await chat.conversation.context(context)).messages;
    assert(!JSON.stringify(messages).includes("↳ Tool result"), "Display styling never enters model context.");
  } finally { await chat.close(); await rm(directory, { recursive: true, force: true }); }
});

test("patch display filters malformed details, failures and non-edit tools and strips terminal controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-d-patch-filter-"));
  const { models } = testModels();
  const chat = await openPersistentChat(join(directory, "session.sqlite"), models, { model, onLockLost: lockLost });
  try {
    const cases: Pick<ToolResultMessage, "toolName" | "isError" | "details">[] = [
      { toolName: "edit", isError: false, details: { patch: "--- sample\n+++ sample\n+VISIBLE-PATCH\x1b[2J\x1b]52;c;clipboard\x07" } },
      { toolName: "edit", isError: true, details: { patch: "+FAILED-PATCH-MUST-NOT-RENDER" } },
      { toolName: "other", isError: false, details: { patch: "+OTHER-PATCH-MUST-NOT-RENDER" } },
      { toolName: "edit", isError: false, details: { patch: 5, diff: ["BAD-PATCH-MUST-NOT-RENDER"] } },
    ];
    for (const [index, data] of cases.entries()) {
      await chat.conversation.submit({ type: "write", entry: { kind: "test.result", model: [{ role: "toolResult", toolCallId: `call-${index}`, content: [{ type: "text", text: "Result." }], timestamp: Date.now(), ...data }] } }, context);
    }
    const transcript = new Transcript(), state = await chat.conversation.viewState(context);
    transcript.view = state.value; state.dispose();
    const rows = transcript.render(80), text = rows.map(stripTerminalSequences).join("\n");
    assert.match(text, /VISIBLE-PATCH/);
    for (const value of ["FAILED-PATCH", "OTHER-PATCH", "BAD-PATCH", "clipboard"]) assert(!text.includes(value), value);
    assert(rows.every((row) => !row.includes("\x1b[2J") && !row.includes("\x1b]52")));
  } finally { await chat.close(); await rm(directory, { recursive: true, force: true }); }
});
