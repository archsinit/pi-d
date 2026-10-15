# Usage and safety

See the [README](../README.md) for setup and credits, or [pi-d and pi](comparison.md) for compatibility differences.

[Sessions](#session-files-and-workspaces) · [Authentication](#authentication) · [Models](#models-and-reasoning) · [Commands](#commands) · [Resources](#instructions-skills-and-extensions) · [Recovery](#durability-and-failure-limits) · [Verification](#verification)

## Permissions and sensitive data

**Tools and trusted extensions run with your account's permissions. There is no sandbox or per-call approval.** The saved workspace sets a default directory, not an access boundary. Absolute paths and symlinks can lead elsewhere. Instructions, skills, files and tool output can steer the model. Use an isolated account, container or VM for unfamiliar or unattended work.

Sessions can contain prompts, file contents, responses, tool arguments and command output. Keep them out of public repositories and keep live credentials out of screenshots. Private file modes do not encrypt data. pi-d has no keychain integration or shared/network-filesystem guarantee.

## Session files and workspaces

The data directory is `$XDG_DATA_HOME/pi-d` when `XDG_DATA_HOME` is absolute, otherwise `~/.local/share/pi-d`. Plain `pi-d` opens the shared `default.sqlite` there, regardless of the launch project.

```sh
pi-d --new-session --cwd /path/to/project
pi-d --resume --cwd /path/to/project
pi-d --session ./project.sqlite --cwd /path/to/project
```

`--session`, `--new-session` and `--resume` are mutually exclusive. Path rules:

- Relative `--session` paths resolve from the shell's launch directory, even with `--cwd`.
- Tool paths resolve from the saved workspace. Reopening elsewhere retains that workspace.
- New sessions use the launch directory or explicit `--cwd`. Older workspace-less stores are bound when opened.
- `--cwd` changes a saved workspace only when no work is unfinished. `/help` and `/status` show the full path.

The top-right header label identifies the workspace and database. Model and reasoning appear in the footer.

### Create, reset or resume

`--new-session` creates a UUID-named database under `sessions/<workspace-hash>/`. `/session-new [name]` does the same in chat, inheriting the current model, reasoning and workspace. The optional name becomes a sanitized filename label; it is not a renameable title.

`/new` and `/clear` reset active context in the current database. Stored history, settings and the newer draft remain.

`--resume` uses the launch/requested workspace; `/resume` uses the saved chat workspace. Discovery inspects at most the 200 most recently modified candidates across the managed/default layout, then filters by canonical saved workspace. It skips stores locked elsewhere but allows the current chat. Reading picker metadata does not start Harness recovery or make model requests. Use `--session path` for databases outside this layout or older stores without a workspace.

Switching sessions requires no unfinished tasks or submissions, including background and queued work. pi-d acquires the next store before releasing the old one and retains the newer draft. Opening the selected store can resume unfinished work after readiness checks and repeat model requests. Extension files still need explicit trusted flags.

### Permissions and backups

New directories and files are private (0700/0600); pi-d does not change existing session path permissions. Durable's SQLite adapter uses WAL, and pi-d sets `synchronous=FULL` through its public database API. Back up a closed store: copying only a live SQLite main file can omit its write-ahead log.

## Authentication

```sh
pi-d --login                 # standalone Codex/ChatGPT sign-in
pi-d                         # or use /login inside chat
pi-d --logout                # close other chats first
```

Login uses pi-ai 1.2.0's `openai-codex` OAuth flow and Pi's fixed client. It requires neither named-agent registration nor a new installation UUID.

1. Choose Browser login (Enter/default) or Device code (2 in standalone login; select in-app).
2. Open the browser link, or follow the device URL and enter its code.
3. Browser login uses callback port 1455. If that is unavailable, paste the authorization code/redirect URL into the local login prompt or dialog, never ordinary chat.

Cancel a pending login before starting another. Escape or Ctrl+C cancels an in-app dialog; Ctrl+C cancels standalone login. URLs, one-time codes and callback input are transient UI, not saved messages.

Login itself makes no model request. **Completing in-app login can resume paused work and consume quota, including repeated provider requests.** Without the required subscription login, chat remains open for local commands while recovery is paused and model-bound input is refused.

### Credential storage

Credentials live in `$XDG_CONFIG_HOME/pi-d/auth.json` when `XDG_CONFIG_HOME` is absolute, otherwise `~/.config/pi-d/auth.json`. Tokens are plaintext, with a private directory/file (0700/0600).

Mutations are serialized across processes, written to a private temporary file and atomically replaced. Malformed, exposed, symlinked or hard-linked files are rejected without printing or silently repairing them. pi-ai owns refresh. Once token rotation starts, persistence finishes even if the caller cancels. A crash or disk failure during exchange can require another login. A crashed writer's lock expires after five minutes; do not remove a live lock.

`/logout` requires an idle session and removes pi-d's `openai` and `openai-codex` entries. Once started, both removals finish even if cancelled. Close chats before using standalone `--logout`. Logout does not revoke server grants, erase backups, unset environment variables or stop already-admitted work. Revoke grants in ChatGPT settings when needed.

### Provider access

Both `openai` and `openai-codex` require subscription login. **Missing credentials, logout and refresh failure never fall back to `OPENAI_API_KEY`.** Other providers retain pi-ai environment/ambient authentication, such as `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`. pi-d saves no API keys, exposes no other OAuth flows and reads no Pi auth, configuration or history. Model access and subscription limits remain provider-controlled.

### Earlier OpenAI sessions

`openai` and `openai-codex` use different credentials and endpoints. Older credentials and metadata remain separate; pi-d never relabels or reuses them across providers or silently changes a saved model. To switch an idle older session without erasing history:

```sh
pi-d --model openai-codex/gpt-6.1-sol --thinking max
```

If unfinished old work blocks switching and cannot be stopped under its original credentials, keep that store closed and use a separate `--session ./codex.sqlite`. `/interrupt` can stop paused foreground recovery, but background work has separate ownership and cancellation rules.

## Models and reasoning

New sessions default to `openai-codex/gpt-6.1-sol` and literal `max` reasoning in the pinned 1.2.0 catalog. The Codex payload maps this to `reasoning.effort: "max"`, not `xhigh`. Account entitlement still needs live verification.

```sh
pi-d --list-models
pi-d --model openai-codex/gpt-6.1-sol --thinking max
pi-d --session ./notes.sqlite --model anthropic/claude-opus-4-7
```

Durable stores the model and thinking level in its agent document. Omit overrides on resume to retain them. Level names are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; each model supports only some of them. Unsupported values are rejected.

`/model` opens a filterable list; `/reasoning` lists supported levels. Both accept exact arguments. Choosing the same model preserves reasoning. A different model clears the previous setting unless `--thinking` is supplied at startup. Changes require no unfinished foreground or background work.

## Commands

| Command | Action |
| --- | --- |
| `/help` | Commands and saved workspace |
| `/status` | Local session, model, authentication, context and recovery diagnostics |
| `/session-new [name]`, `/resume` | Create a separate session / choose one for the saved workspace |
| `/new`, `/clear` | Reset active context; keep stored history, settings and the newer draft |
| `/model [provider/id]` | Choose from a filterable list or set an exact catalog ID |
| `/reasoning [level]` | Choose a supported thinking level; reject unsupported values |
| `/login`, `/logout` | ChatGPT sign-in / local credential removal |
| `/steer text` | Guide the current run after its tool round; send normally if idle |
| `/followup text` | Queue input after the current run; send normally if idle |
| `/queue`, `/withdraw [id]` | Inspect the persisted inbox / withdraw a still-queued input |
| `/interrupt` | Cancel foreground work and withdraw queued inputs |
| `/skills`, `/skill:name [request]` | List skills / load full instructions as model input |
| `/extensions` | List selected Durable extensions and tools |
| `/notifications` | Inspect and dismiss active/queued UI notifications (not the Durable inbox) |

Commands are local except `/skill:name`, `/steer` and `/followup`, which admit model input. Selected extensions may add local commands through the `piD` adapter; `/help` includes them. Their return values never automatically become model input. Login and opening a session can also resume existing work. Read-only commands remain available during work. Reset, settings, session and logout changes require no unfinished foreground or background work. `/login` can connect a paused unauthenticated session but refuses actively running work.

Use `//something` to send `/something` literally. `!` and `!!` have no local-shell meaning.

### Input and cancellation

Ordinary Enter while busy keeps the draft. `/steer text` joins the current run after its tool round; `/followup text` starts another run after it completes. Both send normally when idle. They use Durable's persisted inbox, with no app-owned queue. `/withdraw [id]` removes a still-queued input without interrupting one already placed.

`/interrupt`, or Escape when no completion or dialog handles it, requests foreground cancellation and withdraws queued inputs. **Cancellation does not pause work for later or undo effects.** Background tasks and existing file/shell changes remain. Closing the app instead leaves unfinished work recoverable on reopen.

Failed or cancelled admission restores input without discarding a newer draft. An admitted input is not restored as a duplicate just because its provider fails.

### Keyboard and mouse

| Key | Action |
| --- | --- |
| Enter | Accept visible completion; otherwise send when idle or run a slash command. Busy ordinary Enter keeps the draft |
| Tab | Complete commands, skills, model IDs and supported reasoning levels |
| Alt+Enter / Shift+Enter / Ctrl+J | New line; Shift+Enter depends on terminal support |
| Escape | Dismiss completion/dialog first; otherwise cancel foreground work. Background work continues |
| Ctrl+C | Copy active selection; otherwise cancel a local command/dialog or close |
| PgUp/PgDn / mouse wheel | Scroll the conversation; PgUp/PgDn also scroll dialog text |
| Ctrl+Home / Ctrl+End | Top / latest; latest restores follow-output |
| Ctrl+Shift+F | Search, in terminals that distinguish these modifiers |
| Up/Down | Editor navigation / current-run prompt history |

Completion includes explicit-only skills. It does not crawl files, expand attachments or make model requests. An 80×24 or larger terminal is recommended; layouts are tested down to 40×16.

### Notifications (UI-only)

`/notifications` opens a keyboard inspector, including an empty state when nothing is pending. It works during generation and without login. The list distinguishes the active top-left card from queued notifications and shows the selected notification's source, type and wrapped plain text.

| Key in the inspector | Action |
| --- | --- |
| Up / Down | Select a notification |
| PgUp / PgDn, Home / End | Scroll the selected content / jump to its beginning or end |
| `d` / Delete | Dismiss the selected notification |
| Ctrl+D | Dismiss all pending notifications |
| Enter | Close without dismissing; restore composer focus and any newer draft |
| Escape / Ctrl+C | Cancel the inspector using normal command-draft restoration, not interrupt generation (Ctrl+C still copies an active selection first) |

Arrivals, expiry and mouse/keyboard dismissal update the same queue. Inspection neither consumes queued items nor starts/resets their lifetime; the active timer keeps running. If the selected item disappears, selection clears: choose another before dismissing again. Outside the inspector, cards remain focus-free, with mouse **×** dismissal, wheel scrolling and automatic expiry (five seconds by default; extensions can disable expiry).

Only pending UI state is retained: at most **100 notifications**, including the active one. Overflow discards the oldest queued item, not the active card or its timer. Each sanitized body is limited to **64 KiB UTF-8**, with a truncation marker, and its source label to **512 bytes**. Long content within those limits is scrollable. There is no dismissed/expired history. Notifications and inspection never enter model prompts, transcripts or Durable execution state. Session handoff/shutdown clears the queue, timers and inspector; reopening does not restore them. `/new` and `/clear` keep presentation in the same mount.

## Instructions, skills and extensions

Normal sessions install Durable's stock CodingTools (`read`, `bash`, `edit`, `write`) and NodeExecutionEnv. Durable handles matching, mutation queues, output limits, shell cancellation and interrupted tools. pi-d displays calls, arguments, results, failures and running output. Successful edits show committed unified patches when `details.patch`/`details.diff` is available. Display styling stays out of model context. A tool may change files before it fails or is cancelled; shutdown does not undo those changes.

System sections adapt Pi 1.2.0's coding preamble, tool rules and skill wording, with pi-d identity and Durable guidance. They prepare before each request, including tool continuations, reset and after compaction. They are not saved as repeated user messages.

### AGENTS discovery

pi-d reads global instructions from its config directory, then ancestor files from the filesystem root to the saved workspace. In each directory, the first existing file wins:

1. `AGENTS.override.md`
2. `AGENTS.md`
3. `AGENTS.MD`
4. `CLAUDE.md`
5. `CLAUDE.MD`

Symlink aliases are deduplicated. Files are reread on each preparation, so edits and deletions affect later requests. The prompt tells the agent to read more-specific instructions before working below the workspace; pi-d does not crawl those subdirectories or implement Pi's linked-worktree/configuration system. A section-render error is reported and may leave the prior section in place until refresh succeeds.

### Skill discovery

Roots are visited in this order:

1. pi-d's config directory `skills/`
2. `~/.agents/skills`
3. Workspace `.pi-d/skills`
4. Workspace `.pi/skills`
5. Workspace/ancestor `.agents/skills`, stopping at the repository root when present
6. Explicit repeatable `--skill` paths

YAML frontmatter accepts `name`, `description` and optional boolean `disable-model-invocation`. Names use lowercase alphanumerics/hyphens, up to 64 characters; required descriptions allow up to 1024 characters. Invalid entries produce diagnostics without exposing file contents. The first discovered name wins, so explicit paths do not override earlier entries.

A directory containing `SKILL.md` stops descent into its children. Discovery supports nested directories, standalone Markdown, symlinks and cycle protection, while skipping hidden directories and `node_modules`. It does not use Pi's package, glob or ignore-file system.

System context advertises names, descriptions and paths. Full instructions load only when read or invoked. Explicit-only skills are omitted from that advertisement but remain available through `/skill:name [request]`, which loads them as one user input. `/skills` lists entries and diagnostics.

```sh
pi-d --skill ./my-skills
pi-d --skill ~/.pi/agent/skills  # explicit reuse, not Pi config/runtime loading
pi-d --extension ./trusted-extension.ts
```

Relative `--skill` and `--extension` paths resolve from the shell's launch directory, not the saved workspace or `--cwd`. Use absolute paths when reopening from elsewhere. Normal instruction/skill discovery has no disable flags or project-trust prompt; `--no-extensions` disables automatic executable-extension discovery only.

### Durable extensions

Normal chat startup automatically loads trusted extensions from `~/.config/pi-d/extensions/`, or `$XDG_CONFIG_HOME/pi-d/extensions/` when the XDG base is absolute. Top-level `.ts`, `.js`, `.mjs` and `.cjs` files are loaded in name order. Child directories load the first entry point among `index.ts`, `index.js`, `index.mjs`, `index.cjs`. Hidden entries, `.d.ts`, `node_modules` and deeper directories are not scanned. Symlinks are supported. Project extension directories and `~/.pi/agent` are never auto-loaded.

See the [extension guide](extensions.md) for complete examples and discovery rules. Files must default-export named Durable Extension objects; Pi factories do not work. Placing code in the global extensions directory trusts it to execute with full account permissions. Tools, sections, hooks, wrappers and tasks use the unchanged registry. Optional `piD` contributions add local slash commands (with help/completion), UI-only labeled scrollback messages, top-left notifications and styled footer status; settings remain extension-owned native Durable documents. Names must be unique and cannot replace `coding-tools` or `pi-d-prompt`; extension commands cannot shadow built-ins or each other.

`--extension` is repeatable and adds files after global entries. Canonical file paths are deduplicated before loading. `--no-extensions` skips automatic discovery but still loads explicit `--extension` files. Help, model listing, login/logout and the offline demo never load extensions. Invalid discovered extensions fail startup rather than being silently ignored.

Restart after code changes and keep the same trusted files globally available or explicitly supplied for recovery. The `pi-d.loaded-extensions` document stores names, never executable paths. Missing prior extensions or task definitions keeps unfinished work paused; `/status` identifies them. An idle reopen can omit extensions. Names do not prove code-version compatibility, and older stores may not record them.

pi-d supplies no executable project-extension discovery, package installer, hot reload, Pi compatibility facade, arbitrary widgets/provider registration or module-level shutdown callback. The [local command/footer API](extensions.md#local-commands-and-footer-status) is a small presentation adapter around native Durable handles. Footer subscriptions, local message blocks and notification queues/timers are owned by the mounted session and cleaned up on handoff/shutdown. Command `message(text, { type? })` and `toast(text, { type?, timeoutMs? })` never change model context or saved history; `notify(text)` retains its bottom-bar behavior. Toasts default to five seconds, or use `timeoutMs: 0` to disable expiry. Click **×**, or use [the `/notifications` keyboard inspector](#notifications-ui-only), to dismiss them. See [command presentation](extensions.md#command-presentation) for styling, copy/scroll behavior and lifetimes. Manage resources inside invocations, honor cancellation, and avoid unmanaged processes, sockets, watchers or timers at module scope.

## Durability and failure limits

The native store is authoritative. The Harness, registry and built-in tasks run unchanged; pi-d has no second transcript, task engine or retry loop.

### Compaction and history

Automatic/background compaction uses upstream defaults: reserve 16,384 response tokens, retain about 20,000 recent tokens and start summarization 32,768 tokens below the blocking threshold (`contextWindow - reserveTokens`). Background compaction leaves the composer available, and ordinary Escape does not cancel it. There is no manual `/compact` command.

The display follows active context. Reset and compaction keep earlier stored entries, but there is no archive browser or export. The picker selects databases, not hidden messages.

### Recovery and ownership

Reopening can repeat interrupted provider requests after authentication and extension checks. **Model requests and external effects are not exactly-once, and host-power-loss recovery is not guaranteed.** Interrupted non-replay-safe tools may already have changed files; recovery need not rerun them for a later model call to request the same action again.

A canonical-path `proper-lockfile` lock excludes cooperating local pi-d processes. Symlink aliases share the lock; hard links are rejected. A crashed owner's lock expires after five minutes. Do not remove a live lock. Ownership loss restores the terminal and exits without further storage writes. This advisory heartbeat lock does not fence stalled machines, shared/network disks or writers that ignore it.

Storage or observation failure disables submission until reopen. Provider failure is shown separately from success. Closing waits for native shutdown and releases ownership; extensions that ignore cancellation can delay it.

Durable's API is experimental. Dependencies and `npm-shrinkwrap.json` are pinned; upgrades need API and dependency review.

## Display details

The interface has black backgrounds, sage/olive frames, cyan user labels, bright answers, indented muted thinking and violet tool headers (red for failures). User/answer bodies use the available width; thinking and tools wrap inside their indentation. There is no collapse/hide toggle. Provider-exposed thinking appears inline; private reasoning and opaque signatures are not shown. Redacted blocks use placeholders.

The footer's `ctx ~tokens/limit (%)` estimates active context plus committed live partials against the catalog window. Narrow terminals show a shorter percentage. It falls after reset/compaction and does not measure subscription quota or cumulative usage. Separate input/output totals and API cost estimates (`~$`) come from Durable's committed usage ledger. OpenAI shows "subscription", not an API bill or remaining limits. Notices may temporarily replace status fields.

Activity animates at 10 Hz while work or a local command is active; `--no-animation` disables motion. Truecolor falls back to 256 colors. Your terminal/profile supplies the font and size, as with btop. The README's SVG preview requests Menlo, DejaVu Sans Mono, then generic monospace, so it may differ from your terminal.

The README preview captures the actual renderer through a headless terminal emulator with scripted responses, not a live provider. Graphical image components are not enabled. There is no image-upload UI. Stock `read` can return supported in-limit images to a capable model; the transcript shows a placeholder.

## Install a local package

Requires Node.js 22.19+ and npm. From a checkout with dependencies installed (`npm ci --ignore-scripts`):

```sh
mkdir -p artifacts
npm pack --pack-destination artifacts
npm install --global --prefix "$HOME/.local" --ignore-scripts ./artifacts/pi-d-chat-0.1.0.tgz
```

`npm pack` compiles JavaScript through `prepack`. Installed users need no TypeScript compiler or install-time scripts. `npm-shrinkwrap.json` pins the dependency graph. Add `~/.local/bin` to PATH and check with `pi-d --help`; do not overwrite an existing launcher blindly.

This is a local installation candidate, not a public npm release. `private: true` disables npm publishing. GitHub publication is separate; npm distribution would need a package-name and ownership decision. The original application code uses the [MIT License](../LICENSE). Adapted upstream material retains its own notices and licenses.

## Verification

The offline suite uses the Harness, faux providers, temporary workspaces/stores and mocked OAuth endpoints/socket binding. It covers tool execution, committed streaming/thinking, cancellation, persisted queue/recovery, compaction/AGENTS refresh, resource discovery, external TypeScript extensions, UI-only messages/toasts and `/notifications` (keyboard inspection/dismissal, bounded retention, live queue synchronization, copy/focus, timeouts, cancellation and cleanup with zero model/context/storage effects), sparse/malformed footer isolation, session handoff, credential persistence, browser/device flows, storage failure, context/diff display, Unicode, resizing, search and terminal cleanup. The Codex payload test stops before network access.

`npm run smoke` uses a real offline POSIX PTY. `npm run test:package` builds and checks exact package contents, reviewed dependency versions, isolated cached local/global-prefix installs, SQLite admission, external extensions and real PTYs. It neither replaces the user's command nor uses a live session. Run `npm ci --ignore-scripts` first to populate npm's hydration cache. These offline checks are not a final-release sign-off.

Release verification still needs live browser/device approval, provider access and quota checks, real model/tool/skill/extension runs and live compaction. Current offline checks run on macOS. They do not establish Linux, ARM, Windows/Bun, shared-disk or host-power-loss behavior, or performance with very large workspaces, histories and resource collections.
