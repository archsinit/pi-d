import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

export const demoAnswer = `## Small surface. Real engine.

The interface is only the window. **Durable keeps the thread.**

- Every answer streams from committed state.
- Execution, cancellation and recovery belong to the stock Harness.
- No compatibility layer. No second agent loop.

\`\`\`typescript
const input = await conversation.submit(
  { type: "input", content: "Hello." },
  context,
);
await input.wait(context);
\`\`\`

The frame takes its cues from **btop**: quiet lines, embedded titles, colored shortcuts, and a little movement when something is alive.

> This is an offline design demo, not a live model.`;

export async function openDemo(tokensPerSecond = 90) {
  const faux = fauxProvider({ tokensPerSecond });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), {
    models, registry: createRegistry(), settings: { progress: { partialIntervalMs: 200 } },
  }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const answer = () => faux.appendResponses([fauxAssistantMessage(demoAnswer)]);
  return { harness, conversation, models, answer, beforeSubmit: answer, label: "demo · ephemeral", close: () => harness.close(BACKGROUND_CONTEXT) };
}
