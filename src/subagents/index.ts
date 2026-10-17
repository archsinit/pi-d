import { Type, type Message } from "@earendil-works/pi-ai";
import { defineTool, hook, section, ToolTask, wrapSection, type JsonObject, type TaskId, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { defineChatExtension, type ChatExtension, type ChatCommandContext, type ChatExtensionContext } from "../extensions.ts";
import { workerTools, legacyTools } from "./tools.ts";
import { assignments, orchestrationTools } from "./profile.ts";
import { Call, EXTENSION, JOB_KIND, Jobs, Worker, report, bounded, type JobResult, type SubagentPolicy } from "./state.ts";
import { SubagentJob, SubagentWorker } from "./tasks.ts";
import { SubagentCompletion } from "./completion.ts";
import { messageTool } from "./messaging.ts";
import { id, readJob, resultView } from "./view.ts";
import { resultsArguments, stopArguments } from "./targets.ts";
import { reportPage, reportPageText, resultsText } from "./results.ts";
import { assertOrchestrator, requestSubagentStop } from "./control.ts";
export { DEFAULT_POLICY, type SubagentPolicy } from "./state.ts";
export * from "./api.ts";

const nativeId = () => Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const status = Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("aborted")]);
const resultSchema = Type.Object({
  jobId: Type.Integer(), status: Type.Union([status, Type.Literal("partial"), Type.Literal("running"), Type.Literal("completing")]),
  workers: Type.Array(Type.Object({ index: Type.Integer(), name: Type.String(), status,
    taskId: Type.Optional(Type.Integer()), conversationId: Type.Optional(Type.Integer()), report: Type.String(),
    error: Type.Optional(Type.String()), truncated: Type.Boolean() })),
});
const reportPageSchema = Type.Object({ jobId: nativeId(), worker: nativeId(), status, settled: Type.Boolean(), historicallyTruncated: Type.Boolean(),
  error: Type.Optional(Type.String()), text: Type.String(), offset: Type.Integer(), totalBytes: Type.Integer(), nextOffset: Type.Optional(Type.Integer()) });
const references = (jobs: Awaited<ReturnType<typeof jobReferences>>) => [...new Set([...(jobs?.active ?? []), ...(jobs?.recent ?? [])])];
async function jobReferences(api: ChatExtensionContext) {
  await assertOrchestrator(api.harness, api.conversation.id, api.context);
  return api.harness.snapshot(Jobs, api.conversation.id, api.context);
}
async function selection(argument: string, api: ChatExtensionContext) {
  const parts = argument ? argument.split(/\s+/) : [];
  if (parts.length > 2) throw new Error("Use a job ID and optional 1-based worker number.");
  const jobs = await jobReferences(api), jobId = parts[0] ? id(parts[0]) : jobs?.recent.at(-1);
  if (jobId === undefined) throw new Error("No subagent jobs in this conversation.");
  const snapshot = await readJob(api.harness, api.conversation.id, jobId, api.context);
  const workerNumber = parts[1] === undefined ? undefined : Number(parts[1]);
  if (parts[1] !== undefined && (!/^[1-9]\d*$/.test(parts[1]) || !Number.isSafeInteger(workerNumber) || workerNumber! > snapshot.job.input.tasks.length)) throw new Error("Invalid 1-based worker number.");
  return { ...snapshot, workerNumber };
}
function messageText(message: Message): string {
  if (message.role === "system") return "";
  const body = typeof message.content === "string" ? message.content : message.content.flatMap((part) =>
    part.type === "text" ? [part.text] : part.type === "toolCall" ? [`[Tool call: ${part.name}]`] : []).join("\n");
  return body ? `[${message.role}]\n${body}` : "";
}
async function complete(prefix: string, api: ChatExtensionContext) {
  return references(await jobReferences(api)).toSorted((a, b) => b - a).map(String).filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
}
async function show(argument: string, api: ChatCommandContext) {
  const { job, workers, conversations, workerNumber } = await selection(argument, api), view = resultView(job, workers);
  if (workerNumber === undefined) {
    const progress = job.input.tasks.map((assignment, index) => {
      const worker = workers.find((record) => record.input.index === index), result = view.workers.find((value) => value.index === index);
      return `${index + 1}. ${assignment.name} (${assignment.role}) — ${result?.status ?? worker?.state.status ?? "not started"}${result?.conversationId ? ` · conversation ${result.conversationId}` : ""}`
        + `\n   Skills: ${assignment.capabilities?.skills.map((skill) => skill.name).join(", ") || "none"} · Extensions: ${assignment.capabilities?.extensions.join(", ") || "none"}`;
    });
    api.message([`Job ${job.id} · ${view.status} · ${job.background ? "background" : "legacy foreground"}`,
      `Workspace: ${job.input.profile.cwd}\nModel: ${job.input.profile.model.provider}/${job.input.profile.model.modelId}`,
      "No worker-count, concurrency, deadline, tool-call or saved-report limit. Workers cannot delegate.",
      ...progress, "", report(job.id, view),
    ].join("\n")); return;
  }
  const worker = workers.find((record) => record.input.index === workerNumber - 1), result = view.workers.find((value) => value.index === workerNumber - 1);
  const conversationId = (worker && conversations.get(worker.id)) ?? result?.conversationId;
  if (conversationId === undefined) { api.message(`Worker ${workerNumber} has no saved conversation reference. ${result?.error ?? ""}`); return; }
  const child = await api.harness.conversation(conversationId, api.context);
  if (!child) throw new Error("Worker conversation is missing.");
  const viewState = await child.viewState(api.context);
  try {
    const transcript = viewState.value.entries.flatMap((entry) => entry.model ?? []).map(messageText).filter(Boolean).join("\n\n");
    api.message(`Job ${job.id} / worker ${workerNumber} · conversation ${conversationId}\nCommitted transcript (recent context; thinking omitted):\n\n${bounded(transcript, 24000, "tail").text}`);
  } finally { viewState.dispose(); }
}

/** Built into pi-d via the native registry. Legacy budget options are ignored; importing starts no work. */
export function createSubagentsExtension(_legacyOptions: Partial<SubagentPolicy> = {}): ChatExtension {
  const delegate = defineTool({
    name: "delegate", callers: ["model"], replay: "safe", executionMode: "sequential",
    description: "Start self-contained subagent assignments using normal pi-d coding tools, this model and workspace. Explicitly assign each task's skills and extensions by exact parent-available names; omitted/empty lists mean none, not automatic inheritance. Selected skill instructions are loaded for that worker. No worker-count, concurrency, time or tool-call budgets. Workers cannot delegate. Always returns promptly with a background job ID so you can continue, inspect with agent_results, send steering/follow-up input with agent_message, or interrupt/cancel with agent_stop. By default a settled job automatically queues a completion event so you can retrieve and report results without polling; notify:false requests silence. Reports themselves are not automatically injected.",
    parameters: Type.Object({ tasks: Type.Array(Type.Object({ name: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }),
      role: Type.Optional(Type.String({ minLength: 1 })),
      skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true, description: "Exact skill names from the orchestrator's catalog; only these instructions are loaded. Omitted means none." })),
      extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true, description: "Exact enabled parent extension names, not files or module paths. Omitted means no additional extensions." })),
    }), { minItems: 1 }), context: Type.Optional(Type.String()),
      notify: Type.Optional(Type.Boolean({ description: "Default true: wake the coordinator once this job settles, using a native follow-up if busy. Set false only for a deliberately silent job." })) }),
    structuredOutputSchema: Type.Union([Type.Object({ jobId: nativeId(), background: Type.Literal(true), completionTaskId: Type.Optional(nativeId()) }), resultSchema]),
    async execute(args, api, context): Promise<ToolExecutionResult> {
      if ((await api.snapshot(Worker, api.conversationId, context))?.owner) throw new Error("Workers cannot delegate.");
      let { jobId, completionTaskId } = (await api.snapshot(Call, api.taskId, context)) ?? {};
      if (jobId === undefined) {
        const agent = await api.agent(context);
        if (!agent.model || !api.env?.cwd) throw new Error("Delegation requires a selected model and workspace environment.");
        const tasks = await assignments(args.tasks, agent, api.env.cwd, context);
        const input = { tasks, context: args.context?.trim() ?? "",
          profile: { model: agent.model, thinkingLevel: agent.thinkingLevel, cwd: api.env.cwd, instructions: agent.instructions ?? "" } };
        ({ jobId, completionTaskId } = await api.commit(async (tx) => {
          const call = await tx.doc(Call, api.taskId);
          if (call.jobId !== undefined) return { jobId: call.jobId, completionTaskId: call.completionTaskId };
          const jobs = await tx.doc(Jobs, api.conversationId);
          const options = { conversationId: api.conversationId, ownership: { kind: "conversation" as const }, background: true };
          const created = await tx.createTask(SubagentJob, input, options);
          // Atomic admission: no admitted job can lose its callback across a crash; no worker or old job acquires one.
          if (args.notify !== false) call.completionTaskId = await tx.createTask(SubagentCompletion, { jobId: created }, options);
          call.jobId = created; jobs.active.push(created); jobs.recent = [...jobs.recent.slice(-29), created];
          return { jobId: created, completionTaskId: call.completionTaskId };
        }, context));
      }
      await api.details({ jobId }, context);
      const saved = await api.getTask(jobId, context);
      if (!saved || saved.kind !== JOB_KIND || (saved.version !== 1 && saved.version !== 2 && saved.version !== 3) || saved.conversationId !== api.conversationId) throw new Error("Subagent job not found in this conversation.");
      // An old foreground tool owns its old job. Returning early would abort that job under native ownership.
      if (!saved.background && saved.owner !== undefined) {
        const settled = await api.waitForTask(jobId, context), result = settled.state.outcome.result ?? { status: "failed" as const, workers: [] };
        return { output: [{ type: "text", text: report(jobId, result) }], structuredOutput: { jobId, ...result },
          isError: result.status === "failed" || result.status === "aborted", details: { jobId } };
      }
      // Admission acknowledgement only: do not queue per-worker reads or copy large reports into this tool.
      const callback: JsonObject = completionTaskId === undefined ? {} : { completionTaskId };
      return { output: [{ type: "text", text: `Subagent job ${jobId} admitted in the background. This acknowledges admission, not completion. You retain control: agent_results reads snapshots/reports; agent_message queues steering/follow-up input; agent_stop interrupts/cancels a worker or job. Continue other work or yield rather than busy-poll. ${completionTaskId === undefined ? "This job is silent: no automatic completion event." : "When the job settles, a completion event will wake you (or queue after your current turn); retrieve the saved reports with agent_results and update the user."} Reports themselves are not automatically injected.` }],
        structuredOutput: { jobId, background: true, ...callback }, details: { jobId, ...callback } };
    },
  });
  const results = defineTool({
    name: "agent_results", callers: ["model"], replay: "safe",
    description: "Read subagent results without blocking. jobId shows ready reports even while siblings run. Add a 1-based worker for a full report page; continue with its UTF-8 byte offset. Omit jobId to list active/recent jobs; beforeJobId continues that list. Native output bounds do not truncate saved reports. Never joins or sleeps (legacy wait:true is ignored). Do not busy-poll.",
    parameters: Type.Object({ jobId: Type.Optional(nativeId()), worker: Type.Optional(nativeId()),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 32000 })), beforeJobId: Type.Optional(nativeId()) }),
    prepareArguments: resultsArguments,
    structuredOutputSchema: Type.Union([resultSchema, reportPageSchema, Type.Object({ jobs: Type.Array(resultSchema), nextBeforeJobId: Type.Optional(nativeId()) })]),
    async execute(args, api, context) {
      await assertOrchestrator(api, api.conversationId, context);
      const all = args.jobId === undefined ? references(await api.snapshot(Jobs, api.conversationId, context)).toSorted((a, b) => b - a)
        .filter((value) => args.beforeJobId === undefined || value < args.beforeJobId) : [args.jobId as TaskId<JobResult>];
      const ids = all.slice(0, 100), snapshots = await Promise.all(ids.map((jobId) => readJob(api, api.conversationId, jobId, context)));
      const views = snapshots.map(({ job, workers }) => resultView(job, workers));
      if (args.worker !== undefined) {
        const page = reportPage(snapshots[0].job, snapshots[0].workers, args.worker, args.offset, args.maxBytes);
        return { output: [{ type: "text", text: reportPageText(page) }], structuredOutput: page };
      }
      const nextBeforeJobId = all.length > ids.length ? ids.at(-1) : undefined;
      const output = args.jobId === undefined ? views.map((view, index) => `Subagent job ${view.jobId} is ${view.status}; ${view.workers.length}/${snapshots[index].job.input.tasks.length} results ready. Read with agent_results({\"jobId\":${view.jobId}}).`).join("\n")
        + (nextBeforeJobId === undefined ? "" : `\nContinue listing: agent_results({\"beforeJobId\":${nextBeforeJobId}}).`)
        : resultsText(views[0], snapshots[0].job.input.tasks.length);
      return { output: [{ type: "text", text: output || "No subagent jobs in this conversation." }],
        structuredOutput: args.jobId === undefined ? { jobs: views, ...(nextBeforeJobId === undefined ? {} : { nextBeforeJobId }) } : views[0],
        isError: args.jobId !== undefined && (views[0].status === "failed" || views[0].status === "aborted") };
    },
  });
  const stop = defineTool({
    name: "agent_stop", callers: ["model"], replay: "safe", executionMode: "sequential",
    description: "Interrupt/cancel subagent work through durable native cancellation. jobId stops a batch; jobId plus 1-based worker stops only that worker. Omit both to stop every active job in this conversation. Returns after the stop request is saved, not after cooperative cleanup; inspect agent_results for settlement. Earlier file/shell effects are not undone. Successful jobs with cleanup still pending require the local agent-stop command or the public API with a full Harness.",
    parameters: Type.Object({ jobId: Type.Optional(nativeId()), worker: Type.Optional(nativeId()) }),
    prepareArguments: stopArguments,
    async execute(args, api, context) {
      const { jobIds: marked } = await requestSubagentStop(api, api.conversationId, args, context);
      return { output: [{ type: "text", text: marked.length
        ? `Cancellation requested for ${marked.map((job) => `job ${job}${args.worker === undefined ? "" : ` / worker ${args.worker}`}`).join(", ")}. Native cleanup is cooperative; check agent_results for settlement. Earlier effects are not undone.`
        : "No matching active subagent work remains." }] };
    },
  });
  return defineChatExtension({ name: EXTENSION, tools: [...workerTools, delegate, results, stop, messageTool, ...legacyTools], tasks: [SubagentJob, SubagentWorker, SubagentCompletion],
    hooks: [hook(ToolTask, { async beforeTool(call, api, context) {
      const worker = await api.snapshot(Worker, api.conversationId, context);
      if (!worker?.owner) return;
      if (orchestrationTools.has(call.name)) return { block: "Only the main orchestrator may delegate, manage or message agents." };
      if (worker.capabilities && (!worker.capabilities.tools.includes(call.name)
        || !(call.parent === undefined ? worker.capabilities.modelCallable : worker.capabilities.callable).includes(call.name))) return { block: "This tool was not assigned to the worker." };
    }, async afterTool(_call, result, api, context) {
      if (!result.control?.addTools) return;
      const worker = await api.snapshot(Worker, api.conversationId, context);
      if (!worker?.owner) return;
      return { ...result, control: { ...result.control, addTools: result.control.addTools.filter((name) =>
        !orchestrationTools.has(name) && (!worker.capabilities || worker.capabilities.modelCallable.includes(name))) } };
    } })],
    wraps: [wrapSection("skills", (original) => ({ ...original, async render(input, context) {
      // Workers receive snapshotted skill instructions via agent.instructions, never the shared discovery catalog.
      if ((await input.read.snapshot(Worker, input.conversationId, context))?.owner) return undefined;
      return original.render(input, context);
    } }))],
    sections: [section("subagents", async (input, context) => {
      const worker = await input.read.snapshot(Worker, input.conversationId, context);
      if (!worker?.owner) return "You are the sole subagent orchestrator. delegate starts any number of parallel workers with no extension-imposed time/tool-call budgets, always in the background so you retain control. Workers cannot delegate. Supply self-contained tasks, applicable instructions and constraints; avoid conflicting concurrent edits. Explicitly assign skills and extensions per task; omitted/empty lists mean none. Use exact skill names from available_skills or explicit instructions. Eligible extension names in this conversation: "
        + JSON.stringify(input.agent.extensions.map((extension) => extension.name))
        + ". agent_results reads nonblocking snapshots or lists jobs; agent_message queues steering (default) or followUp input for an active 1-based worker, acknowledging admission only, never consumption. It cannot restart stopped/settled workers. agent_stop can interrupt/cancel any worker, batch, or all active batches. Do not busy-poll or claim completion before results exist. By default, each settled job queues one automatic completion event as a native follow-up: yield if there is nothing else to do, then use agent_results on the event's job ID and update the user after checking the reports. Do not repeat assignments or automatically delegate more work in response to an event. Reports are not automatically injected; notify:false deliberately silences a job. Closing pauses execution; reopening with trusted code and provider/recovery readiness recovers native work and pending completion events.";
      const capabilities = worker.capabilities;
      const missing = capabilities?.extensions.filter((name) => !input.agent.extensions.some((extension) => extension.name === name)) ?? [];
      if (missing.length) throw new Error(`Assigned extensions are unavailable: ${missing.map((name) => JSON.stringify(name)).join(", ")}.`);
      return ["You are an assigned subagent. Use your assigned tools as the task requires. Do not spawn, delegate to, manage or message other agents; orchestration belongs exclusively to the main agent. Report actual actions, evidence and uncertainty.",
        `Assigned extensions: ${capabilities?.extensions.join(", ") || "none beyond the baseline coding/worker infrastructure"}.`,
        `Assigned skills: ${capabilities?.skills.map((skill) => skill.name).join(", ") || "none"}.`,
      ].join("\n\n");
    })],
    piD: { commands: [
      { name: "agents", description: "List active/recent subagent jobs locally", async execute(argument, api) {
        if (argument) throw new Error("Use /agents without arguments.");
        const jobs = await jobReferences(api), ids = [...new Set([...(jobs?.active ?? []), ...(jobs?.recent ?? []).toReversed().slice(0, 10)])].toSorted((a, b) => b - a);
        const rows = await Promise.all(ids.map(async (jobId) => { const { job, workers } = await readJob(api.harness, api.conversation.id, jobId, api.context), view = resultView(job, workers);
          return `${jobId} · ${view.status} · ${view.workers.length}/${job.input.tasks.length} settled · ${job.background ? "background" : "legacy foreground"}`;
        }));
        api.message(rows.length ? rows.join("\n") + "\n/agent-show [job] [worker] · /agent-stop [job] [worker] · /agent-stop all" : "No subagent jobs yet. Ask the coordinator to delegate a task.");
      } },
      { name: "agent-show", description: "Inspect a job or worker's committed transcript locally", argumentHint: "[job-id] [worker-number]", complete, execute: show },
      { name: "agent-stop", description: "Stop a job, worker, or all jobs through native cancellation", argumentHint: "[job-id] [worker-number] | all",
        async complete(prefix, api) { return [...("all".startsWith(prefix) ? [{ value: "all", label: "all jobs" }] : []), ...await complete(prefix, api)]; },
        async execute(argument, api) {
          const selected = argument === "all" ? undefined : await selection(argument, api);
          const receipt = await requestSubagentStop(api.harness, api.conversation.id,
            selected ? { jobId: selected.job.id, ...(selected.workerNumber === undefined ? {} : { worker: selected.workerNumber }) } : {}, api.context);
          api.message(receipt.jobIds.length ? "Cancellation requested. Native cleanup is cooperative; inspect /agents for settlement. Earlier effects are not undone."
            : "No matching active subagent work remains.");
        } },
    ], async footer(api) {
      const jobs = await jobReferences(api), ids = jobs?.active.length ? jobs.active : jobs?.recent.slice(-1) ?? [];
      if (!ids.length) return [];
      const views = await Promise.all(ids.map(async (jobId) => { const { job, workers } = await readJob(api.harness, api.conversation.id, jobId, api.context); return { job, view: resultView(job, workers) }; }));
      const total = views.reduce((sum, { job }) => sum + job.input.tasks.length, 0), settled = views.reduce((sum, { view }) => sum + view.workers.length, 0);
      const running = views.some(({ view }) => view.status === "running" || view.status === "completing"), state = views[0].view.status;
      return [{ text: `agents ${settled}/${total}${running ? " bg" + (views.length > 1 ? ` · ${views.length} jobs` : "") : ` ${state}`}`,
        tone: running ? "gold" : state === "completed" ? "green" : "red" }];
    } },
  });
}

export default createSubagentsExtension();
