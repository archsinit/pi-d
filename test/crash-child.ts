import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { openPersistentChat } from "../src/session.ts";
import { lockLost, model, testModels } from "./models.ts";

const context = BACKGROUND_CONTEXT;
const { models } = testModels({ tokensPerSecond: 25, responses: [fauxAssistantMessage("Committed partial. ".repeat(200))] });
const chat = await openPersistentChat(process.argv[2], models, { model, onLockLost: lockLost });
const watch = await chat.harness.watchDoc(LiveDoc, chat.conversation.id, context);
let notified = false;
watch!.start(async (live) => {
  if (!notified && live?.generation?.message?.content.some((part) => part.type === "text" && part.text.length > 0)) {
    notified = true; console.log("PARTIAL");
  }
});
const input = await chat.conversation.submit({ type: "input", content: "Interrupted input." }, context);
console.log(`INPUT ${input.id}`);
await input.wait(context);
await chat.close();
