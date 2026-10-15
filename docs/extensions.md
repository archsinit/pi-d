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

In a checkout these paths are relative to pi-d, **not necessarily the conversation workspace**. npm may hoist dependencies in an installation; declarations belong to the installed SDK packages, not a fixed `pi-d-chat/node_modules` path. For a global install, find the package under `npm root -g`. The app's `src/coding.ts` and `test/coding.test.ts` are working examples in the source checkout; installations ship `dist/coding.js` and this guide instead. Built-in task definitions cannot be replaced. Extension names must be unique and may not replace `coding-tools` or `pi-d-prompt`.

## Loading and lifecycle

- jiti loads local TypeScript/JavaScript without a build step. The loader binds exported imports from the host's pinned `pi-durable`, `pi-ai`, `pi-tui`, `chord` and `typebox`, including exported subpaths. Extensions outside the checkout do not need their own copy of those SDKs. Other dependencies must be installed beside the extension.
- Installation and selection use the **unmodified stock registry**. Normal conversations use installed extensions by default; explicit native agent filters are respected. The host adds no parallel scheduler, session runtime or saved transcript.
- Restart after editing extension code. There is no hot reload, package installer, auto-discovery of executable project extensions, or Pi-style command/UI/provider registration facade. Durable's Extension format does not define app slash commands.
- Keep the same `--extension` arguments when recovering work. The native session document `pi-d.loaded-extensions` stores **names only**, not executable paths. If unfinished work lacks a previously loaded extension or a task definition, automatic recovery stays paused; `/status` identifies missing names and blocked tasks. Restart with the trusted files available in the global extensions directory or explicitly supplied. An idle reopen may deliberately omit extensions. This is a conservative readiness check, not a guarantee of code-version compatibility; older stores may not have recorded names.
- The startup registry loads the trusted global and explicit extensions once; session selection reads native metadata without starting a Harness or recovering tasks. Opening a selected session uses that registry, then checks authentication and recovery readiness. Stored names never cause module discovery or execution.
- Do not start unmanaged processes, sockets, watchers or timers at module scope. Use native task/tool contexts, honor `context.abortSignal`, and clean up your resources in their invocation. This host does not invent a shutdown callback for module-level resources.

## Trust and effects

**Extensions run inside pi-d with your full account permissions.** Loading a file executes its module code. Tools run on the host too, without a sandbox or a confirmation prompt per call. The saved workspace is only a default directory, not an access restriction. Instructions and skills can steer those tools; review unfamiliar resources or use an isolated account/container.

MCP connections, browser automation and multi-agent orchestration belong in explicitly trusted Durable extensions, not an additional host scheduler or Pi compatibility layer. The host does not provide them by default.

`/steer` and `/followup` use Durable's persisted inbox. `/interrupt` cancels foreground work and withdraws queued inputs, but does not stop native background tasks; extensions must manage those through native task APIs. No separate application queue is maintained.

Native cancellation is best-effort. File/shell effects can happen before cancellation or interruption, and a model may request them again. A native non-replay-safe tool interrupted during execution is reported as possibly partially run on recovery, not promised to be undone. No exactly-once external-effects guarantee.
