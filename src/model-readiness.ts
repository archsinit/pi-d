import type { Context } from "@earendil-works/chord/context";
import { lazyStream } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { classifierErrorResult, imageErrorResult } from "@earendil-works/pi-ai/utils/model-operations";
import type { Harness } from "@earendil-works/pi-durable";

type Gate = { pending: () => boolean; wait: (signal?: AbortSignal) => Promise<void> };
const harnessGates = new WeakMap<Harness, Gate>(), modelGates = new WeakMap<Models, Gate>();

/** Per-open authorization, never a persisted grant or an alternative task scheduler. */
export function modelReadinessGate(models: Models) {
  const latch = Promise.withResolvers<void>(), closed = new AbortController(); let ready = false, owner: Harness | undefined;
  const gate: Gate = { pending: () => !ready, async wait(signal) {
    const cancellation = signal ? AbortSignal.any([signal, closed.signal]) : closed.signal;
    cancellation.throwIfAborted();
    if (ready) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { cancellation.removeEventListener("abort", abort); reject(cancellation.reason); };
      cancellation.addEventListener("abort", abort, { once: true });
      void latch.promise.then(() => { cancellation.removeEventListener("abort", abort); resolve(); });
    });
    cancellation.throwIfAborted();
  } };
  // Use the SDK's own lazy stream and normal model methods. The underlying collection is not mutated:
  // each open Harness gets a separate gate, while local catalog/auth/login APIs remain immediately usable.
  const requests: Pick<Models, "stream" | "complete" | "streamSimple" | "completeSimple" | "streamDeferred" | "fetchDeferred" | "generateImages" | "classify"> = {
    stream: (model, input, options) => lazyStream(model, async () => { await gate.wait(options?.signal); return models.stream(model, input, options); }),
    streamSimple: (model, input, options) => lazyStream(model, async () => { await gate.wait(options?.signal); return models.streamSimple(model, input, options); }),
    streamDeferred: (model, handle, options) => lazyStream(model, async () => { await gate.wait(options?.signal); return models.streamDeferred(model, handle, options); }),
    complete: (model, input, options) => requests.stream(model, input, options).result(),
    completeSimple: (model, input, options) => requests.streamSimple(model, input, options).result(),
    fetchDeferred: (model, handle, options) => requests.streamDeferred(model, handle, options).result(),
    generateImages: async (model, input, options) => {
      try { await gate.wait(options?.signal); return await models.generateImages(model, input, options); }
      catch (error) { return imageErrorResult(model, error, options?.signal?.aborted || closed.signal.aborted); }
    },
    classify: async (model, input, options) => {
      try { await gate.wait(options?.signal); return await models.classify(model, input, options); }
      catch (error) { return classifierErrorResult(model, error, options?.signal?.aborted || closed.signal.aborted); }
    },
  };
  const guarded = new Proxy(models, { get(target, key) {
    if (Object.hasOwn(requests, key)) return Reflect.get(requests, key);
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  modelGates.set(guarded, gate);
  const close = () => {
    closed.abort(new Error("Host model readiness closed.")); latch.resolve();
    if (owner) harnessGates.delete(owner); owner = undefined; modelGates.delete(guarded);
  };
  return {
    models: guarded,
    attach(harness: Harness) {
      owner = harness; harnessGates.set(harness, gate);
      // Native close seals admission before this notification and joins invocations afterward.
      // Release even callers that omitted a model-request signal, including on Storage failure.
      harness.subscribeClose(close);
    },
    allow() { if (!closed.signal.aborted) { ready = true; latch.resolve(); } },
    close,
  };
}

export async function modelReadinessPending(harness: Harness): Promise<boolean> { return harnessGates.get(harness)?.pending() ?? false; }

/** A notifier waits before admitting input; the model facade also covers already-admitted work on reopening. */
export async function awaitModelReadiness(api: { readonly models: Models }, context: Context): Promise<void> {
  await modelGates.get(api.models)?.wait(context.abortSignal);
}
