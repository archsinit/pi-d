import { Type } from "@earendil-works/pi-ai";
import { defineTool, InboxDoc, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { Control, JOB_KIND, MessageCall, Messages, Worker, WORKER_KIND, type MessageReceipt } from "./state.ts";
import type { JobRecord, WorkerRecord } from "./view.ts";

const nativeId = () => Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const mode = Type.Union([Type.Literal("steer"), Type.Literal("followUp")]);
export const messageTool = defineTool({
  name: "agent_message", callers: ["model"], replay: "safe", executionMode: "sequential",
  description: "Queue a message for one active worker in this conversation's job, using its 1-based worker number. Default mode steer joins at a native boundary; followUp waits for a final boundary. Returns promptly after durable queue admission, NOT after consumption, obedience or completion. Does not interrupt in-flight tools/provider work or restart starting, stopped or settled workers. Use agent_stop for cancellation and agent_results for results; do not busy-poll.",
  parameters: Type.Object({ jobId: nativeId(), worker: nativeId(), message: Type.String({ minLength: 1 }), mode: Type.Optional(mode) }),
  structuredOutputSchema: Type.Object({ jobId: nativeId(), worker: nativeId(), conversationId: nativeId(), requestId: Type.String(),
    submissionId: nativeId(), mode, status: Type.Literal("queued") }),
  prepareArguments(value): { jobId: number; worker: number; message: string; mode?: "steer" | "followUp" } {
    // Native schema validation coerces integers (e.g. 1.5 to 1). Never silently retarget a message.
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected worker message arguments.");
    const args = value as Record<string, unknown>;
    if (typeof args.jobId !== "number" || !Number.isSafeInteger(args.jobId) || args.jobId < 1
      || typeof args.worker !== "number" || !Number.isSafeInteger(args.worker) || args.worker < 1) throw new Error("Expected a positive native job ID and 1-based integer worker number.");
    if (typeof args.message !== "string") throw new Error("Expected a worker message string.");
    if (args.mode !== undefined && args.mode !== "steer" && args.mode !== "followUp") throw new Error("Message mode must be steer or followUp.");
    return { jobId: args.jobId, worker: args.worker, message: args.message, ...(args.mode === undefined ? {} : { mode: args.mode }) };
  },
  async execute(args, api, context) {
    if ((await api.snapshot(Worker, api.conversationId, context))?.owner) throw new Error("Only the orchestrator may message subagents.");
    if (!args.message.trim()) throw new Error("Worker messages must not be blank.");
    const receipt = await api.commit(async (tx): Promise<MessageReceipt> => {
      const call = await tx.doc(MessageCall, api.taskId);
      if (call.receipt) return { ...call.receipt }; // Detach the draft; admission receipt, not a fresh delivery-state claim.
      const raw = await tx.task(args.jobId as TaskId);
      if (!raw || raw.kind !== JOB_KIND || ![1, 2, 3].includes(raw.version) || raw.conversationId !== api.conversationId) throw new Error("Subagent job not found in this conversation.");
      const job = raw as JobRecord;
      if (args.worker > job.input.tasks.length) throw new Error("Invalid 1-based worker number.");
      if (job.abortRequested || job.state.status === "terminal" || job.state.status === "completing") throw new Error("Subagent job is no longer active.");
      const control = await tx.doc(Control, job.id), index = args.worker - 1;
      if (control.all || control.workers.includes(index)) throw new Error("Worker cancellation has been requested.");
      const workerId = job.state.checkpoint.workers[index], record = workerId === undefined ? undefined : await tx.task(workerId);
      if (!record || record.kind !== WORKER_KIND || ![1, 2, 3].includes(record.version) || record.owner !== job.id || record.conversationId !== api.conversationId) throw new Error("Worker has not started; no message was queued.");
      const worker = record as WorkerRecord;
      if (worker.abortRequested || worker.state.status === "terminal" || worker.state.status === "completing") throw new Error("Worker is no longer active.");
      if (worker.state.checkpoint.phase !== "run") throw new Error("Worker is not ready; no message was queued.");
      const conversationId = worker.state.checkpoint.conversationId, child = await tx.conversation(conversationId), metadata = await tx.doc(Worker, conversationId);
      if (child?.owner?.taskId !== worker.id || child.owner.conversationId !== api.conversationId
        || worker.input.jobId !== job.id || worker.input.index !== index || metadata.owner?.taskId !== worker.id
        || metadata.owner.jobId !== job.id || metadata.owner.index !== index) throw new Error("Worker ownership is inconsistent.");
      const requestId = `subagent-message:${api.taskId}`, existing = await tx.submissionByRequest(conversationId, requestId);
      const initial = await tx.submissionByRequest(conversationId, `subagent:${worker.id}`);
      const live = await tx.doc(LiveDoc, conversationId), run = live.run === undefined ? undefined : await tx.task(live.run.taskId);
      const messages = await tx.doc(Messages, worker.id), inbox = await tx.doc(InboxDoc, conversationId);
      if (messages.closed || initial?.type !== "input" || initial.status === "unanswered" || !run || run.abortRequested || run.state.status === "terminal" || run.state.status === "completing") throw new Error("Worker is not accepting messages; no message was queued.");
      // Busy-only native admission. The lifecycle/stop checks and pi.inbox append must share one commit:
      // Conversation.submit() in a later commit could restart an idle/finished child. No custom queue or runner.
      // All table reads precede createSubmission(); Durable places/settles this input at its normal boundaries.
      const selectedMode = args.mode ?? "steer";
      const submission = existing ?? await tx.createSubmission({ conversationId, requestId, type: "input", status: "queued" });
      if (!existing) inbox.items.push({ id: submission.id, mode: selectedMode, content: args.message });
      if (!messages.requests.includes(requestId)) messages.requests.push(requestId);
      const receipt: MessageReceipt = { jobId: job.id, worker: args.worker, conversationId, requestId, submissionId: submission.id, mode: selectedMode, status: "queued" };
      call.receipt = receipt; return receipt;
    }, context);
    return { output: [{ type: "text", text: `Message ${receipt.submissionId} queued for job ${receipt.jobId} / worker ${receipt.worker} (${receipt.mode}). Admission acknowledged only: the worker may not have consumed it and cancellation/failure can leave it unanswered. In-flight work is not forcibly interrupted. This receipt is reused on replay; agent_results reports worker settlement.` }],
      structuredOutput: receipt, details: receipt };
  },
});
