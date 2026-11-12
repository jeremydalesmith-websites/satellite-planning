import type { PredictionRun } from './predict.ts';
import { predictAll } from './predict.ts';
import type { PredictMessage, PredictRequest } from './predict.worker.ts';

export interface PredictHandle {
  promise: Promise<PredictionRun>;
  cancel: () => void;
}

let nextId = 1;

/**
 * Run prediction in a Web Worker. Falls back to the main thread only if Workers are
 * unavailable (very old browsers). Calling `cancel()` terminates the worker.
 */
export function predictInWorker(
  req: Omit<PredictRequest, 'id'>,
  onProgress?: (done: number, total: number, name: string) => void,
): PredictHandle {
  if (typeof Worker === 'undefined') {
    return {
      promise: Promise.resolve(predictAll(req.elements, req.observer, req.startMs, req.endMs, { thresholdsDeg: req.thresholdsDeg }, onProgress)),
      cancel: () => {},
    };
  }
  const id = nextId++;
  const worker = new Worker(new URL('./predict.worker.ts', import.meta.url), { type: 'module' });
  const promise = new Promise<PredictionRun>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<PredictMessage>) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'progress') onProgress?.(m.done, m.total, m.name);
      else if (m.type === 'result') {
        worker.terminate();
        resolve(m.run);
      } else {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The prediction worker failed to start.'));
    };
    worker.postMessage({ ...req, id } satisfies PredictRequest);
  });
  return { promise, cancel: () => worker.terminate() };
}
