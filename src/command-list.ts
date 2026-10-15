import type { SlashCommand } from "@earendil-works/pi-tui";

export const commands: SlashCommand[] = [
  { name: "new", description: "Reset active context; keep stored history and draft" },
  { name: "clear", description: "Same as /new" },
  { name: "session-new", argumentHint: "[name]", description: "Create a separate session for this workspace" },
  { name: "resume", description: "Choose a saved session for this workspace" },
  { name: "status", description: "Session, workspace, authentication and recovery diagnostics" },
  { name: "login", description: "ChatGPT subscription login" },
  { name: "logout", description: "Remove pi-d's local ChatGPT credentials" },
  { name: "model", argumentHint: "[provider/id]", description: "Select a model" },
  { name: "reasoning", argumentHint: "[level]", description: "Select supported thinking" },
  { name: "skills", description: "List skills and diagnostics" },
  { name: "extensions", description: "List installed Durable extensions" },
  { name: "notifications", description: "Inspect and dismiss pending UI notifications" },
  { name: "steer", argumentHint: "text", description: "Guide the current run after its tool round" },
  { name: "followup", argumentHint: "text", description: "Queue input for after the current run" },
  { name: "interrupt", description: "Stop foreground work and withdraw queued inputs (same as Escape)" },
  { name: "queue", description: "Show Durable's queued inputs" },
  { name: "withdraw", argumentHint: "[id]", description: "Withdraw one queued input" },
  { name: "help", description: "Commands and workspace" },
];
