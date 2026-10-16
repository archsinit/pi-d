import type { Context } from "@earendil-works/chord/context";
import type { Harness, TaskId, TaskRecord, ConversationId } from "@earendil-works/pi-durable";
import { JOB_KIND, WORKER_KIND, type JobInput, type JobCheckpoint, type JobResult, type WorkerInput, type WorkerCheckpoint, type WorkerResult } from "./state.ts";

type Reader = Pick<Harness, "getTask">;
export type JobRecord = TaskRecord<JobInput, JobCheckpoint, JobResult>;
export type WorkerRecord = TaskRecord<WorkerInput, WorkerCheckpoint, WorkerResult>;
export async function readJob(reader: Reader, conversationId: ConversationId, id: TaskId<JobResult>, context: Context) {
  const record = await reader.getTask(id, context);
  if (!record || record.kind !== JOB_KIND || (record.version !== 1 && record.version !== 2 && record.version !== 3) || record.conversationId !== conversationId) throw new Error("Subagent job not found in this conversation.");
  const job = record as JobRecord;
  const ids = job.state.status === "terminal" || job.state.status === "completing"
    ? (job.state.outcome.result?.workers ?? []).flatMap((worker) => worker.taskId === undefined ? [] : [worker.taskId])
    : job.state.checkpoint.workers;
  const workers = (await Promise.all(ids.map((taskId) => reader.getTask(taskId, context))))
    .filter((worker): worker is WorkerRecord => worker !== undefined && worker.kind === WORKER_KIND && (worker.version === 1 || worker.version === 2 || worker.version === 3) && worker.owner === id) as WorkerRecord[];
  return { job, workers };
}
export function resultView(job: JobRecord, workers: WorkerRecord[]): { jobId: TaskId<JobResult>; status: JobResult["status"] | "running"; workers: WorkerResult[] } {
  if (job.state.status === "terminal" || job.state.status === "completing") {
    return { jobId: job.id, ...(job.state.outcome.result ?? { status: job.state.outcome.status === "aborted" ? "aborted" : "failed", workers: [] }) };
  }
  return { jobId: job.id, status: "running", workers: workers.flatMap((worker) =>
    worker.state.status === "terminal" && worker.state.outcome.result ? [worker.state.outcome.result] : []) };
}
export function id(value: string): TaskId<JobResult> {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Expected a positive native job ID.");
  return Number(value) as TaskId<JobResult>;
}
