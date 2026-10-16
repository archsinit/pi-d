# pi-d and pi

pi-d builds a terminal interface around the stock pi-durable Harness. Durable runs and stores the work; pi-d supplies application controls and a btop-inspired display. It uses no Pi session runtime or compatibility layer.

The baseline is **pi 1.2.0**, revision [`06a466935536f8c9bcacb2d5efc0fc021be1bdff`](https://github.com/earendil-works/pi/tree/06a466935536f8c9bcacb2d5efc0fc021be1bdff). pi-d pins pi-durable, pi-ai and pi-tui to 1.2.0. The comparison covers source and documented behavior, not performance or later releases. Installed Pi packages can add features beyond those listed here.

## How pi-d works

A normal launch opens one SQLite store and displays its root conversation. Input enters through Durable's admission API. The Harness runs generation and tools, commits their state, and exposes a conversation watch for pi-d to render. There is no second saved transcript or agent loop.

```text
CLI + trusted extension files
          │
          ▼
stock registry + CodingTools + pi-d prompt sections
          │
          ▼
stock Harness ── pi-ai models/providers
          │   └─ NodeExecutionEnv: host files and shell
          ▼
Durable SQLite store: entries, documents, submissions, tasks, usage
          │
          ▼
conversation watch ── pi-d presentation ── pi-tui terminal components
```

| Source | Responsibility |
| --- | --- |
| `src/cli.ts`, `bin/pi-d.mjs` | Options, launcher, startup, global/explicit extensions and shutdown |
| `src/session.ts`, `src/sessions.ts` | SQLite opening, ownership locks, saved settings/workspace and session discovery |
| `src/chat.ts` | Input admission, committed-state watch, recovery checks and session handoff |
| `src/ui.ts`, `src/transcript.ts`, `src/theme.ts`, `src/dialog.ts` | Frames, editor, dialogs, role styling, streaming display, committed edit patches and footer |
| `src/commands.ts`, `src/completion.ts`, `src/status.ts` | Commands, completion, inbox controls and recovery diagnostics |
| `src/auth.ts`, `src/login.ts` | Private credential storage; pi-ai OAuth and refresh integration |
| `src/coding.ts`, `src/resources.ts` | Stock coding tools/environment, adapted Pi prompts, AGENTS, skills and Durable extensions |
| `src/demo.ts` | Offline demo using the Harness, a faux provider and memory storage |

Durable owns scheduling, retries, tool execution, cancellation, inbox placement, compaction, context projection and recovery. pi-ai handles provider protocols and model access. pi-tui supplies the terminal components and differential renderer.

## Runtime, sessions and context

| Area | pi 1.2.0 | pi-d |
| --- | --- | --- |
| Agent foundation | pi-coding-agent's session runtime and pi-agent-core | Unmodified pi-durable Harness |
| Persistent state | JSONL session tree with parent-linked entries | SQLite entries, documents, tasks, submissions and usage; WAL with `synchronous=FULL` |
| Ordinary startup | Starts a session; `--continue` resumes the most recent for the project | Reopens shared `default.sqlite` unless a selector is supplied; no automatic project separation |
| Separate sessions | `/new`, session IDs/names, session directory overrides | `--new-session` or `/session-new [name]`; UUID-named databases grouped by canonical workspace hash |
| Ephemeral sessions | `--no-session` supports ordinary model work without persistence | Scripted `--demo` only; no live-model in-memory-session flag |
| `/new` | Creates a new session | Resets context in the same database; `/clear` is an alias. Stored history, settings and the newer draft remain |
| Resume | Picker, `--continue`, path/exact/partial ID lookup and cross-project handling | `--resume` or `/resume` filters managed/default stores by saved workspace; `--session path` opens other files explicitly |
| Picker management | Search, rename, delete, sorting and named-session filtering | Filename/name substring filtering; no rename, delete or content search. Inspects at most 200 recent candidates across the managed/default layout |
| Workspace | Launch directory drives project discovery and grouping | Saved in the agent document, even when launched elsewhere. `--cwd` changes it only with no unfinished work |
| Session navigation | `/tree`, `/fork`, `/clone`, branch summaries and labels | One root conversation per open store; no tree, branching or archive UI |
| Restart recovery | Restores history through its session runtime | Resumes unfinished tasks/submissions after authentication and extension checks. Interrupted provider calls may repeat |
| Tool interruption | Pi runtime's tool lifecycle | Durable reports interrupted non-replay-safe tools instead of rerunning them automatically. Effects may already have happened; the model can request another call |
| Ownership | Pi's session persistence mechanisms | Canonical-path advisory lock for cooperating local processes; symlink aliases share it, hard links are rejected. Crashed-owner expiry: five minutes. No distributed fencing |
| Automatic compaction | Runtime-managed threshold/overflow compaction with configurable settings | Durable background summaries can overlap chat. Defaults reserve 16,384 response tokens, retain about 20,000 recent tokens and start 32,768 tokens below the blocking threshold |
| Manual compaction | `/compact [instructions]` | No command; Durable has an API |
| Visible history | Session navigation and export provide access to older entries | Active context after reset/compaction; older entries remain stored without an archive browser or export |
| Retries and failure | Configurable runtime/provider retry and recovery policy | Durable retry/task policy; no app retry loop or settings UI. Storage/observation failure disables admission until reopen |
| Context meter | Runtime context-usage display | Active context plus committed live partials, estimated against the pinned catalog limit; not cumulative usage or subscription quota |

Neither runtime promises exactly-once model requests or external effects.

## Coding, input and terminal behavior

| Area | pi 1.2.0 | pi-d |
| --- | --- | --- |
| Default tools | `read`, `bash`, `edit`, `write` | Same names and purposes, using Durable's stock CodingTools and NodeExecutionEnv |
| Additional built-ins | Selectable `grep`, `find`, `ls`, Windows `powershell` | Four default tools only; use shell commands or trusted extensions for more |
| Tool selection | Settings, `--tools`, `--exclude-tools`, `--no-tools`, SDK controls | No selection CLI or read-only preset. Extension authors can use Durable's agent filters and extensions |
| Tool contracts | Pi tool API, result/content schemas, hooks and renderers | Durable output/details/diagnostics, hooks and replay contracts; matching tool names do not make implementations interchangeable |
| Edit display | Pi's built-in/custom tool renderers | Successful stock edits show committed `details.patch`/`details.diff`, with colored additions/deletions; no speculative patch |
| Idle Enter | Sends input | Accepts visible completion first; otherwise sends input or runs a slash command |
| Busy input | Enter steers; Alt+Enter follows up; Alt+Up retrieves queued messages | Ordinary Enter keeps the draft; `/steer text` and `/followup text` admit input to Durable's persisted inbox |
| Queue/cancel | Runtime queues; abort returns queued input to the editor | `/queue`, `/withdraw [id]`, `/interrupt`. Interrupt withdraws queued inputs and cancels foreground work, without returning the queue to the editor, undoing effects or stopping background work |
| Newlines | Shift+Enter; Alt+Enter is a follow-up action | Alt+Enter, supported Shift+Enter or Ctrl+J |
| Ctrl+C | Clear editor first / exit on a subsequent press, subject to native selection behavior | Copy active selection; otherwise cancel a local command/dialog or close. Does not clear the editor first |
| Completion/attachments | Commands, file paths, `@` file search, image paste/drag and CLI `@files` | Commands, skills, exact catalog model IDs and supported reasoning levels; no repository indexing, attachment expansion or image-upload UI |
| Images | Input, resize and inline terminal display when supported | No upload or graphical renderer. Stock `read` can return supported in-limit images to a capable model; the display uses a placeholder. No image processor is installed |
| User shell input | `!command` includes output; `!!command` excludes it from model context | Neither shorthand runs a local command. Ask the agent to use `bash` or use another terminal |
| Editor integration | Configurable external editor and application shortcuts | pi-tui editing, history and paste; no external-editor action or keybindings file |
| Appearance | System/custom themes, regular or fullscreen mode, collapsible tools and thinking | Fullscreen, fixed black palette and sage/olive frames, with distinct user/answer/thinking/tool styles. No theme loader, collapse/hide toggle or Mermaid renderer |
| Thinking | Provider-exposed thinking, optionally hidden | Provider-exposed text shown inline from committed partials (about 200 ms) and retained on completion. Redacted blocks use placeholders; private reasoning and opaque signatures are not shown |
| Scrolling/search | Pi's terminal interaction and configuration | pi-tui scrolling, selection and search; no separate transcript index |
| Footer | Session/model/context/usage information and configuration | Activity, model, reasoning, context estimate and committed usage. OpenAI shows "subscription", not API dollars or remaining quota |

## Models, authentication and resources

| Area | pi 1.2.0 | pi-d |
| --- | --- | --- |
| Model defaults | User/project defaults, automatic selection and per-model thinking preferences | New-session default `openai-codex/gpt-6.1-sol`, literal `max`; saved settings survive resume. Entitlement depends on the provider |
| Model selection | Exact/fuzzy matching, globs, scopes/cycling, `:<thinking>` suffix | Exact `provider/model-id`, filterable `/model`, separate `--thinking` or `/reasoning`; no fuzzy CLI aliases, scopes/cycling or suffix syntax |
| Thinking validation | CLI thinking is clamped to model capabilities | Unsupported values are rejected. A different model clears the old setting unless explicitly supplied; the same model preserves it |
| Changing settings | Pi runtime's mutation rules | Model, reasoning, workspace, reset, session and logout changes refuse unfinished foreground or background work |
| Catalogs/providers | Built-in and refreshed catalogs, `models.json`, custom providers, virtual models and llama.cpp integration | Pinned pi-ai chat catalog; no refresh, `models.json`, custom-provider registration facade, virtual-model or llama.cpp management UI |
| Interactive login | Provider selection, API-key storage and supported OAuth flows | `/login` or `--login`: Codex/ChatGPT OAuth only, using pi-ai's fixed-client browser/device flow. No named-agent registration |
| OpenAI API access | API keys or supported subscription authentication | `openai` and `openai-codex` require subscription login; no `OPENAI_API_KEY` fallback, including after logout or failed refresh |
| Other providers | Stored credentials, environment and provider-supported ambient auth | pi-ai environment/ambient authentication; no API-key storage, other OAuth login UI or automatic Pi credential import |
| Credential location | Agent directory, normally `~/.pi/agent/auth.json` | XDG config `pi-d/auth.json` or `~/.config/pi-d/auth.json`; private plaintext files, atomic mutation and cross-process refresh locking |
| Configuration | User/project settings, themes, keybindings, SYSTEM/APPEND_SYSTEM files and environment controls | CLI flags, saved agent settings, AGENTS and skills. Does not read Pi settings/auth/history or `.pi/SYSTEM.md`/`APPEND_SYSTEM.md` |
| Resource opt-outs | `--no-context-files`, `--no-skills`, `--no-extensions` and related flags | `--no-extensions` skips automatic global extension loading but preserves explicit files. No instruction/skill discovery-disable flags |
| Coding prompt | Pi's standard prompt plus resource/runtime contributions | Adapted Pi 1.2.0 coding preamble, tool rules and skill wording, with pi-d identity and Durable guidance. Sections prepare before every request, including tool continuations and after compaction |
| AGENTS | Global/ancestor files, per-directory overrides, linked-worktree handling, explicit reload | Same filenames, override precedence and ancestor order, with a separate global directory. Rereads every preparation; no linked-worktree shadowing or subdirectory crawl |
| Skills | Agent Skills, conventional/configured/package roots and ignore-file filtering | YAML `name`/`description`/`disable-model-invocation`, lazy instructions and `/skill:name`. pi-d roots, shared `.agents`, workspace `.pi/skills` and repeatable `--skill`; no Pi package/glob/ignore-file system |
| Trust | Project trust gates most project settings/resources; not a sandbox or tool approval | No trust database/dialog. User-config extensions auto-load; project extensions require explicit trusted flags. Ancestor instructions and discovered skills load without a prompt and can steer full-access tools |

See [Usage and safety](usage.md) for discovery order, paths, authentication, recovery and commands. Reviewed Pi skill files can be reused, but Pi extensions and saved sessions are not portable to pi-d.

## Extensions, integrations and distribution

| Area | pi 1.2.0 | pi-d |
| --- | --- | --- |
| Extension format | Default factory receiving Pi's `ExtensionAPI` | Default-exported Durable `Extension` object with tools, sections, hooks, wrappers and tasks; optional `piD` host UI contributions. Pi factories do not work |
| Extension capabilities | Commands, shortcuts, CLI flags, UI/renderers/widgets, providers, events and session control | Durable registry contracts plus `piD` local commands, help/completion, UI-only labeled messages/top-left toasts and styled footer items. No arbitrary widgets, shortcuts, provider registration or Pi compatibility facade |
| Discovery/reload | Personal/project/configured/package extensions, trust gates and `/reload` | Global config `extensions/` discovery plus repeatable `--extension file`; `--no-extensions` opts out of discovery. No project auto-loading. jiti loads TS/JS with pinned host SDKs. Restart after code changes; keep trusted files available for recovery. Stored names never execute paths |
| Lifecycle | Session start/shutdown events and reload contracts | Cancellation and cleanup through invocation/task contexts; mounted footer subscriptions/callbacks abort and detach, and message/toast state and timers clear on session handoff/shutdown. No module-level shutdown callback or general lifecycle event facade |
| Packages/templates | npm/git Pi packages and parameterized Markdown prompt templates | No package installer, package configuration or template system. Skills/sections can supply instructions without template compatibility |
| MCP | Built-in stdio/HTTP connections, configuration, authentication and `/mcp` | No built-in client, configuration or UI; needs a trusted Durable integration |
| Codemode/tool search | Built-in extensions, initially inactive; can be enabled or activated by MCP | Neither is installed by pi-d. Durable has APIs for them; dependency presence does not enable them |
| Plan mode/subagents/browser | Not built-in; extensions/packages can provide these workflows | Not built-in. An [opt-in experimental extension](subagents.md) offers nonblocking native jobs, explicit per-worker skills/extensions, normal coding tools without worker execution budgets, no nesting, orchestrator-only steering/follow-up messages, model/local cancellation and footer progress. No browser, automatic worktree/merge workflow or subagent dashboard |
| Automation | Positional/piped prompts, print, JSON, RPC and public coding-agent SDK | Chat requires an interactive terminal. No one-shot/headless/JSON/RPC mode or public Pi-compatible host SDK; Durable itself is programmable |
| Export/share/import | HTML/JSONL export, sharing, JSONL import, copy/session diagnostics and bug-report tools | No archive export/import/share or bug-report uploader. Text selection and `/status` are local; SQLite stores are not Pi JSONL sessions |
| CLI/configuration utilities | `--version`, `--offline`, `pi config`, authentication diagnostics, `/settings`, `/hotkeys`, `/debug`, `/changelog` and `/quit` | `--help`, `--list-models`, `/status` and resource lists. No general settings/configuration, version, offline-policy, debug-export or quit command. Ctrl+C closes; only `--demo` guarantees scripted offline output |
| Maintenance/network | Installer/updater, package/catalog updates and configurable install telemetry | Checkout/local-package workflow; no host updater, background catalog refresh, session uploader or install-telemetry integration. Providers and extensions can still use the network |
| Platform/release | Documented macOS/Linux/Windows installation and broader distribution | Node 22.19+, POSIX Unicode terminal target. Offline macOS checks only; no Linux/Windows/Bun parity claim or public registry release |
| Licensing | Pi is MIT | Original application code: [MIT](../LICENSE). Adapted Pi wording retains MIT attribution; the btop palette attribution includes Apache-2.0 |

## Durable APIs not exposed by pi-d

Durable supports multiple, forked and owned conversations, manual compaction and handoff, custom storage/environments, codemode/tool search, extension reload, child/background tasks and custom state documents. Those APIs remain available to extension authors; pi-d does not provide terminal controls for all of them.

The QuickJS sandbox for codemode does not sandbox pi-d's normal tools or extensions. Cancellation and recovery do not roll back shell or filesystem effects.

## Moving between the applications

- Keep credentials and stores separate. There is no automatic import, migration or shared history.
- Review instruction and skill files before reuse, and check discovery differences. `--skill ~/.pi/agent/skills` does not load Pi's runtime or configuration.
- Rewrite Pi extensions against Durable's contracts; renaming the export is insufficient. See the [extension guide](extensions.md).
- Use `/session-new` for a separate conversation, `/reasoning` for thinking, and `/steer` or `/followup` while busy. `/new` keeps the current database.

Use pi for its extension ecosystem, automation interfaces or session-management features. Use pi-d for this terminal interface around Durable.

## Upstream references

Pi references are fixed to the comparison revision:

- [How Pi works](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/how-pi-works.md), [CLI](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/cli.md), [terminal usage](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/usage.md)
- [Sessions](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/sessions.md), [settings](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/settings.md), [configuration](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/configuration.md), [security](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/security.md)
- [Extensions](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/extensions.md), [skills](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/skills.md), [MCP](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/mcp.md)
- [Durable 1.2.0 API and behavior](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/durable/README.md)
