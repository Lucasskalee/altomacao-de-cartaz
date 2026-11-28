import {
  preparePosterRenderPlan,
  type PosterRenderWorkerInput,
  type PreparedPosterRenderPlan,
} from './posterRenderPlan';
import type { PosterWorkerRequest, PosterWorkerResponse } from './posterRenderWorker';

type PendingEntry = {
  resolve: (plan: PreparedPosterRenderPlan) => void;
  reject: (reason?: unknown) => void;
};

let sharedWorker: Worker | null = null;
let workerUnavailable = false;
let nextRequestId = 1;
let customWorkerFactory: (() => Worker) | null = null;
const pendingRequests = new Map<number, PendingEntry>();

function rejectAllPending(reason: Error) {
  for (const [, entry] of pendingRequests) {
    entry.reject(reason);
  }
  pendingRequests.clear();
}

export function setPosterRenderWorkerFactory(factory: (() => Worker) | null): void {
  terminatePosterRenderWorker();
  customWorkerFactory = factory;
}

function ensureWorker(): Worker | null {
  if (workerUnavailable || (!customWorkerFactory && typeof Worker === 'undefined')) {
    return null;
  }
  if (sharedWorker) {
    return sharedWorker;
  }
  try {
    const worker = customWorkerFactory
      ? customWorkerFactory()
      : new Worker(new URL('./posterRenderWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<PosterWorkerResponse>) => {
      const msg = event.data;
      const entry = pendingRequests.get(msg.requestId);
      if (!entry) return;
      pendingRequests.delete(msg.requestId);
      if (msg.ok) {
        entry.resolve(msg.plan);
      } else {
        entry.reject(new Error(msg.error || 'Falha ao preparar renderização da arte no WebWorker.'));
      }
    };
    worker.onerror = () => {
      workerUnavailable = true;
      sharedWorker?.terminate();
      sharedWorker = null;
      rejectAllPending(new Error('WebWorker de renderização indisponível; alternando para thread principal.'));
    };
    sharedWorker = worker;
    return sharedWorker;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

export function isPosterRenderWorkerActive(): boolean {
  return Boolean(sharedWorker) && !workerUnavailable;
}

export function terminatePosterRenderWorker(): void {
  if (sharedWorker) {
    sharedWorker.terminate();
    sharedWorker = null;
  }
  rejectAllPending(new Error('WebWorker encerrado.'));
  workerUnavailable = false;
}

/**
 * Serializes and prepares the poster artwork render plan inside a dedicated Web Worker
 * so rapid edits on complex PSD artworks do not stall the main UI thread.
 * Automatically falls back to direct execution when Workers are unavailable.
 */
export function preparePosterRenderOffThread(
  input: PosterRenderWorkerInput,
  signal?: AbortSignal
): Promise<PreparedPosterRenderPlan> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Renderização cancelada.', 'AbortError'));
  }

  const worker = ensureWorker();
  if (!worker) {
    return Promise.resolve().then(() => {
      if (signal?.aborted) {
        throw new DOMException('Renderização cancelada.', 'AbortError');
      }
      return preparePosterRenderPlan(input);
    });
  }

  return new Promise<PreparedPosterRenderPlan>((resolve, reject) => {
    const requestId = nextRequestId++;

    const onAbort = () => {
      pendingRequests.delete(requestId);
      reject(new DOMException('Renderização cancelada.', 'AbortError'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    pendingRequests.set(requestId, {
      resolve: plan => {
        signal?.removeEventListener('abort', onAbort);
        resolve(plan);
      },
      reject: err => {
        signal?.removeEventListener('abort', onAbort);
        // If the worker errored mid-flight, transparently recover on main thread unless aborted
        if (workerUnavailable && !signal?.aborted) {
          try {
            resolve(preparePosterRenderPlan(input));
            return;
          } catch (fallbackErr) {
            reject(fallbackErr);
            return;
          }
        }
        reject(err);
      },
    });

    const payload: PosterWorkerRequest = { requestId, input };
    try {
      worker.postMessage(payload);
    } catch {
      pendingRequests.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
      workerUnavailable = true;
      try {
        resolve(preparePosterRenderPlan(input));
      } catch (fallbackErr) {
        reject(fallbackErr);
      }
    }
  });
}
