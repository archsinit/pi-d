import { defineDoc, type ConversationId, type ModelRef, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const EXTENSION = "pi-d-subagents";
export const JOB_KIND = "pi-d.subagent-job";
export const WORKER_KIND = "pi-d.subagent-worker";

/** @deprecated Legacy wrapper options are accepted for compatibility but impose no limits. */
export type SubagentPolicy = {
  concurrency: number | null; maxTasks: number | null; timeoutMs: number | null;
  maxToolCalls: number | null; maxReportBytes: number | null;
};
/** @deprecated No extension-imposed worker budgets. Native provider/OS/output constraints still apply. */
export const DEFAULT_POLICY: Readonly<SubagentPolicy> = Object.freeze({
  concurrency: null, maxTasks: null, timeoutMs: null, maxToolCalls: null, maxReportBytes: null,
});

export type AssignedSkill = { name: string; filePath: string; content: string };
/** Admission-time selections and tool filters, not executable code or a registry-wide inheritance policy. */
export type Capabilities = { skills: AssignedSkill[]; extensions: string[]; tools: string[]; modelTools: string[]; modelCallable: string[]; callable: string[] };
export type Assignment = { name: string; task: string; role: string; capabilities?: Capabilities }; // Absent in v1/v2.
export type Profile = { model: ModelRef; thinkingLevel: ModelThinkingLevel; cwd: string; instructions: string };
export type JobInput = { tasks: Assignment[]; context: string; profile: Profile };
export type WorkerInput = { jobId: TaskId; index: number; assignment: Assignment; context: string; profile: Profile; legacy?: true };
export type WorkerResult = {
  index: number; name: string; status: "completed" | "failed" | "aborted";
  taskId?: TaskId<WorkerResult>; conversationId?: ConversationId; report: string; error?: string; truncated: boolean;
};
export type JobResult = { status: "completed" | "partial" | "failed" | "aborted"; workers: WorkerResult[] };
// Retain the version-1 wave fields so paused stores can recover without re-admitting assignments.
export type JobCheckpoint = {
  next: number; workers: TaskId<WorkerResult>[]; wave: TaskId<WorkerResult>[]; results: WorkerResult[];
} & ({ phase: "dispatch" } | { phase: "collect" } | { phase: "finish" });
export type WorkerCheckpoint = { phase: "prepare" } | { phase: "run"; conversationId: ConversationId } | { phase: "upgrade"; conversationId: ConversationId };

/** References only: native tasks, ownership, checkpoints and receipts remain execution authority. */
export const Jobs = defineDoc<{ recent: TaskId<JobResult>[]; active: TaskId<JobResult>[] }>({
  kind: "pi-d.subagents", version: 2, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ recent: [], active: [] }),
  migrate(value, fromVersion) {
    if (fromVersion !== 1) throw new Error("Unsupported subagent job-index version.");
    return { recent: (value.recent ?? []) as TaskId<JobResult>[], active: typeof value.active === "number" ? [value.active as TaskId<JobResult>] : [] };
  },
});
export const Call = defineDoc<{ jobId?: TaskId<JobResult> }>({
  kind: "pi-d.subagent-call", version: 1, scope: "task", initial: () => ({}),
});
export type MessageReceipt = {
  jobId: TaskId; worker: number; conversationId: ConversationId; requestId: string; submissionId: SubmissionId;
  mode: "steer" | "followUp"; status: "queued";
};
/** Immutable admission acknowledgement, saved atomically with the native inbox item. */
export const MessageCall = defineDoc<{ receipt?: MessageReceipt }>({
  kind: "pi-d.subagent-message-call", version: 1, scope: "task", initial: () => ({}),
});
/** Native request references and a completion gate only: message contents/queueing belong to pi.inbox. */
export const Messages = defineDoc<{ requests: string[]; closed: boolean }>({
  kind: "pi-d.subagent-messages", version: 1, scope: "task", initial: () => ({ requests: [], closed: false }),
});
/** Durable stop requests, observed by the job and its workers; not a replacement cancellation scheduler. */
export const Control = defineDoc<{ all: boolean; workers: number[] }>({
  kind: "pi-d.subagent-control", version: 1, scope: "task", initial: () => ({ all: false, workers: [] }),
});
export const Worker = defineDoc<{
  owner?: { jobId: TaskId; taskId: TaskId; index: number; root: string };
  capabilities?: Capabilities;
}>({ kind: "pi-d.subagent", version: 3, scope: "conversation", history: "latest", fork: "initial", initial: () => ({}),
  migrate(value, fromVersion) {
    if (fromVersion !== 1 && fromVersion !== 2) throw new Error("Unsupported subagent metadata version.");
    const owner = value.owner as { jobId: TaskId; taskId: TaskId; index: number; root: string } | undefined;
    return owner ? { owner: { jobId: owner.jobId, taskId: owner.taskId, index: owner.index, root: owner.root } } : {};
  },
});

/** UI preview only. Full worker reports are saved without an extension byte limit. */
export function bounded(text: string, maxBytes: number, side: "head" | "tail" = "head"): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const marker = side === "head" ? "\n[Preview truncated; full text remains in SQLite.]" : "[Earlier committed transcript omitted.]\n";
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker));
  if (side === "tail") {
    let start = bytes.length - available;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return { text: marker + bytes.subarray(start).toString("utf8"), truncated: true };
  }
  let end = available;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8") + marker, truncated: true };
}
export function jobResult(workers: WorkerResult[]): JobResult {
  const completed = workers.filter((worker) => worker.status === "completed").length;
  return { status: completed === workers.length ? "completed" : completed ? "partial" : workers.every((worker) => worker.status === "aborted") ? "aborted" : "failed", workers };
}
export function report(jobId: TaskId, result: JobResult): string {
  return [`Subagent job ${jobId}: ${result.status}. These are delegated results, not independent verification.`,
    ...result.workers.map((worker) => `\n${worker.index + 1}. ${worker.name} — ${worker.status}${worker.conversationId ? ` (conversation ${worker.conversationId})` : ""}\n${worker.error ?? worker.report}`),
  ].join("\n");
}
