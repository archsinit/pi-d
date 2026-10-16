import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { CodingTools, createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { Worker } from "./state.ts";

// The same stock registrations the ordinary host uses: no worker-specific path, time or call budgets.
export const workerTools = CodingTools.tools!;

function workerOnly<P extends TSchema, D extends JsonValue>(tool: ToolRegistration<P, D>): ToolRegistration<P, D> {
  return { ...tool, deferred: true, callers: ["model"], async execute(args, api, context) {
    if (!(await api.snapshot(Worker, api.conversationId, context))?.owner) throw new Error("Legacy worker tools are available only inside a subagent.");
    return tool.execute(args, api, context);
  } };
}
const shell = createBashTool();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Old prepared requests may still name these tools. They no longer enforce the old budgets or path restrictions. */
export const legacyTools = [
  workerOnly({ ...createReadTool(), name: "agent_read", replay: "safe" }),
  workerOnly(defineTool({ name: "agent_list", replay: "unsafe", description: "Legacy directory listing; prefer bash for new work.",
    parameters: Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
    execute: (args, api, context) => shell.execute({ command: `ls -A -- ${quote(args.path ?? ".")}` }, api, context),
  })),
  workerOnly(defineTool({ name: "agent_search", replay: "unsafe", description: "Legacy literal search; prefer bash for new work.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()),
      caseSensitive: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Number()) }),
    execute: (args, api, context) => shell.execute({ command: `grep -rnF ${args.caseSensitive ? "" : "-i "}-- ${quote(args.query)} ${quote(args.path ?? ".")}` }, api, context),
  })),
];
