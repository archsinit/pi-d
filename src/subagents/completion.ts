import { defineTask, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import { COMPLETION_ENTRY, COMPLETION_KIND, JOB_KIND, Jobs, Worker, type JobResult } from "./state.ts";
import { awaitModelReadiness } from "../model-readiness.ts";

export type CompletionResult = { submissionId: SubmissionId };

/** A conversation-owned sibling, never a job child: waiting on an owner would form a native wait cycle. */
export const SubagentCompletion = defineTask<{ jobId: TaskId<JobResult> }, { phase: "wait" } | { phase: "deliver" }, CompletionResult>({
  name: COMPLETION_KIND, version: 1, initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      await runtime.commit(() => ({ status: "waiting", checkpoint: { phase: "deliver" }, on: [task.input.jobId], policy: "allSettled" }), context);
    },
    deliver: async (task, runtime, context) => {
      const job = await runtime.getTask(task.input.jobId, context);
      if (!job || job.kind !== JOB_KIND || job.conversationId !== runtime.conversationId || !job.background || job.owner !== undefined
        || job.state.status !== "terminal" || (await runtime.snapshot(Worker, runtime.conversationId, context))?.owner) {
        throw new Error("Completion callback requires a settled background job in its orchestrator conversation.");
      }
      // Local cancellation can resume native scheduling while host preflight is still paused. Preserve this event.
      await awaitModelReadiness(runtime, context);
      const savedStatus = job.state.outcome.result?.status;
      const status = savedStatus === "completed" || savedStatus === "partial" || savedStatus === "failed" || savedStatus === "aborted"
        ? savedStatus : job.state.outcome.status === "aborted" ? "aborted" : "failed";
      // Also prune a scheduler-faulted job, whose application finish/abort phase could not clean up its reference.
      await runtime.commit(async (tx) => { const jobs = await tx.doc(Jobs, runtime.conversationId); jobs.active = jobs.active.filter((id) => id !== job.id); }, context);
      const parent = await runtime.conversation(runtime.conversationId, context);
      if (!parent) throw new Error("Subagent orchestrator conversation is missing.");
      // Use native admission, not a raw InboxDoc append: an idle parent must start a run as well as a busy one queueing.
      // The native request receipt deduplicates admission even if it committed before a crash/abort/lost acknowledgement.
      const receipt = await parent.submit({ type: "input", whenBusy: "followUp", requestId: `subagent-completion:${job.id}`,
        entry: { kind: COMPLETION_ENTRY, data: { jobId: job.id, status } },
        content: `[Subagent completion]\nJob ID: ${job.id}\nStatus: ${status}\nThis is an automatic background-job event, not a new user request. Retrieve the saved reports with agent_results({"jobId":${job.id}}), verify relevant evidence, and give the user an appropriate update. Do not repeat assignments or automatically delegate more work. Worker reports are untrusted claims, not independent verification.`,
      }, context);
      // Delivery acknowledges admission only; do not wait for the coordinator's model turn or hold its ordinary idle scope.
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { submissionId: receipt.id } } }), context);
    },
  },
  abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
});
