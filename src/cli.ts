import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { chatModels, credentialFile, SubscriptionCredentials } from "./auth.ts";
import { errorText, mountChat, type ChatHandle } from "./chat.ts";
import { codingEnv, codingRegistry, workspacePath } from "./coding.ts";
import { chatCommands, requireSubscription } from "./commands.ts";
import { commandCompletion } from "./completion.ts";
import { openDemo } from "./demo.ts";
import { loginSubscription } from "./login.ts";
import { expandPath, Resources } from "./resources.ts";
import { DEFAULT_CHAT_AGENT, openPersistentChat, parseModel, parseThinking } from "./session.ts";
import { SessionCatalog, startupSessionPicker } from "./sessions.ts";
import { requireRecoveryReady } from "./status.ts";

const help = `pi-d · a coding terminal for stock Durable

Usage: pi-d [options]

  --demo                 Offline demo; no credentials, requests or saved session
  --login                Pi-style Codex/ChatGPT OAuth; no agent registration
  --logout               Remove pi-d's local ChatGPT credentials (no model request)
  --model provider/id    Select a pinned catalog chat model (saved with the session)
  --thinking level       Set supported thinking: off/minimal/low/medium/high/xhigh/max
  --session path         SQLite session file; opens/resumes it on startup
  --new-session          Create a separate managed session for the launch workspace
  --resume               Choose a saved session for the launch workspace
  --cwd path             Change the saved workspace while idle (default: launch directory)
  --extension path       Add a trusted Durable Extension (repeatable; full account access)
  --no-extensions        Skip external extension discovery; built-ins remain available
  --skill path           Add a skill file/directory (repeatable)
  --list-models          List the pinned chat catalog without authentication
  --no-animation         Disable activity animation
  -h, --help             Show this help

New-session default: openai-codex/gpt-6.1-sol · medium reasoning. Saved settings are retained.
No selector keeps the existing shared default.sqlite; it is never silently migrated.
Sessions: $XDG_DATA_HOME/pi-d or ~/.local/share/pi-d; managed sessions live under sessions/.
OpenAI uses ChatGPT subscription login only, never OPENAI_API_KEY.
Credentials: $XDG_CONFIG_HOME/pi-d/auth.json or ~/.config/pi-d/auth.json (plaintext, 0600).
Subagents: built in; no extension installation or activation required.
Extensions: auto-loaded from the config directory's extensions/; no project code discovery.
Other providers use environment keys (e.g. ANTHROPIC_API_KEY). Pi credentials are not read.
In-app: /new /clear /session-new [name] /resume /status /login /logout /model /reasoning
        /skills /skill:name /extensions /notifications /agents /agent-show /agent-stop
        /steer text /followup text /interrupt /queue /withdraw [id] /help
/new and /clear reset active context without deleting stored history or the draft.
Enter sends when idle · Tab completes commands/skills · Alt+Enter newline · Escape stops · Ctrl+C quits.
Use /steer or /followup while busy; /interrupt stops foreground work and withdraws queued inputs.
The footer's ctx ~ estimate is active context usage, not cumulative spend or subscription quota.
Tools: read, bash, edit, write, delegate, agent_results, agent_stop, agent_message.
No sandbox or per-call approval; workspace is not a boundary. Subagents start only when delegated.
Opening a saved session resumes unfinished native work and may repeat a model call.
Missing recovery extensions/blocked tasks keep automatic recovery paused; use /status.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    demo: { type: "boolean" }, help: { type: "boolean", short: "h" },
    login: { type: "boolean" }, logout: { type: "boolean" },
    model: { type: "string" }, thinking: { type: "string" }, session: { type: "string" }, cwd: { type: "string" },
    "new-session": { type: "boolean" }, resume: { type: "boolean" },
    extension: { type: "string", multiple: true }, skill: { type: "string", multiple: true },
    "no-extensions": { type: "boolean" },
    "list-models": { type: "boolean" }, "no-animation": { type: "boolean" },
  } });
  if (values.help) { console.log(help); return; }
  if ([values.session !== undefined, !!values["new-session"], !!values.resume].filter(Boolean).length > 1) throw new Error("Choose only one of --session, --new-session or --resume.");
  if (values.demo && (values.model !== undefined || values.thinking !== undefined || values.session !== undefined || values["new-session"] || values.resume || values["list-models"] || values.login || values.logout || values.cwd !== undefined || values.extension || values.skill)) {
    throw new Error("--demo is ephemeral and cannot be combined with --model, --thinking, --session, --new-session, --resume, --list-models, --login, --logout, --cwd, --extension or --skill.");
  }
  if (values.login || values.logout) {
    if ((values.login && values.logout) || values.model !== undefined || values.thinking !== undefined || values.session !== undefined || values["new-session"] || values.resume || values["list-models"] || values["no-animation"] || values.cwd !== undefined || values.extension || values.skill) {
      throw new Error("Use --login or --logout on its own.");
    }
    if (values.login && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("ChatGPT login needs an interactive terminal.");
    const credentials = new SubscriptionCredentials();
    const models = chatModels(credentials);
    if (values.login) {
      await credentials.modify("openai-codex", async () => undefined);
      await loginSubscription(models);
    } else {
      for (const provider of ["openai", "openai-codex"]) await models.logout(provider);
      console.log("pi-d's local ChatGPT credentials removed. Subscription grants can be revoked in ChatGPT settings.");
    }
    return;
  }
  if (values["list-models"]) {
    console.log(builtinModels().getModels().map((model) => `${model.provider}/${model.id}`).sort().join("\n"));
    return;
  }
  const selectedModel = values.model === undefined ? undefined : parseModel(values.model);
  const thinkingLevel = values.thinking === undefined ? undefined : parseThinking(values.thinking);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("pi-d needs an interactive terminal. Use --help for setup.");
  const models = chatModels(new SubscriptionCredentials());
  const terminal = new ProcessTerminal();
  let app: Awaited<ReturnType<typeof mountChat>> | undefined;
  const report = (error: unknown) => { if (app && !app.ui.unavailable) app.ui.setNotice(errorText(error)); };
  const onLockLost = (error: Error): never => {
    // The advisory lock is not fenced by SQLite: stop immediately, without more writes.
    app?.ui.stop(); console.error(`pi-d: Session ownership lost: ${errorText(error)}`); process.exit(1);
  };
  const resources = values.demo ? undefined : new Resources(dirname(credentialFile()), values.skill);
  const registry = resources ? await codingRegistry(resources, await resources.extensionPaths(values.extension, !values["no-extensions"]), report) : undefined;
  const cwd = resources ? await workspacePath(values.cwd ?? process.cwd()) : undefined;
  const catalog = new SessionCatalog();
  const open = async (file: string, settings: Pick<Parameters<typeof openPersistentChat>[2], "model" | "thinkingLevel" | "cwd" | "defaultCwd"> = {}): Promise<ChatHandle> => {
    const chat = await openPersistentChat(file, models, {
      ...settings, defaults: DEFAULT_CHAT_AGENT, onReport: report, registry, env: codingEnv, onLockLost, gateModelWork: true,
    });
    try {
      chat.command = chatCommands(chat, models, resources);
      chat.completion = commandCompletion(chat, models, resources);
      chat.beforeModel = async () => { await requireSubscription(chat, models); await requireRecoveryReady(chat); };
      chat.sessions = {
        newFile: async (name) => catalog.newFile((await chat.conversation.agent(BACKGROUND_CONTEXT)).cwd!, name),
        list: async (signal) => catalog.list((await chat.conversation.agent(BACKGROUND_CONTEXT)).cwd!, onLockLost, chat, signal),
        open: async (path, fresh) => {
          const current = await chat.conversation.agent(BACKGROUND_CONTEXT);
          return open(path, fresh ? { model: current.model, thinkingLevel: current.thinkingLevel, defaultCwd: current.cwd } : {});
        },
      };
      const workspace = (await chat.conversation.agent(BACKGROUND_CONTEXT)).cwd;
      const name = chat.label.match(/^(\d{4}-\d\d-\d\dT\d\d-\d\d)[\dTZ.-]*(?:_(.+?))?_([a-f0-9]{8})-[a-f0-9-]+\.sqlite$/);
      if (name) chat.label = `${name[1].replace("T", " ")}${name[2] ? ` ${name[2]}` : ""} · ${name[3]}`;
      if (workspace) chat.label = `${basename(workspace) || workspace} · ${chat.label}`;
      return chat;
    } catch (error) { await chat.close(); throw error; }
  };
  let chat: ChatHandle;
  if (values.demo) {
    const demo = await openDemo(); chat = demo;
    chat.command = chatCommands(chat, demo.models);
    chat.completion = commandCompletion(chat, demo.models);
  } else {
    let file = values.session === undefined ? join(catalog.home, "default.sqlite") : expandPath(values.session);
    if (values["new-session"]) file = await catalog.newFile(cwd!);
    if (values.resume) {
      const { choices, diagnostics } = await catalog.list(cwd!, onLockLost);
      const selected = await startupSessionPicker(terminal, choices, diagnostics, !values["no-animation"]);
      if (!selected) return;
      file = selected;
    }
    chat = await open(file, { model: selectedModel, thinkingLevel, defaultCwd: cwd, cwd: values.cwd === undefined ? undefined : cwd });
  }
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const shutdown = () => { void app?.close().catch(() => {}); };
  try {
    app = await mountChat(chat, terminal, !values["no-animation"]);
    for (const signal of signals) process.on(signal, shutdown);
    terminal.setTitle("pi-d · durable chat");
    await app.closed;
  } finally {
    for (const signal of signals) process.off(signal, shutdown);
    if (app) await app.close();
    else await chat.close();
  }
}

// This process owns all provider sessions. Release cached transports only after native shutdown,
// never on individual chat close: session switching may already have opened the next chat.
await main().finally(() => cleanupSessionResources()).catch((error) => { console.error(`pi-d: ${errorText(error)}`); process.exitCode = 1; });
