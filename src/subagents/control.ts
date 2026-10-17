import type { Context } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc, type ConversationId, type Cursor, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { Control, JOB_KIND, Messages, Worker, WORKER_KIND, type JobResult, type MessageReceipt } from "./state.ts";
import { messageArguments, positiveInteger, stopArguments, type MessageArguments, type SubagentTarget } from "./targets.ts";
import { readJobRecord, readJobTables, type WorkerRecord } from "./view.ts";

export type SubagentAccess = Pick<Harness, "snapshot" | "commit"> & Partial<Pick<Harness, "resume" | "abortTask">>;
export type SubagentStopReceipt = Readonly<{ jobIds: readonly TaskId[]; worker?: number; status: "requested" }>;
export async function assertOrchestrator(access: Pick<Harness, "snapshot">, conversationId: ConversationId, context: Context) {
  positiveInteger(conversationId, "conversation ID");
  if ((await access.snapshot(Worker, conversationId, context))?.owner) throw new Error("Only the orchestrator may inspect, control or message subagents.");
}
/** Save native cancellation intent promptly. This does not join cleanup or undo previous effects. */
export async function requestSubagentStop(access: SubagentAccess, conversationId: ConversationId, target: Readonly<SubagentTarget>, context: Context): Promise<SubagentStopReceipt> {
  const args = stopArguments(target);
  await assertOrchestrator(access, conversationId, context);
  const { jobIds, nativeStops } = await access.commit(async (tx) => {
    const ids = new Set<TaskId<JobResult>>(args.jobId === undefined ? [] : [args.jobId as TaskId<JobResult>]);
    const accepted: TaskId[] = [], nativeStops: TaskId[] = [];
    // Select all live jobs in one native frame, including cleanup that has left or aged out of discovery indexes.
    if (args.jobId === undefined) for (const status of ["pending", "running", "waiting", "completing"] as const) {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanTasks({ conversationId, kind: JOB_KIND, status }, 128, cursor);
        for (const job of page.items) ids.add(job.id as TaskId<JobResult>);
        cursor = page.next;
      } while (cursor);
    }
    for (const jobId of ids) {
      const job = await readJobRecord(tx, conversationId, jobId);
      if (args.worker !== undefined && args.worker > job.input.tasks.length) throw new Error("Invalid 1-based worker number.");
      if (job.state.status === "terminal") continue;
      if (job.state.status === "completing") {
        const target = args.worker === undefined ? job : (await readJobTables(tx, conversationId, jobId)).workers.find((worker) => worker.input.index === args.worker! - 1);
        if (!target || target.state.status === "terminal") continue;
        // Failed/aborted native outcomes already cascade cancellation; only successful held outcomes need a new mark.
        const cancelling = job.abortRequested || job.state.outcome.status !== "completed" || target.abortRequested
          || (target.state.status === "completing" && target.state.outcome.status !== "completed");
        if (!cancelling) {
          if (target.state.status !== "completing" || typeof access.abortTask !== "function") throw new Error(`Cleanup is still pending. Use /agent-stop ${job.id} or a native Harness with abortTask() to cancel it.`);
          nativeStops.push(target.id);
        }
      }
      const control = await tx.doc(Control, job.id);
      if (args.worker === undefined) control.all = true;
      else if (!control.workers.includes(args.worker - 1)) control.workers.push(args.worker - 1);
      accepted.push(job.id);
    }
    return { jobIds: accepted, nativeStops };
  }, context);
  // Only completing targets reach abortTask(): save the native mark without waiting for owned cleanup. The SDK may
  // still join a finishing run invocation's tail. Never mutate private rows or abort an entire conversation for one worker.
  for (const taskId of nativeStops) await access.abortTask!(taskId, context);
  // A reopened Harness may have scheduling paused. Wake cleanup without granting host model readiness.
  // Model tool runtimes already run on that scheduler and need not provide resume().
  if (jobIds.length) access.resume?.();
  return { jobIds, ...(args.worker === undefined ? {} : { worker: args.worker }), status: "requested" };
}
/** Shared busy-only admission; caller saves its replay receipt in this same transaction. */
export async function queueWorkerMessage(tx: Tx, conversationId: ConversationId, input: MessageArguments, requestId: string): Promise<MessageReceipt> {
  const args = messageArguments(input), job = await readJobRecord(tx, conversationId, args.jobId as TaskId<JobResult>);
  if (args.worker > job.input.tasks.length) throw new Error("Invalid 1-based worker number.");
  if (job.abortRequested || job.state.status === "terminal" || job.state.status === "completing") throw new Error("Subagent job is no longer active.");
  const control = await tx.doc(Control, job.id), index = args.worker - 1;
  if (control.all || control.workers.includes(index)) throw new Error("Worker cancellation has been requested.");
  const workerId = job.state.checkpoint.workers[index], record = workerId === undefined ? undefined : await tx.task(workerId);
  if (!record || record.kind !== WORKER_KIND || ![1, 2, 3].includes(record.version) || record.owner !== job.id || record.conversationId !== conversationId) throw new Error("Worker has not started; no message was queued.");
  const worker = record as WorkerRecord;
  if (worker.abortRequested || worker.state.status === "terminal" || worker.state.status === "completing") throw new Error("Worker is no longer active.");
  if (worker.state.checkpoint.phase !== "run") throw new Error("Worker is not ready; no message was queued.");
  const childId = worker.state.checkpoint.conversationId, child = await tx.conversation(childId), metadata = await tx.doc(Worker, childId);
  if (child?.owner?.taskId !== worker.id || child.owner.conversationId !== conversationId
    || worker.input.jobId !== job.id || worker.input.index !== index || metadata.owner?.taskId !== worker.id
    || metadata.owner.jobId !== job.id || metadata.owner.index !== index) throw new Error("Worker ownership is inconsistent.");
  const existing = await tx.submissionByRequest(childId, requestId), initial = await tx.submissionByRequest(childId, `subagent:${worker.id}`);
  const live = await tx.doc(LiveDoc, childId), run = live.run === undefined ? undefined : await tx.task(live.run.taskId);
  const messages = await tx.doc(Messages, worker.id), inbox = await tx.doc(InboxDoc, childId);
  if (messages.closed || initial?.type !== "input" || initial.status === "unanswered" || !run || run.abortRequested || run.state.status === "terminal" || run.state.status === "completing") throw new Error("Worker is not accepting messages; no message was queued.");
  // Lifecycle/stop checks, native inbox admission and the caller's receipt share one commit.
  // A later Conversation.submit() could restart an idle/finished child. No custom queue or runner.
  const selectedMode = args.mode ?? "steer";
  const submission = existing ?? await tx.createSubmission({ conversationId: childId, requestId, type: "input", status: "queued" });
  if (!existing) inbox.items.push({ id: submission.id, mode: selectedMode, content: args.message });
  if (!messages.requests.includes(requestId)) messages.requests.push(requestId);
  return { jobId: job.id, worker: args.worker, conversationId: childId, requestId, submissionId: submission.id, mode: selectedMode, status: "queued" };
}
