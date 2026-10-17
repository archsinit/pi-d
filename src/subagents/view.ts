import type { Context } from "@earendil-works/chord/context";
import type { Harness, TaskId, TaskRecord, ConversationId, Cursor, Tx } from "@earendil-works/pi-durable";
import { JOB_KIND, WORKER_KIND, workerOutcome, type JobInput, type JobCheckpoint, type JobResult, type JobStatus, type WorkerInput, type WorkerCheckpoint, type WorkerResult } from "./state.ts";
import { positiveInteger } from "./targets.ts";

export type JobRecord = TaskRecord<JobInput, JobCheckpoint, JobResult>;
export type WorkerRecord = TaskRecord<WorkerInput, WorkerCheckpoint, WorkerResult>;
export async function readJobRecord(tx: Tx, conversationId: ConversationId, id: TaskId<JobResult>): Promise<JobRecord> {
  positiveInteger(conversationId, "conversation ID"); positiveInteger(id);
  const record = await tx.task(id);
  if (!record || record.kind !== JOB_KIND || ![1, 2, 3].includes(record.version) || record.conversationId !== conversationId) throw new Error("Subagent job not found in this conversation.");
  return record as JobRecord;
}
function ownedWorker(record: Awaited<ReturnType<Tx["task"]>>, job: JobRecord): record is WorkerRecord {
  if (!record || record.kind !== WORKER_KIND || ![1, 2, 3].includes(record.version) || record.owner !== job.id || record.conversationId !== job.conversationId) return false;
  const input = record.input as WorkerInput;
  return input.jobId === job.id && Number.isSafeInteger(input.index) && input.index >= 0 && input.index < job.input.tasks.length;
}
/** Table-only transaction: consistent task/ownership rows, without creating or migrating any documents. */
export async function readJobTables(tx: Tx, conversationId: ConversationId, id: TaskId<JobResult>) {
  const job = await readJobRecord(tx, conversationId, id);
  const decided = job.state.status === "terminal" || job.state.status === "completing";
  const ids = decided ? (job.state.outcome.result?.workers ?? []).flatMap((worker) => worker.taskId === undefined ? [] : [worker.taskId]) : job.state.checkpoint.workers;
  const workers = (await Promise.all(ids.map((taskId) => tx.task(taskId)))).filter((worker): worker is WorkerRecord => ownedWorker(worker, job));
  // Native faulted/orphaned outcomes have no application result/checkpoint. Ownership, not a new registry, recovers references.
  if (decided && !job.state.outcome.result) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({ conversationId, kind: WORKER_KIND }, 128, cursor);
      workers.push(...page.items.filter((worker): worker is WorkerRecord => ownedWorker(worker, job))); cursor = page.next;
    } while (cursor);
  }
  workers.sort((a, b) => a.input.index - b.input.index);
  const conversations = new Map<number, ConversationId>();
  for (const worker of workers) {
    const selected = worker.state.status === "terminal" || worker.state.status === "completing"
      ? worker.state.outcome.result?.conversationId : worker.state.checkpoint.phase === "prepare" ? undefined : worker.state.checkpoint.conversationId;
    if (selected !== undefined) {
      const child = await tx.conversation(selected);
      if (child?.owner?.taskId !== worker.id || child.owner.conversationId !== conversationId) throw new Error("Worker ownership is inconsistent.");
      conversations.set(worker.id, selected);
    } else {
      const page = await tx.scanConversations({ ownerTaskId: worker.id, ownerConversationId: conversationId }, 2);
      if (page.items.length > 1) throw new Error("Worker ownership is inconsistent.");
      if (page.items[0]) conversations.set(worker.id, page.items[0].id);
    }
  }
  return { job, workers, conversations };
}
export async function readJob(reader: Pick<Harness, "commit">, conversationId: ConversationId, id: TaskId<JobResult>, context: Context) {
  positiveInteger(conversationId, "conversation ID"); positiveInteger(id);
  return reader.commit((tx) => readJobTables(tx, conversationId, id), context);
}
export type ResultView = { jobId: TaskId<JobResult>; status: JobStatus; workers: WorkerResult[] };
export function resultView(job: JobRecord, workers: WorkerRecord[]): ResultView {
  const ready = () => workers.flatMap((worker) => worker.state.status === "terminal"
    ? [workerOutcome(job.input, worker.input.index, worker.state.outcome, worker.id)] : []);
  if (job.state.status === "terminal" || job.state.status === "completing") {
    const result = job.state.outcome.result ?? { status: job.state.outcome.status === "aborted" ? "aborted" as const : "failed" as const, workers: ready() };
    return { jobId: job.id, ...result, status: job.state.status === "completing" ? "completing" : result.status };
  }
  return { jobId: job.id, status: "running", workers: ready() };
}
export function id(value: string): TaskId<JobResult> {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Expected a positive native job ID.");
  return Number(value) as TaskId<JobResult>;
}
