import { setTimeout as delay } from "node:timers/promises";
import { chatModels, SubscriptionCredentials } from "../src/auth.ts";

globalThis.fetch = async () => { throw new Error("Network is forbidden in this offline helper."); };
const credentials = new SubscriptionCredentials(process.argv[2]);
const models = chatModels(credentials);
const provider = models.getProvider("openai-codex")!;
models.setProvider({ ...provider, auth: { oauth: {
  ...provider.auth.oauth!,
  refresh: async (current, signal) => {
    console.log("REFRESH");
    await delay(150, undefined, { signal });
    return { ...current, access: "test-rotated-access", refresh: "test-rotated-refresh", expires: Date.now() + 3600000 };
  },
} } });
if ((await models.getAuth("openai-codex"))?.source !== "OAuth") throw new Error("Expected OAuth.");
console.log("AUTH");
