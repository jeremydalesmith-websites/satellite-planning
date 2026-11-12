/// <reference lib="webworker" />
/** Runs orbital prediction off the main thread so the UI never freezes. */
import { predictAll } from './predict.ts';
import type { PredictionRun } from './predict.ts';
import type { ElementSet, Observer } from '../domain/types.ts';

export interface PredictRequest {
  id: number;
  elements: ElementSet[];
  observer: Observer;
  startMs: number;
  endMs: number;
  thresholdsDeg: number[];
}

export type PredictMessage =
  | { type: 'progress'; id: number; done: number; total: number; name: string }
  | { type: 'result'; id: number; run: PredictionRun }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<PredictRequest>) => {
  const { id, elements, observer, startMs, endMs, thresholdsDeg } = e.data;
  try {
    const run = predictAll(elements, observer, startMs, endMs, { thresholdsDeg }, (done, total, name) =>
      ctx.postMessage({ type: 'progress', id, done, total, name } satisfies PredictMessage),
    );
    ctx.postMessage({ type: 'result', id, run } satisfies PredictMessage);
  } catch (err) {
    ctx.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) } satisfies PredictMessage);
  }
};
