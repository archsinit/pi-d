import type { OAuthCredential } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";

export const model = { provider: "faux", modelId: "faux-1" };
export const subscriptionCredential: OAuthCredential = {
  type: "oauth", access: `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64")}.test`,
  refresh: "test-refresh-not-a-real-token", expires: Date.now() + 3600000, accountId: "test-account",
};
export function testModels(options: NonNullable<Parameters<typeof fauxProvider>[0]> & { responses?: FauxResponseStep[] } = {}) {
  const { responses = [], ...providerOptions } = options;
  const faux = fauxProvider({ tokensPerSecond: 100000, ...providerOptions });
  faux.appendResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { models, faux };
}
export const lockLost = (error: Error): never => { throw error; };
