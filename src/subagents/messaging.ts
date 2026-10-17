import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { MessageCall, type MessageReceipt } from "./state.ts";
import { messageArguments } from "./targets.ts";
import { assertOrchestrator, queueWorkerMessage } from "./control.ts";

const nativeId = () => Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const mode = Type.Union([Type.Literal("steer"), Type.Literal("followUp")]);
export const messageTool = defineTool({
  name: "agent_message", callers: ["model"], replay: "safe", executionMode: "sequential",
  description: "Queue a message for one active worker in this conversation's job, using its 1-based worker number. Default mode steer joins at a native boundary; followUp waits for a final boundary. Returns promptly after durable queue admission, NOT after consumption, obedience or completion. Does not interrupt in-flight tools/provider work or restart starting, stopped or settled workers. Use agent_stop for cancellation and agent_results for results; do not busy-poll.",
  parameters: Type.Object({ jobId: nativeId(), worker: nativeId(), message: Type.String({ minLength: 1 }), mode: Type.Optional(mode) }),
  structuredOutputSchema: Type.Object({ jobId: nativeId(), worker: nativeId(), conversationId: nativeId(), requestId: Type.String(),
    submissionId: nativeId(), mode, status: Type.Literal("queued") }),
  prepareArguments: messageArguments,
  async execute(args, api, context) {
    await assertOrchestrator(api, api.conversationId, context);
    const receipt = await api.commit(async (tx): Promise<MessageReceipt> => {
      const call = await tx.doc(MessageCall, api.taskId);
      if (call.receipt) return { ...call.receipt }; // Replay admission, not a fresh delivery-state claim.
      const receipt = await queueWorkerMessage(tx, api.conversationId, args, `subagent-message:${api.taskId}`);
      call.receipt = receipt; return receipt;
    }, context);
    return { output: [{ type: "text", text: `Message ${receipt.submissionId} queued for job ${receipt.jobId} / worker ${receipt.worker} (${receipt.mode}). Admission acknowledged only: the worker may not have consumed it and cancellation/failure can leave it unanswered. In-flight work is not forcibly interrupted. This receipt is reused on replay; agent_results reports worker settlement.` }],
      structuredOutput: receipt, details: receipt };
  },
});
