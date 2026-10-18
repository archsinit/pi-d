import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { safeText } from "./theme.ts";

export async function connectSubscription(models: Models, interaction: AuthInteraction): Promise<void> {
  try { await models.login("openai-codex", "oauth", interaction); }
  catch {
    // Provider errors can contain response bodies or callback codes; never print them during login.
    throw new Error(interaction.signal?.aborted ? "Login cancelled." : "ChatGPT sign-in failed. Cancel other pending logins (port 1455), then try /login or --login again; check that pi-d's credential directory is writable and private.");
  }
}

export async function loginSubscription(
  models: Models,
  input: Readable = process.stdin, output: Writable = process.stdout,
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Login cancelled."));
  const reader = createInterface({ input, output });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  reader.on("SIGINT", cancel); reader.on("close", cancel);
  for (const signal of signals) process.on(signal, cancel);
  const line = (value: string) => { output.write(safeText(value) + "\n"); };
  try {
    line("Sign in with ChatGPT using Pi's Codex OAuth flow. No model request is made by login.");
    await connectSubscription(models, {
      signal: controller.signal,
      notify: (event) => {
        if (event.type === "auth_url") {
          line("Open this link in your browser:"); line(event.url);
        } else if (event.type === "device_code") {
          line(event.verificationUri); line(`Enter this one-time code in your browser: ${event.userCode}`);
        } else if (event.type === "progress" || event.type === "info") line(event.message);
      },
      prompt: async (prompt) => {
        const signal = prompt.signal ? AbortSignal.any([prompt.signal, controller.signal]) : controller.signal;
        if (prompt.type === "select") {
          if (!prompt.options.length) throw new Error("No ChatGPT login methods available.");
          line(prompt.message);
          prompt.options.forEach((option, index) => line(`  ${index + 1}. ${option.label}`));
          while (true) {
            const answer = await reader.question("Method [1]: ", { signal });
            const option = prompt.options[Number(answer.trim() || "1") - 1];
            if (option) return option.id;
            line(`Choose a number from 1 to ${prompt.options.length}.`);
          }
        }
        if (prompt.type !== "manual_code") throw new Error("Unexpected ChatGPT login prompt.");
        return reader.question(`${safeText(prompt.message)}\n> `, { signal });
      },
    });
    line("\nChatGPT connected. Run pi-d --model openai-codex/gpt-6.1-sol --thinking medium.");
  } finally {
    for (const signal of signals) process.off(signal, cancel);
    reader.close();
  }
}
