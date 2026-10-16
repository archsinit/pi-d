import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { TranscriptContext } from "@earendil-works/pi-ai";

export function userText(transcript: TranscriptContext): string {
  return transcript.messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content
    : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")).join("\n");
}
export function workerName(transcript: TranscriptContext): string | undefined { return userText(transcript).match(/^Assignment: ([^\n]+)/m)?.[1]; }
export const toolResults = (transcript: TranscriptContext) => transcript.messages.filter((message) => message.role === "toolResult");
export async function until(predicate: () => boolean | Promise<boolean>, detail = "native subagent progress") {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await delay(10); }
  assert.fail(`Timed out waiting for ${detail}.`);
}
export async function gate(promise: Promise<void>, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Cancelled.")); };
    signal?.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}
