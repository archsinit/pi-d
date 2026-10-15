# Durable extensions in pi-d

Load an explicitly trusted local file:

```sh
pi-d --extension ./workspace-extension.ts
# Repeat --extension for more files. Pass the same files when reopening a session.
```

The file must default-export a **Durable Extension object**, usually made with `defineExtension()`. Pi `ExtensionAPI` factories do not work here. No compatibility runtime is installed. `/extensions` shows the current conversation's selected extensions and tools.

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
- Keep the same `--extension` arguments when recovering work. The native session document `pi-d.loaded-extensions` stores **names only**, not executable paths. If unfinished work lacks a previously loaded extension or a task definition, automatic recovery stays paused; `/status` identifies missing names and blocked tasks. Restart with the trusted files explicitly supplied. An idle reopen may deliberately omit extensions. This is a conservative readiness check, not a guarantee of code-version compatibility; older stores may not have recorded names.
- Session selection reads native metadata without starting a Harness or recovering tasks. Actually opening a selected session installs only the explicitly supplied extensions, then checks authentication and recovery readiness. Stored names never cause module discovery or execution.
- Do not start unmanaged processes, sockets, watchers or timers at module scope. Use native task/tool contexts, honor `context.abortSignal`, and clean up your resources in their invocation. This host does not invent a shutdown callback for module-level resources.

## Trust and effects

**Extensions run inside pi-d with your full account permissions.** Loading a file executes its module code. Tools run on the host too, without a sandbox or a confirmation prompt per call. The saved workspace is only a default directory, not an access restriction. Instructions and skills can steer those tools; review unfamiliar resources or use an isolated account/container.

MCP connections, browser automation and multi-agent orchestration belong in explicitly trusted Durable extensions, not an additional host scheduler or Pi compatibility layer. The host does not provide them by default.

`/steer` and `/followup` use Durable's persisted inbox. `/interrupt` cancels foreground work and withdraws queued inputs, but does not stop native background tasks; extensions must manage those through native task APIs. No separate application queue is maintained.

Native cancellation is best-effort. File/shell effects can happen before cancellation or interruption, and a model may request them again. A native non-replay-safe tool interrupted during execution is reported as possibly partially run on recovery, not promised to be undone. No exactly-once external-effects guarantee.
