# Durable extensions in pi-d

Normal chat startup automatically loads trusted extensions from **`~/.config/pi-d/extensions/`**, or **`$XDG_CONFIG_HOME/pi-d/extensions/`** when `XDG_CONFIG_HOME` is absolute. This works from any launch directory; `~/.pi-d/agent` and Pi's `~/.pi/agent` are not searched.

For example, place a file at `~/.config/pi-d/extensions/helper.ts`, or keep a complete extension in `~/.config/pi-d/extensions/my-extension/index.mjs`. If creating the config directory manually, keep it private (`0700`), as required by the credential store; for the default location:

```sh
install -d -m 700 ~/.config/pi-d
mkdir -p ~/.config/pi-d/extensions
```

Files must default-export a **Durable Extension object**, usually made with `defineExtension()`. Pi `ExtensionAPI` factories do not work here. No compatibility runtime is installed. `/extensions` shows the current conversation's selected extensions and tools.

Add other explicitly trusted files, or disable automatic discovery:

```sh
pi-d --extension ./workspace-extension.ts  # Repeat for more files
pi-d --no-extensions                     # Skip the global extensions directory
pi-d --no-extensions --extension ./only-this.ts
```

### Discovery rules

- Only the user-controlled config directory is searched, never project or ancestor extension directories. Placing code there is an explicit trust decision: it executes with full account permissions on normal chat startup.
- Entries are sorted by name. Top-level `.ts`, `.js`, `.mjs` and `.cjs` files are loaded; `.d.ts`, hidden entries and `node_modules` are skipped.
- A child directory loads one entry point: the first regular file among `index.ts`, `index.js`, `index.mjs`, `index.cjs`, in that order. There is no recursive scanning or package-manifest entry resolution. Keep helper modules inside the extension directory, not as top-level extension files.
- Symlinked files/directories are supported. Global paths load first, then explicit `--extension` arguments in order. Real paths are deduplicated, including symlinks and repeated explicit arguments, before loading, so an explicitly supplied global extension is not loaded twice. Different files exporting the same extension name still fail; there is no silent override.
- Missing global directories and dangling discovered symlinks are ignored. Unreadable directories, invalid exports and extension import errors fail startup; `--no-extensions` bypasses global discovery without disabling explicit files. Missing explicit files remain errors.
- `--help`, `--list-models`, `--login`, `--logout` and `--demo` do not discover or load extensions. Startup does not create the global directory or install code for you.

## Optional subagents

The experimental `pi-d-chat/subagents` export supplies a normal Durable extension with native background jobs, explicit per-worker skill/extension assignment, non-nesting owned workers with normal coding tools and no extension execution budgets, orchestrator-only native inbox messaging, model/local cancellation, inspection and footer progress. All parent-selected extensions are eligible when explicitly assigned; child conversations stay headless, so their `piD` UI adapters are not mounted or invoked. It is **not automatically installed or loaded**. Prefer its separate HOME/XDG/session/workspace launch helper when experimenting; see [Subagents](subagents.md) for opt-in loading, nonblocking coordinator control, ownership/recovery semantics and non-sandbox limitations.

## Small complete example

```ts
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

export default defineExtension({
  name: "workspace-helper",
  sections: [
    section("workspace_rules", () => "Inspect files before proposing changes."),
  ],
  tools: [
    defineTool({
      name: "workspace_directory",
      description: "Report this conversation's working directory",
      parameters: Type.Object({}),
      async execute(_args, api) {
        return { output: [{ type: "text", text: api.env?.cwd ?? "No workspace" }] };
      },
    }),
  ],
});
```

The stock registry also accepts native `hooks`, `wraps` and `tasks`. `hook(GenerationTask, handlers)` attaches to native generation hooks; `hook(ToolTask, handlers)` attaches to tools. Use the pinned public declarations for the actual contracts:

- `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts`: extensions, tools, sections, runtime APIs.
- `node_modules/@earendil-works/pi-durable/dist/harness/generation.d.ts`: generation hooks.
- `node_modules/@earendil-works/pi-durable/dist/harness/tool.d.ts`: tool hooks.
- `node_modules/@earendil-works/pi-durable/README.md`: native API overview.

## Local commands and footer status

pi-d also accepts an optional **`piD`** field on a Durable extension object. This is a small host UI adapter, not Pi's `ExtensionAPI` and not a replacement for Durable's registry. Existing extensions need no changes. Use the typed identity helper from **`pi-d-chat/extensions`**, supplied by the loader even when the extension lives outside the installation:

```ts
import { defineChatExtension } from "pi-d-chat/extensions";
import { defineDoc } from "@earendil-works/pi-durable";

const Label = defineDoc<{ text: string }>({
  kind: "session-label.text", version: 1, scope: "session",
  initial: () => ({ text: "" }),
});

export default defineChatExtension({
  name: "session-label",
  piD: {
    commands: [{
      name: "label",
      description: "Set a session footer label; no text clears it",
      argumentHint: "[text]",
      async execute(argument, api) {
        await api.harness.commit(async (tx) => {
          (await tx.doc(Label)).text = argument;
        }, api.context);
        api.notify(argument ? "Session label set." : "Session label cleared.");
      },
    }],
    async footer(api) {
      const text = (await api.harness.snapshot(Label, api.context))?.text;
      return text ? [{ text, tone: "cyan" }] : [];
    },
  },
});
```

`defineChatExtension()` accepts the same native `tools`, `sections`, `hooks`, `wraps` and `tasks` as Durable's `defineExtension()`. It only adds types for `piD`; the returned object still installs directly into the stock registry. JavaScript can instead export a plain named object with the same shape. Other Durable hosts ignore the optional field.

### Command contract

- `piD.commands` is an array of `{ name, description, argumentHint?, complete?, execute }`. Names must match `[a-z][a-z0-9_-]*`, without `/`. Built-ins, duplicate names within/across installed extensions and invalid declarations fail startup. The `skill:` namespace is unavailable to extensions; there is no shadowing or load-order winner.
- Only the current conversation's **natively selected** extensions contribute commands, help entries and completions. `/help` includes them and `/extensions` lists their commands/footer capability.
- `execute(argument, api)` receives trimmed arguments and a context with `harness`, `conversation`, `signal`, an abort-aware native Chord `context`, and the host-owned `notify()`, `message()` and `toast()` presentation methods described below. Use the native handles for committed state, not sidecar session files or a second scheduler. Session-scoped documents persist across reopen and `/new`, but are independent in a different session file.
- Commands work locally while a model is running or authentication/recovery is paused. No input or callback return value is automatically sent to the model or saved as a chat entry. `//command` still sends literal slash-prefixed text. Callbacks have full account/native API permissions; this is not an effects sandbox. Enforce idle-only requirements yourself if your command needs them.
- Optional `complete(prefix, api)` receives the same native context, without `notify`, `message` or `toast`, and returns `{ value, label, description? }[]` or `null`, synchronously or asynchronously. For example: `complete: (prefix) => ["on", "off"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }))`. Completion text is sanitized, failures are contained, and cancelled results are discarded.
- Escape/Ctrl+C cancels an active command. Honor `api.signal`/`api.context`, release invocation resources in `finally`, and finish promptly: shutdown joins an in-flight command. A thrown command error restores its draft; cancellation does not undo effects already committed.

### Command presentation

All three methods return `void`, accept **plain text**, and strip terminal controls. They are available only inside `piD.commands[].execute`, not native tools, footer providers or completions.

| API | Presentation and lifetime |
| --- | --- |
| `api.notify(text)` | Existing one-line bottom-bar notice, unchanged. The next submission clears it. |
| `api.message(text, options?)` | Wrapped scrollback block headed **Extension · type · extension-name /command**, never an assistant answer. Anchored after the latest committed transcript entry; subsequent streaming, commits, compaction and context reset do not erase it. |
| `api.toast(text, options?)` | Compact bordered card at the top-left, outside the chat scroll region. Never takes keyboard focus. Click **×** to dismiss; mouse-wheel over long text to read the rest. `/notifications` offers keyboard inspection/dismissal. |

Both new APIs accept `{ type?: "info" | "success" | "error" }`; the default is `"info"`. Toasts additionally accept `{ timeoutMs?: number }`: the default is **5000**, and **0** disables expiry. Timeouts must be finite, non-negative and at most 2147483647 ms. Notifications are queued in call order, one card at a time; each timeout starts when its card reaches the front. A persistent card holds later cards until dismissed. Cards use at most 64 columns and about a third of the screen height; on terminals shorter than ten rows they are temporarily hidden to preserve the composer.

`/notifications` inspects the **same pending queue**, with active/queued labels, source/type, wrapped content and an empty state. Up/Down selects; PgUp/PgDn and Home/End scroll selected content; `d`/Delete dismisses selected; Ctrl+D dismisses all; Enter closes without dismissing. Escape/Ctrl+C cancels the inspector using normal command-draft restoration, without interrupting generation. Arrivals and removals synchronize live; a removed selection is cleared rather than silently pointing at another notification. Inspection never consumes a queued item, starts its timer, or pauses/resets the active timer.

Pending UI state is bounded to **100 notifications**, including the active card. Overflow drops the oldest queued item while preserving the active card and its lifetime. Sanitized notification bodies are truncated, with a marker, to **64 KiB UTF-8**; source labels to **512 bytes**. These bounds apply only to notifications, not `message()` blocks. There is no dismissed/expired history.

For example, this is a complete stock Durable extension with only optional `piD` UI contributions:

```ts
import { defineChatExtension } from "pi-d-chat/extensions";

export default defineChatExtension({
  name: "build-links",
  piD: {
    commands: [{
      name: "build-link",
      description: "Display a build link locally, without asking the model",
      argumentHint: "[url]",
      execute(argument, api) {
        const url = argument || "https://example.invalid/build/42";
        api.message(`Build details:\n${url}`, { type: "info" });
        api.toast(`Build ready: ${url}`, { type: "success", timeoutMs: 0 });
        // Omit timeoutMs for the usual five-second notification.
      },
    }],
  },
});
```

Messages and notifications accepted during a command **remain after its handler returns**. Calls retained beyond handler completion, a thrown error or cancellation are ignored, including calls made during cancellation cleanup. Already displayed output is not rolled back on failure/cancellation. Do not keep an invocation open just to keep a URL visible, or create your own UI timers.

These methods are **UI-only**: no model calls, authentication preflight, model-context changes, fabricated Durable entries/documents, saved transcript or separate database. Labels, text and URLs are selectable/copyable using native selection (including Ctrl+C to copy); typing, completion, Escape cancellation, dialogs and chat scrolling keep their usual behavior. Messages scroll with chat; toasts stay at the top-left. Presentation is owned by the mounted session: switching session files or shutting down drops all blocks, queued cards and timers, closes the notification inspector and releases its subscription/focus. Reopening does not restore them. `/new` and `/clear` reset model context in the same mount, so its local presentation remains. Extensions still have full native/account permissions and can explicitly perform other effects through their native handles.

The exported `ExtensionMessageType`, `ExtensionMessageOptions` and `ExtensionToastOptions` types describe these options; `ChatCommandContext` includes the three methods.

### Footer contract

- `piD.footer(api)` returns an array of **`FooterStatus`** objects, or `undefined` to contribute nothing. It receives `harness`, `conversation`, `signal` and the abort-aware native `context`. Read committed state with `snapshot()`; a missing document should be treated as your default without creating it.
- Each item has plain `text`, optional `tone` (`text`, `muted`, `dim`, `green`, `cyan`, `gold`, `red`, `violet`), `bold` and `strikethrough`. The host strips terminal controls, flattens whitespace, and clips the shared contribution area to at most one third of the footer. Short items survive long model names and remain visible beside notices; normal activity, reasoning and usage remain host-owned. There is no raw ANSI, complete-footer replacement or arbitrary widget access.
- Callbacks run asynchronously **outside Durable's mutation line**, initially on mount, after native commits (including custom session documents), and after local commands. Refreshes are serialized and coalesced. Keep callbacks read-only, fast and free of effects: writing state here can cause a refresh loop. They may run often during streaming; there is no polling timer.
- Providers follow native extension-selection order; items follow their returned order. Deselection clears their items on the next refresh. A failed/invalid provider loses only its own items and reports a generic failure notice without exposing its error body; it does not stop the chat or other providers. Results must be dense arrays: holes, malformed entries and throwing field accessors reject that provider's entire contribution. The host copies and normalizes known fields inside the provider's error boundary before rendering; provider objects/iterators never reach the renderer.
- Each mounted session owns its commit subscription and cancellation signal. Switching sessions or closing detaches it, aborts callbacks, ignores late results and joins in-flight work before closing the Harness. Honor cancellation; an uncooperative callback can delay that cleanup. No UI callbacks run in headless native task recovery, or while a session is only being listed.

The public TypeScript contracts are shipped at `pi-d-chat/extensions`. This initial UI API deliberately does not add arbitrary dialogs, shortcuts, provider registration, lifecycle events, hot reload or a Pi compatibility runtime.

## SDK locations

In a checkout these paths are relative to pi-d, **not necessarily the conversation workspace**. npm may hoist dependencies in an installation; declarations belong to the installed SDK packages, not a fixed `pi-d-chat/node_modules` path. For a global install, find the package under `npm root -g`. The app's `src/coding.ts` and `test/coding.test.ts` are working examples in the source checkout; installations ship `dist/coding.js` and this guide instead. Built-in task definitions cannot be replaced. Extension names must be unique and may not replace `coding-tools` or `pi-d-prompt`.

## Loading and lifecycle

- jiti loads local TypeScript/JavaScript without a build step. The loader binds exported imports from the host's pinned `pi-durable`, `pi-ai`, `pi-tui`, `chord` and `typebox`, including exported subpaths. Extensions outside the checkout do not need their own copy of those SDKs. Other dependencies must be installed beside the extension.
- Installation and selection use the **unmodified stock registry**. Normal conversations use installed extensions by default; explicit native agent filters are respected. The host adds no parallel scheduler, session runtime or saved transcript.
- Restart after editing extension code. There is no hot reload, package installer, auto-discovery of executable project extensions, or Pi-style command/UI/provider registration facade. App commands/footer contributions use the optional `piD` adapter above; native Durable alone does not define them.
- Keep the same `--extension` arguments when recovering work. The native session document `pi-d.loaded-extensions` stores **names only**, not executable paths. If unfinished work lacks a previously loaded extension or a task definition, automatic recovery stays paused; `/status` identifies missing names and blocked tasks. Restart with the trusted files available in the global extensions directory or explicitly supplied. An idle reopen may deliberately omit extensions. This is a conservative readiness check, not a guarantee of code-version compatibility; older stores may not have recorded names.
- The startup registry loads the trusted global and explicit extensions once; session selection reads native metadata without starting a Harness or recovering tasks. Opening a selected session uses that registry, then checks authentication and recovery readiness. Stored names never cause module discovery or execution.
- Do not start unmanaged processes, sockets, watchers or timers at module scope. Use native task/tool or local command contexts, honor `context.abortSignal`, and clean up your resources in their invocation. Footer callbacks are read-only and host-managed. There is no shutdown callback for module-level resources.

## Trust and effects

**Extensions run inside pi-d with your full account permissions.** Loading a file executes its module code. Tools run on the host too, without a sandbox or a confirmation prompt per call. The saved workspace is only a default directory, not an access restriction. Instructions and skills can steer those tools; review unfamiliar resources or use an isolated account/container.

MCP connections, browser automation and multi-agent orchestration belong in explicitly trusted Durable extensions, not an additional host scheduler or Pi compatibility layer. The host does not provide them by default.

`/steer` and `/followup` use Durable's persisted inbox. `/interrupt` cancels foreground work and withdraws queued inputs, but does not stop native background tasks; extensions must manage those through native task APIs. No separate application queue is maintained.

Native cancellation is best-effort. File/shell effects can happen before cancellation or interruption, and a model may request them again. A native non-replay-safe tool interrupted during execution is reported as possibly partially run on recovery, not promised to be undone. No exactly-once external-effects guarantee.
