import { report, workerOutcome } from "./state.ts";
import { textPage, type TextPage } from "./pages.ts";
import { positiveInteger } from "./targets.ts";
import { resultView, type JobRecord, type ResultView, type WorkerRecord } from "./view.ts";

export type SubagentReportPage = Readonly<TextPage & {
  jobId: number; worker: number; status: "completed" | "failed" | "aborted";
  settled: boolean; historicallyTruncated: boolean; error?: string;
}>;
export function reportPage(job: JobRecord, workers: WorkerRecord[], worker: number, offset = 0, maxBytes = 24000): SubagentReportPage {
  positiveInteger(worker, "1-based worker number");
  if (worker > job.input.tasks.length) throw new Error("Invalid 1-based worker number.");
  const record = workers.find((value) => value.input.index === worker - 1);
  const result = resultView(job, workers).workers.find((value) => value.index === worker - 1)
    ?? (record && (record.state.status === "completing" || record.state.status === "terminal")
      ? workerOutcome(job.input, worker - 1, record.state.outcome, record.id) : undefined);
  if (!result) throw new Error("Worker report is not available yet; inspect the job rather than busy-polling.");
  return { jobId: job.id, worker, status: result.status, settled: record ? record.state.status === "terminal" : job.state.status === "terminal",
    historicallyTruncated: result.truncated, ...(result.error === undefined ? {} : { error: result.error }),
    ...textPage(result.report, offset, maxBytes) };
}
export function reportPageText(page: SubagentReportPage): string {
  return [`Subagent job ${page.jobId} / worker ${page.worker}: ${page.status}${page.settled ? "" : " · cleanup pending"}. These are delegated results, not independent verification.`,
    ...(page.error ? [textPage(page.error, 0, 2048, 32).text] : []),
    `Report UTF-8 bytes ${page.offset}–${page.nextOffset ?? page.totalBytes} of ${page.totalBytes}${page.historicallyTruncated ? " (historically truncated before saving)" : ""}:`,
    page.text,
    page.nextOffset === undefined ? "[End of saved report.]" : `Continue: agent_results(${JSON.stringify({ jobId: page.jobId, worker: page.worker, offset: page.nextOffset })})`,
  ].join("\n");
}
/** Preserve ordinary short reports, with a model-visible route to every full report when the overview is bounded. */
export function resultsText(view: ResultView, total: number): string {
  const prefix = view.status === "running" ? `Subagent job ${view.jobId} is running; ${view.workers.length} results ready. Control remains available through agent_stop.\n\n`
    : view.status === "completing" ? "Cleanup pending; this job is not fully settled.\n" : "";
  const page = textPage(prefix + report(view.jobId, view), 0, 32000, 1200);
  return page.text + (page.nextOffset === undefined ? "" : `\n[Overview shortened; full saved reports are unchanged. Read an exact worker with agent_results({\"jobId\":${view.jobId},\"worker\":N,\"offset\":0}), N=1..${total}. Continue using the returned byte offset.]`);
}
