/** Validate raw arguments before Durable/TypeBox can coerce IDs into different targets. */
export function argumentsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected subagent arguments.");
  return value as Record<string, unknown>;
}
export function positiveInteger(value: unknown, label = "native job ID"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Expected a positive safe-integer ${label}.`);
  return value;
}
export type SubagentTarget = { jobId?: number; worker?: number };
export function targetArguments(value: unknown): SubagentTarget {
  const args = argumentsObject(value);
  const jobId = args.jobId === undefined ? undefined : positiveInteger(args.jobId);
  const worker = args.worker === undefined ? undefined : positiveInteger(args.worker, "1-based worker number");
  if (worker !== undefined && jobId === undefined) throw new Error("Specify jobId when selecting one worker.");
  return { ...(jobId === undefined ? {} : { jobId }), ...(worker === undefined ? {} : { worker }) };
}
export type MessageArguments = { jobId: number; worker: number; message: string; mode?: "steer" | "followUp" };
export function messageArguments(value: unknown): MessageArguments {
  const args = argumentsObject(value), target = targetArguments(value);
  const jobId = positiveInteger(target.jobId), worker = positiveInteger(target.worker, "1-based worker number");
  if (typeof args.message !== "string" || !args.message.trim()) throw new Error("Worker messages must be non-blank strings.");
  if (args.mode !== undefined && args.mode !== "steer" && args.mode !== "followUp") throw new Error("Message mode must be steer or followUp.");
  return { jobId, worker, message: args.message, ...(args.mode === undefined ? {} : { mode: args.mode }) };
}
export function stopArguments(value: unknown): SubagentTarget {
  const args = argumentsObject(value);
  if (Object.keys(args).some((key) => key !== "jobId" && key !== "worker")) throw new Error("Unknown stop argument; use jobId and optional worker, or an empty object for all active jobs.");
  return targetArguments(value);
}
export type ResultsArguments = SubagentTarget & { offset?: number; maxBytes?: number; beforeJobId?: number };
export function resultsArguments(value: unknown): ResultsArguments {
  const args = argumentsObject(value), target = targetArguments(value);
  const result: ResultsArguments = { ...target };
  if (args.offset !== undefined) {
    if (typeof args.offset !== "number" || !Number.isSafeInteger(args.offset) || args.offset < 0) throw new Error("Expected a non-negative safe-integer UTF-8 byte offset.");
    if (target.worker === undefined) throw new Error("Report offsets require jobId and worker.");
    result.offset = args.offset;
  }
  if (args.maxBytes !== undefined) {
    if (typeof args.maxBytes !== "number" || !Number.isSafeInteger(args.maxBytes) || args.maxBytes < 4 || args.maxBytes > 32000) throw new Error("Expected maxBytes between 4 and 32000.");
    if (target.worker === undefined) throw new Error("Report page sizes require jobId and worker.");
    result.maxBytes = args.maxBytes;
  }
  if (args.beforeJobId !== undefined) {
    if (target.jobId !== undefined) throw new Error("beforeJobId is only for listing jobs.");
    result.beforeJobId = positiveInteger(args.beforeJobId);
  }
  return result;
}
