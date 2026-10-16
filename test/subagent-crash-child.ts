// Test-only crash probe: a parent test owns this process and always joins it before deleting its temporary store.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createSubagentsExtension } from "../src/subagents/index.ts";
import { model, testModels } from "./models.ts";
import { gate, workerName } from "./subagent-fixtures.ts";

const [file, cwd] = process.argv.slice(2);
const reached = Promise.withResolvers<void>();
const { models } = testModels({ responses: Array.from({ length: 20 }, () => async (transcript, options) => {
  if (workerName(transcript)) { reached.resolve(); await gate(new Promise<void>(() => {}), options?.signal); return fauxAssistantMessage("Unreachable."); }
  return transcript.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage("Background acknowledged.")
    : fauxAssistantMessage(fauxToolCall("delegate", { tasks: [{ name: "Crash probe", task: "Continue after process death." }], background: true }), { stopReason: "toolUse" });
}) });
const registry = createRegistry(); registry.install(createSubagentsExtension());
const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, context);
process.stdin.resume();
try {
  const root = await harness.root(context, { agent: { model, cwd } });
  const input = await root.submit({ type: "input", content: "Start crash probe." }, context); await input.wait(context); await reached.promise;
  console.log("WORKER-READY");
  await new Promise<void>((resolve) => process.once("SIGTERM", resolve));
} finally { await harness.close(context); process.stdin.pause(); }
