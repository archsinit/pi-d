# Built-in subagents

Subagent orchestration is **built into normal pi-d startup**. No extension installation, configuration symlink or activation flag is needed. It uses stock Durable tasks and child conversations inside the existing pi-d process, not a separate service or runtime. Startup registers the capability but starts no workers or model requests.

Workers have the normal **read, write, edit and bash** tools, subject to the parent's native tool filters. The orchestrator explicitly assigns additional **skills and extensions per worker**; nothing custom is inherited by default. There is **no pi-d-imposed worker-count, batch-count, concurrency, time, tool-call or saved-report limit**. Only the main orchestrator may delegate or manage workers: no nested subagents. Delegation, messaging and result inspection do not wait for worker execution; the orchestrator can steer active workers or interrupt/cancel individual workers, whole jobs or every active job.

**Not a sandbox:** workers, tools and trusted code have this account's OS permissions. They can modify files, run commands and access paths outside the workspace. Cancellation does not undo earlier effects, and cannot forcibly stop uncooperative external code. Unlimited work can consume unlimited quota and substantial machine resources. Avoid conflicting concurrent edits.

## Normal startup

Start `pi-d` normally, or use `pi-d --resume` to choose a saved session. The coordinator has `delegate`, `agent_results`, `agent_stop` and `agent_message`; local `/agents`, `/agent-show` and `/agent-stop` are available without model preflight. Workers start only when delegated. Existing running sessions need a restart to load updated host code.

`--no-extensions` skips automatic **external** extension discovery, not built-in tools or subagents. Normal native conversation/tool filters still apply. Custom workers remain headless and non-nesting, with no automatic inheritance of additional skills or extensions.

## Isolated experiment

For optional disposable HOME/XDG/session/workspace isolation, from a checkout after `npm ci --ignore-scripts`:

```sh
npm run subagents:isolated -- --check  # Create private state; print its plan only
npm run subagents:isolated            # Create and launch a different fresh experiment
# Reopen the directory printed by either command:
node bin/pi-d-subagents.mjs --experiment /absolute/path/printed/by/the/helper
```

The helper uses this checkout's launcher without changing your normal launcher, branch or global installation. It creates a private temporary workspace, fixed SQLite session, separate HOME/XDG config/data/cache, disables automatic external extension discovery, and uses the built-in subagents without loading any explicit extension. It does not inherit API keys, OAuth/cloud credential variables, SSH agent sockets, proxies, Node preloads or caller PATH/Git configuration. Reopening requires its private marker and rejects symlinked state paths; arbitrary pi-d flags are not accepted.

Fresh experiments have **no login**. Local commands work without credentials. If wanted, sign in with `/login` in this separate configuration; live use consumes real quota. Tests do not copy or use everyday credentials.

Temporary state is retained for reopening but may eventually be removed by the OS. Close the experiment before backing up/deleting its whole directory. Closing **pauses, rather than cancels**, unfinished native work. A hard crash has the normal five-minute advisory-lock stale period; never remove a live lock.

Configuration/workspace separation does **not** revoke OS access, protect valuable files from commands, neutralize parent-process preloads or isolate machine-level services. Do not use unfamiliar agents on valuable data.

## Packaging and migration from manual loading

Subagents are registered by the host alongside the coding tools, using Durable's native extension format internally. This is an implementation detail, not a separately installed add-on. Source and compiled package launches have the same built-in capability, including with external discovery disabled:

```sh
node bin/pi-d.mjs --no-extensions \
  --session /absolute/path/to/a/separate.sqlite --cwd /path/to/disposable/workspace
```

Unlike the isolated helper, that command uses the shell's normal HOME/configuration and credentials.

**Remove old `pi-d-subagents` configuration entries/symlinks and explicit loading arguments**, including wrappers that export `createSubagentsExtension()`. A second registration fails startup with a migration message rather than overriding or duplicating the built-in. No existing job/worker identity, saved report or conversation is changed by removing redundant loading configuration. Restart pi-d to load the built-in; required explicitly assigned third-party extensions must still be present for recovery. Executable paths are not saved in SQLite.

The package still exports **`pi-d-chat/subagents`** and `createSubagentsExtension()` with types for programmatic embedding in other stock Durable hosts. Do not register another copy in pi-d itself. No new dependency, global package installation or background service is needed.

## Coordinator tools

For example:

> Delegate a reviewer for cancellation handling and another worker for tests. Supply the applicable instructions and constraints. Continue coordinating while they work; stop a worker if its direction is wrong. Read their reports before claiming completion. Do not commit or push.

- **`delegate({ tasks, context?, notify? })`** starts any nonempty array of self-contained assignments with nonblank `name`, `task`, optional role label (`worker` by default), and optional `skills`/`extensions` name arrays. Omitted or empty arrays mean **none**, not automatic inheritance. There are no size/concurrency caps or one-active-batch gate. The shared brief is not the parent's transcript. **Always returns a background job ID promptly**, retaining coordinator control. Legacy `background: false` does not make new jobs foreground. Completion callbacks default to **on**; set `notify: false` only for a deliberately silent job. The acknowledgement includes `completionTaskId` when enabled.
- **`agent_results({ jobId?, worker?, offset?, maxBytes?, beforeJobId? })`** returns immediately. A job ID shows ready worker reports in **model-readable text**, even while siblings run, including generic native fault/orphan failures. Add a **1-based worker** to read its saved report page; continue with the returned UTF-8 byte `offset`. The default page is at most 24,000 bytes/800 newline boundaries; `maxBytes` accepts 4–32,000. Pages preserve Unicode, blank lines and trailing text, split oversized lines, and leave room for textual continuation instructions below native output bounds. Job overviews may be shortened; they explain how to select each full report. Omitting the job lists up to 100 active/recent references per page; use the returned `beforeJobId` to continue. Offsets/page sizes require job+worker, and list cursors cannot be mixed with a job. It **never waits**, even for legacy `wait: true`. Do not busy-poll; continue useful work or yield.
- **`agent_stop({ jobId?, worker? })`** interrupts/cancels a job, or one **1-based** worker within it. Omit both fields to stop every active job in the calling conversation. Worker selection requires a job ID. Stops are saved durably and idempotently; malformed/null/string/fractional/unsafe targets and unknown stop fields reject **before schema coercion or mutation**. The tool returns after the **request**, not after cooperative cleanup. Use results/local inspection to confirm settlement before starting conflicting work.

- **`agent_message({ jobId, worker, message, mode? })`** queues nonblank input for one **1-based**, active worker in the calling conversation's job. `mode` is `"steer"` (default) or `"followUp"`. Returns promptly after durable native inbox admission, **not** consumption or completion; see below.

All four orchestration tools are model-only and unavailable to workers. Explicit ownership guards also reject worker calls if trusted code bypasses tool selection. This prevents recursive delegation through the built-in orchestration tools; it is not an OS permission boundary against arbitrary trusted code or shell programs.

Jobs survive ordinary coordinator Escape/`/interrupt` and ordinary idle waits. By default, a settled job **automatically wakes the coordinator** with one concise status/reference event, so it can call `agent_results` and update you without polling. Reports themselves are not injected. There is no daemon: closing the Harness stops execution; reopening with trusted code, provider access and recovery readiness can resume it.

Ordered reports include status, findings, task/conversation IDs, and generic errors without raw provider failures. Successful siblings survive individual failures/stops. While active, job status is `running` or `completing` (**cleanup pending, not settled**). Terminal batch status is `completed`, `partial`, `failed` or `aborted`; native completed receipts can contain domain-level partial/failed results. Reports are delegated claims, not independent verification. Inspect evidence, actual changes/tests and uncertainty. Thinking-only/blank answers fail; new saved reports are not byte-truncated.

### Automatic completion callbacks

- One event per job, not per worker, after the job is genuinely **terminal**, including native ownership/cooperative cleanup. It covers `completed`, `partial`, `failed` and `aborted` results, including native task faults. It does not wake worker conversations or create nested jobs.
- An idle coordinator starts a normal native run. A busy coordinator receives a native **`followUp`**, after its current final boundary, without interrupting tools/provider requests. The event carries only the job ID and validated status plus fixed collection guidance; worker reports, names, instructions and provider errors remain out of the event. Use `agent_results` to retrieve full reports and verify their claims.
- The terminal displays **`◇ Subagent completion`**, not a message attributed to you. This is a persisted application input in model context, unlike UI-only local command output. The resulting model/tool work can consume quota, just like an ordinary coordinator turn.
- Native request ID `subagent-completion:<job-id>` deduplicates admission across crashes/lost acknowledgements/reopening. This is **not exactly-once model execution** or guaranteed collection: provider requests may replay. A callback left unanswered/withdrawn is not automatically retried. If the parent's in-flight provider request fails before draining an accepted follow-up, native delivery can leave it queued until another ordinary turn reaches a final boundary; inspect `/queue` or `/status`.
- Ordinary parent interruption withdraws callbacks already queued, but does not cancel background jobs/notifiers: a job that settles later can still wake the coordinator. Stopping a job alone normally produces an `aborted` callback. Native explicit background-scope cancellation can stop the notifier too, without sending. `notify: false` suppresses creation entirely.
- On normal pi-d reopen, a fresh **process-local model-readiness gate** waits for host authentication/recovery preflight. Local `/interrupt` or `/agent-stop` may resume native cleanup but cannot authorize a new completion input or worker/callback generation request. Pending callbacks remain saved until readiness is granted. Successful preflight/login releases the gate. Native generation, compaction and deferred-fetch model APIs share this per-Harness boundary, independently of selected extensions. Approval is not saved, and every reopen requires fresh preflight. Native cancellation of already-issued deferred responses remains available for cooperative cleanup. Programmatic Durable embeddings retain their own admission/authentication policy.

### Steering and follow-up messages

```ts
agent_message({ jobId: 42, worker: 2, message: "Review only; do not modify files." })
agent_message({ jobId: 42, worker: 2, message: "Also check the recovery tests.", mode: "followUp" })
```

- Targets are exact native job IDs and 1-based worker numbers, not names or conversation IDs. IDs/numbers must be positive safe integers; fractions and strings are rejected rather than coerced to another target. Unknown/foreign jobs, invalid workers, blank messages and invalid modes reject without adding child input. No extension message-count or message-size cap is added.
- Only a worker with an admitted initial assignment and a live native run accepts new messages. Unstarted/unprepared/upgrading, cancellation-requested, completing and settled workers reject immediately. There is no startup buffer, retry, cancelled-worker resume or terminal-child restart. Use results/local inspection to distinguish states; do not busy-poll.
- Messages use Durable's **existing `pi.inbox` and input submissions**. Steering is placed at an eligible native boundary (normally after tools, or at a final answer); follow-ups wait for a final boundary and can start further native runs within that same worker. Native `steeringMode`/`followUpMode` settings apply. Modes can be selected at different boundaries, so admission order is not a cross-mode consumption-order guarantee. Neither mode forcibly interrupts an in-flight tool or provider request.
- The acknowledgement contains `jobId`, `worker`, `conversationId`, `requestId`, `submissionId`, `mode` and admission `status: "queued"`. It says nothing about reading, obedience, successful effects or completion; cancellation/provider failure can leave accepted input unanswered. A replay returns the **same admission receipt**, even if the native submission has since completed or been cancelled. Each tool call uses stable request ID `subagent-message:<tool-task-id>`; a new intentional call is a distinct message, even with identical text.
- Admission, ownership/stop/lifecycle checks, the native inbox item and replay receipt commit atomically. If cancellation/completion wins the race, no input is added; if admission wins, later cancellation can withdraw it. Lost acknowledgements/reopening do not duplicate child input. Native submissions and saved tool results remain authoritative; task-scoped replay references retire normally when their tasks settle.
- A worker waits for its ordinary native conversation scope to become idle, including accepted follow-up runs, before closing messaging and draining background work. Its saved report is the **latest answered input's final answer**, not an earlier assignment answer. Unanswered accepted input prevents a successful worker result; explicit cancellation produces an aborted result. Only after final settlement does the job's completion event prompt the parent to retrieve this latest saved report; raw reports are not automatically injected.

### Explicit per-worker skills and extensions

For example, when these skills and extension names are available to the calling orchestrator:

```ts
delegate({
  context: "Review only; do not commit or push.",
  tasks: [
    {
      name: "review",
      task: "Review cancellation and recovery; cite evidence.",
      role: "reviewer",
      skills: ["code-review"],
      extensions: ["review-tools"],
    },
    {
      name: "tests",
      task: "Run the offline tests and report failures.",
      skills: [],
      extensions: [],
    },
  ],
})
```

- **All parent-available skills and all parent-selected extensions are eligible.** There is no separate worker-safe allowlist or extension-name guessing. Use exact skill metadata names and native extension names, not tool names, paths, module specifiers or registry entries disabled for the parent. The orchestrator's prompt lists its eligible extension names; skill discovery and `/extensions`/`/skills` retain their normal behavior.
- Skills come from the parent's enabled host catalog, including configured/shared/project roots and explicit `--skill` paths. Known explicit-only skills can be assigned by name; they remain omitted from automatic discovery. Selected full skill files, names and locations are snapshotted **before admission**, then supplied as child instructions. Relative skill references resolve against their source file's directory. Workers do not receive the shared skill catalog or skills previously loaded into the parent's conversation. No selection means no skill instructions.
- Additional extensions contribute their applicable native tools, sections, hooks, wrappers and task definitions through the stock registry. Their relative parent composition order is retained; assign dependencies explicitly. Baseline worker infrastructure (`pi-d-subagents`), stock coding registrations and the installed host prompt (`pi-d-prompt`) remain present without listing them. Native parent enabled/model/caller filters are retained; deferred loading stays within the assigned tool set. Selecting `pi-d-subagents` never enables its four orchestration tools in a worker, including messaging itself or another worker.
- Workers stay **headless**, even when an assigned extension also declares commands or footer UI. Those host UI adapters remain main-conversation-only; they are not invoked for children. This does not disable applicable native hooks/tools or promise that arbitrary trusted extension code is compatible with headless use.
- Blank, duplicate, unknown, disabled or unreadable selections reject the **whole batch before admission**. Assignments are persisted independently per worker; they do not follow later parent selection changes. Recovery reuses saved skill contents and extension/tool names, not freshly discovered skill instructions or saved executable module paths. Restart with the required trusted extension code. Updated code is not version-pinned by this data snapshot.

Only explicitly assigned instruction/tool contributions are passed; this is **not a file-access sandbox**. Stock bash/read and trusted native code can still reach other account-readable files. Selected third-party code may have its own limits or effects, and conflicting extension contributions follow native composition rules.

## Local controls

Local commands do not become model input or require model preflight:

| Command | Effect |
| --- | --- |
| `/agents` | List **all active** jobs plus ten recent references. |
| `/agent-show [job-id]` | Inspect latest/specified profile, per-worker skill/extension selections, progress and reports. |
| `/agent-show [job-id] [worker-number]` | Show recent committed worker context, omitting thinking. |
| `/agent-stop [job-id]` | Save a native whole-job cancellation request. |
| `/agent-stop [job-id] [worker-number]` | Save cancellation for one assignment, including an unstarted worker; preserve siblings. |
| `/agent-stop all` | Native cancellation of every active job in this conversation. |

IDs complete from active/recent references; commands otherwise default to the latest job. Local stops and the model tool now share the same guarded request path, including unstarted assignments. They acknowledge **requested**, not completed cleanup; inspect for settlement before conflicting work. Inspect/footer/completion reads do not create documents, model requests or submissions. Stops mutate native state and do not undo effects, even if the local command is subsequently interrupted. A callback-enabled job may then queue a completion/cancellation event and cause a coordinator model turn once host readiness permits; inspection itself stays read-only.

The footer aggregates `agents settled/total bg` across active jobs, or shows the latest final status. Local transcript previews retain the most recent **24,000 UTF-8 bytes**; this is a UI window, not an execution/report budget or full archive/export UI. Native records, original conversation text and full new reports remain in SQLite. Local command messages disappear on app close. `/new`/`/clear` retain references/results; a separate conversation/fork starts independently. Thirty recent references are retained **in addition to every active job**; older native records are not deleted.

## Typed inspection and control API

Trusted Durable extensions can import these functions and detached readonly DTO types from **`pi-d-chat/subagents`**. No private document/checkpoint imports, second extension registration, scheduler, service or supervision UI are needed. The first argument is a native Harness (or compatible `snapshot`/`commit` access), followed by the calling conversation ID and native Chord context:

| Function | Contract |
| --- | --- |
| `listSubagentJobs(access, conversationId, context)` | Report-free summaries of all indexed active jobs plus retained recent references, newest first. Not a cross-session/archive scan. |
| `inspectSubagentJob(access, conversationId, jobId, context)` | Report-free job/worker state, exact native references, assignments, captured capability names/tool filters, model, timestamps, result availability and cancellation intent. Older uncaptured capabilities remain absent. |
| `readSubagentReportPage(access, conversationId, { jobId, worker, offset?, maxBytes? }, context)` | Saved report text plus byte offsets/total, optional `nextOffset`, worker outcome/settlement, error and separate `historicallyTruncated` flag. Rejects unavailable reports and offsets inside UTF-8 code points or beyond the end. Empty/trailing-newline pages are not trimmed. |
| `requestSubagentStop(access, conversationId, { jobId?, worker? }, context)` | Shared native stop admission; returns `{ status: "requested", jobIds, worker? }`, not joined cleanup. A Harness supplies `resume()` to wake native cleanup and `abortTask()` to cancel successful held cleanup, without granting host model readiness. Empty targets select every live native job in the calling conversation, including unindexed/older completing jobs; unknown fields reject. |
| `admitSubagentMessage(access, conversationId, { jobId, worker, message, mode?, requestId }, context)` | Shared atomic, busy-only native inbox admission with a durable caller identity; returns the original admission receipt on replay. No idle/terminal worker restart. |

A `completing` job is still stoppable through a **full native Harness**, including after a paused reopen. Whole-job cancellation marks that job; selecting a worker never falls back to cancelling its parent or siblings. Native cancellation preserves an already-decided outcome/report, so cancelling cleanup may still leave a final `completed` result. It does not wait for owned cleanup, although the stock SDK can still join an uncooperative finishing run invocation. Access with only `snapshot`/`commit` (including the model tool API) cannot issue a new native abort mark for successful held cleanup: it rejects explicitly, without changing any batch controls, and directs the user to local `/agent-stop` or this function with a full Harness. Already-native-cancelling cleanup can be acknowledged and resumed without another mark.

Inspection performs no storage writes, model preflight, task creation or input admission. Task/ownership rows for one job share a **table-read-only native transaction**, including recovery through native ownership when a task fault/orphan removed checkpoint/result references. Discovery indexes and stop-intent documents are separate committed reads; a multi-job listing is **not one globally atomic frame**. Snapshots can become stale immediately: controls recheck ownership and lifecycle on their own mutation line. Returned objects/arrays are detached; readonly types do not imply a live subscription or immutable runtime objects. Native fault diagnostics stay generic, not raw provider errors.

`state` is native lifecycle; `outcome` is the decided application result where available; `nativeOutcome` preserves native fault/orphan distinctions. **`settled` means `terminal`, never merely `completing` or “report available.”** A report page's `settled` refers to its worker; inspect the job separately for whole-job settlement. Timestamps include waiting/recovery, not active-compute measurements. `stopRequested` is current observed intent, not a permanent action audit. Full report text is retrieved separately; no saved skill contents, instruction profile, raw task records or document tokens are exposed.

For example, inside a Durable extension's existing local command:

```ts
import { listSubagentJobs, inspectSubagentJob, readSubagentReportPage } from "pi-d-chat/subagents";

const jobs = await listSubagentJobs(api.harness, api.conversation.id, api.context);
if (jobs[0]) {
  const job = await inspectSubagentJob(api.harness, api.conversation.id, jobs[0].jobId, api.context);
  const worker = job.workers.find(worker => worker.reportAvailable);
  if (worker) {
    const page = await readSubagentReportPage(api.harness, api.conversation.id,
      { jobId: job.jobId, worker: worker.worker }, api.context);
    api.message(page.text); // Continue with page.nextOffset when present.
  }
}
```

For messaging, create and retain a **new stable `requestId` for each intentional action before calling**, then reuse that same ID and exact target/message/mode after an uncertain acknowledgement. IDs are nonblank strings up to 256 characters, scoped to the calling conversation. A hashed native request namespace avoids collisions with model-issued tool calls. The identity is bound to the original conversation, job, worker, message and normalized mode; altered reuse rejects. A small latest-only, fork-initial conversation document family retains fingerprint/receipt metadata for that conversation's lifetime, including after worker/job settlement and SQLite reopen. It stores **no message queue or message body**; native inbox/submissions remain authoritative. Failed admission leaves no new receipt. Model tools retain their existing task-scoped replay receipts rather than accumulating these extension identities.

`status: "queued"` always describes the original admission—even on replay after consumption, failure or cancellation. It is not exactly-once provider execution, delivery, obedience or completion. New admission rejects starting, cancelling, completing, settled and foreign targets. All functions enforce calling-conversation/orchestrator scope; trusted extensions still have full native/OS permissions, so this is not a security boundary against arbitrary trusted code.

For future live views, use native commit subscriptions, coalesce/schedule reads **outside** the observed mutation-line callback, and dispose subscriptions on close. No subscription runtime, UI widget framework or supervision screen is added here. See [extension contracts](extensions.md).

## Worker profile

Each task owns its child conversation. Workers use the parent's selected model/thinking/workspace and explicit `agent.instructions`, their assignment/brief, stock coding tools, and the host's normal coding/prompt sections when installed (including project instructions, but **not** the general skill catalog). Explicit per-task selections add extension contributions and full skill instructions as described above. They do not clone parent conversation history, unselected custom extensions/hooks/tools, or rendered parent instruction sections. Supply essential context and ancestor/global constraints explicitly. Models are instructed to follow applicable, more-specific `AGENTS.md` instructions and never spawn/delegate to other agents; prompt compliance alone is not guaranteed.

The former read-only path/symlink/image restrictions are gone. Workers use the same stock tools and permission model as ordinary pi-d. Native tool output clipping, model context/compaction, provider quotas/timeouts and finite OS resources still apply; those are not added worker budgets. A bash timeout explicitly requested by the model remains an ordinary tool argument. There is no worker-specific cheaper-model routing, dollar/token budget, automatic worktree/merge workflow or rollback.

Native retries, recovery, completion callbacks and background compaction can add provider activity. Usage stays in Durable's ledger without double-charging reports. The normal chat footer is conversation-scoped, not a total batch-cost meter.

## Native ownership, control and recovery

One stock **pi-durable 1.2.0** Harness/registry/SQLite store; no second scheduler, agent loop, polling timer, transcript database or runtime dependency.

1. Replay-safe delegation validates parent-scoped selections and loads selected skill files outside the mutation line. It then atomically saves their per-worker data, a task-scoped call reference, a **conversation-owned native background job**, and (unless silent) its conversation-owned background notifier sibling. Admission waits for validation/file reads, never for worker execution.
2. Dispatch creates every assignment as a native job-owned worker task. Short transactions admit at most 64 at a time to let control commits interleave; this is **not** a concurrency cap or completion wave—later admissions never wait for earlier workers to finish. Collection uses invocation-bound native task waits and a native document watch for durable stop requests. The job applies native `abortOwned` and checkpoints ordered outcomes.
3. A worker atomically creates/configures its task-owned child, submits with stable request ID `subagent:<worker-task-id>`, and reacquires that submission on replay. No persisted deadline, sleep race or tool-admission budget exists. Its invocation-bound control watch also handles stop requests while an older job is still in a native waiting state.
4. Busy-only messaging atomically uses the public `Tx.createSubmission`/`InboxDoc` surfaces after checking native ownership, task/stop state and `LiveDoc.run`. A separate later `Conversation.submit()` would risk restarting an idle child. Native generation/inbox boundaries perform all placement, run continuation and settlement; there is no extension delivery loop or second queue. Task-scoped documents retain request references, a completion gate and an immutable replay acknowledgement, not message contents.
5. Worker completion uses the invocation-bound native idle wait and latest native answer receipts, then closes admission before draining. Native ownership handles abort/draining. Completion/cancellation explicitly drains child background boundaries, including compaction. Native records/receipts remain execution authority; conversation references only index jobs. No detached continuations are added.
6. The notifier parks in native `waiting`/`allSettled` on the job. It never owns or holds that job. After validating terminal state, parent ownership and non-worker scope, it uses public invocation-bound `ConversationHandle.submit()` with a job-scoped request ID and `whenBusy: "followUp"`. Native admission wakes idle parents as well as queues busy ones. Its terminal receipt acknowledges submission admission, not model processing; it does not wait for the coordinator's answer.

This is **not exactly-once execution**: provider/read requests may replay. Native unsafe-tool interruption behavior is preserved for shell/write/edit; partial effects remain possible. Stable admissions/requests prevent duplicate assignment/conversation creation in tested crash windows, not arbitrary external effects. Missing trusted definitions keep host recovery paused. Inspect `/status` for blocked recovery.

### Existing experimental sessions

Callbacks are installed **only at new job admission**. Pre-upgrade pending jobs keep their existing behavior; historical/terminal jobs are not backfilled or replayed as new input. New notifier tasks survive closing/reopening alongside their original job and request identities.

Version-1 and version-2 jobs/workers and metadata migrate through native migrations to the version-3 assignment format. Obsolete numeric policy fields, deadlines, call counts and exhaustion flags are ignored/removed, not reapplied on reopen. Existing child/request identities and already-saved outcomes remain intact; old reports already truncated by v1 are not reconstructed. Prepared old requests can still use legacy `agent_read`/`agent_list`/`agent_search` aliases without the former restrictions; later worker profiles have normal coding tools. Older jobs have no explicit skill/extension selections and do not acquire new ones on upgrade. Already prepared native requests retain their captured context; previously supplied skill text or discovery cannot be retroactively erased.

**Already-running v1 foreground jobs retain their immutable native tool ownership.** Their replayed delegate must finish waiting, or returning would implicitly abort their owned work. Let those jobs settle or use local `/agent-stop`/native interruption first. Only newly admitted jobs have the always-nonblocking background ownership. Old background work remains model-cancellable after upgrading; no existing work is silently reparented, discarded or automatically cancelled.

For other Durable hosts embedding `createSubagentsExtension({ concurrency, maxTasks, timeoutMs, maxToolCalls, maxReportBytes })`, **all these legacy options are ignored**. In pi-d, remove manual wrappers because the capability is already built in. Deprecated `DEFAULT_POLICY` fields are now `null` (unlimited), not configurable execution caps.

## Verification

Faux providers and temporary HOME/XDG/workspaces/memory/SQLite only; no live credentials or ordinary sessions. Inspection/API regressions cover pre-coercion invalid/null/typo rejection without mutation, ready sibling text, native fault/orphan projection and reference recovery, held cleanup versus settlement, detached/no-write inspection, byte/line-bounded lossless Unicode/FEFF/trailing-blank report pages through both the API and model context, identity-reuse rejection, post-settlement/cancellation replay and lost-caller-acknowledgement SQLite recovery. Tests also cover explicit per-worker skill/extension differences, omitted/empty selections, parent-only validation, full/explicit-only/externally configured skills, native hooks/wrappers/tools, caller/deferred filters, headless mixed UI extensions, and more than the old batch/concurrency/call limits, overlapping batches beyond reference retention, nonblocking snapshots/message acknowledgements, native steering/follow-up boundaries and queue modes, full Unicode messages, scope/target/caller/nesting guards, completion/cancellation races, unanswered messages, model/local individual and whole-job stops, actual file/shell work, cancellation/draining, scope/nesting guards, full Unicode reports, failures, UI inspection/completion/footer and helper guards.

Callback tests cover idle/busy wake-up and result retrieval, full reports without automatic injection, silent jobs, worker/foreign/foreground guards, all statuses, job/abort-handler faults, cleanup ordering, overlapping batches, provider failure, withdrawal and readiness. SQLite tests cover atomic job/notifier admission, terminal settlement, callback admission/placement/receipt/answer recovery, model-readiness reset across reopen and local paused controls, missing notifier code, message admission/placement/answer/receipt recovery, replay after worker settlement, queued-message cancellation without new model requests, lost commit acknowledgements, saved skill contents after file changes, SIGKILL, missing-extension readiness, long downtime and migration of genuine v1/v2 native shapes/ownership. Startup tests verify built-in registration without external discovery/configuration, zero work before delegation, reserved-name migration errors and recovery of a prior opt-in job without manual loading. Packaging tests exercise compiled built-in startup and exports, external extensions, actual faux delegation/messaging with selected/unselected capabilities, isolated local/global-prefix installs and helper PTYs.

Live providers, actual cost/quota, hostile external code, power-loss durability and other platforms remain unverified. There is no automatic raw-report injection, worker-to-worker messaging, cancelled-worker resume/retry, multi-model router, worktree manager, dashboard or permission sandbox.
