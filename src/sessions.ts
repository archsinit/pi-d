import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { matchesKey, type Terminal } from "@earendil-works/pi-tui";
import type { ChatHandle, SessionChoice } from "./chat.ts";
import { Dialog, showDialog } from "./dialog.ts";
import { readSessionInfo } from "./session.ts";
import { ChatUI } from "./ui.ts";

export function sessionHome(): string {
  const home = process.env.XDG_DATA_HOME;
  return join(home && isAbsolute(home) ? home : join(homedir(), ".local", "share"), "pi-d");
}

/** A directory of native stores, not an index, transcript copy or executable configuration. */
export class SessionCatalog {
  readonly home: string;
  constructor(home = sessionHome()) { this.home = home; }

  async newFile(cwd: string, name = ""): Promise<string> {
    const project = createHash("sha256").update(await realpath(cwd)).digest("hex").slice(0, 16);
    const directory = join(this.home, "sessions", project);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const label = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    const date = new Date().toISOString().replace(/[:.]/g, "-");
    return join(directory, `${date}${label ? `_${label}` : ""}_${randomUUID()}.sqlite`);
  }

  async list(cwd: string, onLockLost: (error: Error) => never, current?: ChatHandle, signal?: AbortSignal) {
    const workspace = await realpath(cwd);
    const files = [join(this.home, "default.sqlite")];
    const diagnostics: string[] = [];
    try {
      for (const directory of (await readdir(join(this.home, "sessions"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!directory.isDirectory() || !/^[a-f0-9]{16}$/.test(directory.name)) continue;
        for (const file of await readdir(join(this.home, "sessions", directory.name), { withFileTypes: true })) {
          if (file.isFile() && file.name.endsWith(".sqlite")) files.push(join(this.home, "sessions", directory.name, file.name));
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const candidates: { file: string; modified: number }[] = [];
    for (const file of files) {
      signal?.throwIfAborted();
      try {
        const info = await stat(file);
        if (info.isFile() && info.size > 0) candidates.push({ file, modified: info.mtimeMs });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`${basename(file)}: unavailable.`); }
    }
    candidates.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
    // Modest local collections; do not open an unbounded number of stores for a picker.
    if (candidates.length > 200) diagnostics.push("Only the 200 most recently modified stores were inspected.");
    const choices: SessionChoice[] = [], seen = new Set<string>();
    for (const candidate of candidates.slice(0, 200)) {
      signal?.throwIfAborted();
      try {
        const file = await realpath(candidate.file);
        if (seen.has(file)) continue;
        seen.add(file);
        const active = file === current?.file;
        // Native document/record reads, no Harness startup or task recovery. Live writers retain their locks.
        const info = active ? await (async () => {
          const agent = await current.conversation.agent(BACKGROUND_CONTEXT);
          const pending = await current.harness.inspect(BACKGROUND_CONTEXT);
          return { cwd: agent.cwd, unfinished: !!(pending.tasks.length || pending.submissions.length) };
        })() : await readSessionInfo(file, onLockLost);
        if (!info.cwd || await realpath(info.cwd) !== workspace) continue;
        choices.push({ file, label: basename(file, ".sqlite"), description: `${new Date(candidate.modified).toISOString()}${active ? " · current" : info.unfinished ? " · unfinished work resumes on open" : ""}` });
      } catch {
        diagnostics.push(`${basename(candidate.file)}: not inspected (open elsewhere, unavailable or unsupported).`);
      }
    }
    signal?.throwIfAborted();
    return { choices, diagnostics };
  }
}

export async function pickSession(ui: ChatUI, choices: SessionChoice[], diagnostics: string[], signal: AbortSignal): Promise<string> {
  if (!choices.length) throw new Error(`No saved sessions for this workspace. Use /session-new or --new-session.${diagnostics.length ? " Some stores could not be inspected." : ""}`);
  const dialog = new Dialog(ui.tui, "Resume a session for this workspace · type to filter", choices.map((choice) => ({ value: choice.file, label: choice.label, description: choice.description })),
    (item, query) => item.label.toLowerCase().includes(query.toLowerCase()));
  dialog.info = diagnostics.join("\n");
  return showDialog(ui.tui, dialog, signal);
}

/** Startup picker has no conversation and cannot create/resume a default store on cancellation. */
export async function startupSessionPicker(terminal: Terminal, choices: SessionChoice[], diagnostics: string[], animate: boolean): Promise<string | undefined> {
  if (!choices.length) throw new Error("No saved sessions for this workspace. Use --new-session or --session path.");
  const ui = new ChatUI(terminal, { animate, sessionLabel: "choose session" });
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Cancelled."));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  ui.tui.addInputListener((data) => { if (matchesKey(data, "ctrl+c")) { cancel(); return { consume: true }; } return undefined; });
  for (const signal of signals) process.on(signal, cancel);
  try {
    ui.start();
    try { return await pickSession(ui, choices, diagnostics, controller.signal); }
    catch (error) { if (controller.signal.aborted || (error as Error).message === "Cancelled.") return; throw error; }
  } finally {
    try { await terminal.drainInput(200, 30); }
    finally { for (const signal of signals) process.off(signal, cancel); ui.stop(); }
  }
}
