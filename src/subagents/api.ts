import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { defineDocFamily, type ConversationId, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import { assertOrchestrator, queueWorkerMessage, type SubagentAccess } from "./control.ts";
import { EXTENSION, Jobs, Control, workerOutcome, type JobResult, type MessageReceipt } from "./state.ts";
import { argumentsObject, messageArguments, positiveInteger, resultsArguments } from "./targets.ts";
import { reportPage, type SubagentReportPage } from "./results.ts";
import { readJob, resultView } from "./view.ts";

export { requestSubagentStop, type SubagentAccess, type SubagentStopReceipt } from "./control.ts";
export type { SubagentReportPage } from "./results.ts";
export type SubagentTaskState = "pending" | "running" | "waiting" | "completing" | "terminal";
export type SubagentOutcome = "completed" | "failed" | "aborted" | "faulted" | "orphaned";
export type SubagentStatus = "running" | "completing" | "completed" | "partial" | "failed" | "aborted";
export type SubagentWorkerSnapshot = Readonly<{
  worker: number; name: string; role: string; task: string; taskId?: TaskId; conversationId?: ConversationId;
  state: SubagentTaskState | "notStarted"; settled: boolean; stopRequested: boolean;
  outcome?: "completed" | "failed" | "aborted"; nativeOutcome?: SubagentOutcome;
  reportAvailable: boolean; reportBytes?: number; historicallyTruncated?: boolean; error?: string;
  startedAt?: number; endedAt?: number;
  capabilities?: Readonly<{ skills: readonly string[]; extensions: readonly string[]; tools: readonly string[];
    modelTools: readonly string[]; callable: readonly string[]; modelCallable: readonly string[] }>;
}>;
export type SubagentJobSnapshot = Readonly<{
  jobId: TaskId; conversationId: ConversationId; state: SubagentTaskState; status: SubagentStatus;
  settled: boolean; stopRequested: boolean; outcome?: "completed" | "partial" | "failed" | "aborted"; nativeOutcome?: SubagentOutcome; background: boolean;
  model: Readonly<{ provider: string; modelId: string }>; startedAt?: number; endedAt?: number;
  totalWorkers: number; resultsReady: number; settledWorkers: number; workers: readonly SubagentWorkerSnapshot[];
}>;
export type SubagentJobSummary = Omit<SubagentJobSnapshot, "workers">;
export type SubagentReportRequest = Readonly<{ jobId: number; worker: number; offset?: number; maxBytes?: number }>;
export type SubagentMessageRequest = Readonly<{ jobId: number; worker: number; message: string; mode?: "steer" | "followUp"; requestId: string }>;
export type SubagentMessageReceipt = Readonly<{ jobId: TaskId; worker: number; conversationId: ConversationId;
  requestId: string; submissionId: SubmissionId; mode: "steer" | "followUp"; status: "queued" }>;

/** Detached report-free snapshot. Task/ownership rows share a read-only transaction; stop intent is a separate committed read. */
export async function inspectSubagentJob(access: SubagentAccess, conversationId: ConversationId, jobId: number, context: Context): Promise<SubagentJobSnapshot> {
  positiveInteger(jobId); await assertOrchestrator(access, conversationId, context);
  const { job, workers, conversations } = await readJob(access, conversationId, jobId as TaskId<JobResult>, context);
  const control = await access.snapshot(Control, job.id, context), view = resultView(job, workers);
  const rows: SubagentWorkerSnapshot[] = job.input.tasks.map((assignment, index) => {
    const worker = workers.find((value) => value.input.index === index);
    const decided = worker && (worker.state.status === "terminal" || worker.state.status === "completing") ? worker.state.outcome : undefined;
    const result = view.workers.find((value) => value.index === index) ?? (decided ? workerOutcome(job.input, index, decided, worker!.id) : undefined);
    const capabilities = assignment.capabilities;
    return { worker: index + 1, name: assignment.name, role: assignment.role, task: assignment.task,
      ...(worker ? { taskId: worker.id } : {}),
      ...(worker && conversations.has(worker.id) ? { conversationId: conversations.get(worker.id)! } : result?.conversationId === undefined ? {} : { conversationId: result.conversationId }),
      state: worker?.state.status ?? "notStarted", settled: worker ? worker.state.status === "terminal" : job.state.status === "terminal",
      stopRequested: !!(job.abortRequested || worker?.abortRequested || control?.all || control?.workers.includes(index)),
      ...(decided ? { nativeOutcome: decided.status } : {}), reportAvailable: !!result,
      ...(result ? { outcome: result.status, reportBytes: Buffer.byteLength(result.report), historicallyTruncated: result.truncated,
        ...(result.error === undefined ? {} : { error: result.error }) } : {}),
      ...(worker?.startedAt === undefined ? {} : { startedAt: worker.startedAt }), ...(worker?.endedAt === undefined ? {} : { endedAt: worker.endedAt }),
      ...(capabilities ? { capabilities: { skills: capabilities.skills.map((skill) => skill.name), extensions: [...capabilities.extensions],
        tools: [...capabilities.tools], modelTools: [...capabilities.modelTools], callable: [...capabilities.callable], modelCallable: [...capabilities.modelCallable] } } : {}),
    };
  });
  return { jobId: job.id, conversationId, state: job.state.status, status: view.status, settled: job.state.status === "terminal",
    stopRequested: !!(job.abortRequested || control?.all), background: job.background, model: { ...job.input.profile.model },
    ...(job.state.status === "terminal" || job.state.status === "completing" ? { nativeOutcome: job.state.outcome.status,
      outcome: job.state.outcome.result?.status ?? (job.state.outcome.status === "aborted" ? "aborted" as const : "failed" as const) } : {}),
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }), ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
    totalWorkers: rows.length, resultsReady: rows.filter((row) => row.reportAvailable).length, settledWorkers: rows.filter((row) => row.settled).length, workers: rows };
}
/** All indexed active jobs plus retained recent jobs, newest first. This is not an atomic cross-job snapshot or an archive scan. */
export async function listSubagentJobs(access: SubagentAccess, conversationId: ConversationId, context: Context): Promise<readonly SubagentJobSummary[]> {
  await assertOrchestrator(access, conversationId, context);
  const jobs = await access.snapshot(Jobs, conversationId, context), ids = [...new Set([...(jobs?.active ?? []), ...(jobs?.recent ?? [])])].toSorted((a, b) => b - a);
  return Promise.all(ids.map(async (jobId) => { const { workers: _workers, ...summary } = await inspectSubagentJob(access, conversationId, jobId, context); return summary; }));
}
export async function readSubagentReportPage(access: SubagentAccess, conversationId: ConversationId, request: SubagentReportRequest, context: Context): Promise<SubagentReportPage> {
  const args = resultsArguments(request), jobId = positiveInteger(args.jobId), worker = positiveInteger(args.worker, "1-based worker number");
  await assertOrchestrator(access, conversationId, context);
  const current = await readJob(access, conversationId, jobId as TaskId<JobResult>, context);
  return reportPage(current.job, current.workers, worker, args.offset, args.maxBytes);
}

const Admissions = defineDocFamily<{ fingerprint?: string; receipt?: MessageReceipt }, null>({
  kind: `${EXTENSION}.api-message-admission`, version: 1, family: true, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}),
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Caller identity is conversation-scoped and durable for its lifetime. Replays return admission, never current delivery state. */
export async function admitSubagentMessage(access: SubagentAccess, conversationId: ConversationId, request: SubagentMessageRequest, context: Context): Promise<SubagentMessageReceipt> {
  const input = argumentsObject(request), args = messageArguments(request);
  if (typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 256) throw new Error("Supply a stable, non-blank requestId of at most 256 characters; never reuse it for another action.");
  await assertOrchestrator(access, conversationId, context);
  const key = hash(JSON.stringify(input.requestId)), fingerprint = hash(JSON.stringify([conversationId, args.jobId, args.worker, args.mode ?? "steer", args.message]));
  return access.commit(async (tx) => {
    const saved = await tx.doc(Admissions, conversationId, key, null);
    if (saved.receipt) {
      if (saved.fingerprint !== fingerprint) throw new Error("Message requestId was already used for a different target, mode or message.");
      return { ...saved.receipt };
    }
    const receipt = await queueWorkerMessage(tx, conversationId, args, `subagent-api-message:${conversationId}:${key}`);
    saved.fingerprint = fingerprint; saved.receipt = receipt;
    return receipt;
  }, context);
}
