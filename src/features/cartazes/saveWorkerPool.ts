import type { Cartaz } from './types';
import {
  processSaveWorkerTask,
  type SaveWorkerRequest,
  type SaveWorkerResponse,
} from './saveWorker';

export type WorkerLike = {
  postMessage: (message: SaveWorkerRequest) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<SaveWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent | Event) => void) | null;
};

export type SerializeTaskResult = {
  serialized: string;
  byteLength: number;
  durationMs: number;
  persistedToOpfs: boolean;
  executedInWorker: boolean;
};

export type SaveWorkerPoolStats = {
  poolSize: number;
  activeWorkers: number;
  busyWorkers: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  usingWorkers: boolean;
};

export type SaveWorkerPoolOptions = {
  poolSize?: number;
  workerFactory?: () => WorkerLike;
};

export type SaveWorkerPool = {
  serializeDocument: (document: Cartaz, signal?: AbortSignal) => Promise<SerializeTaskResult>;
  serializeAndPersistOpfs: (
    document: Cartaz,
    path: string,
    signal?: AbortSignal
  ) => Promise<SerializeTaskResult>;
  deserializeDocument: (source: string, signal?: AbortSignal) => Promise<Cartaz>;
  getStats: () => SaveWorkerPoolStats;
  terminate: () => void;
};

type QueuedTask = {
  request: SaveWorkerRequest;
  signal?: AbortSignal;
  resolve: (response: SaveWorkerResponse, executedInWorker: boolean) => void;
  reject: (reason: Error) => void;
};

type WorkerSlot = {
  worker: WorkerLike;
  currentTask: QueuedTask | null;
};

function defaultPoolSize(): number {
  if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
    return Math.min(4, Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)));
  }
  return 2;
}

function defaultWorkerFactory(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./saveWorker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as WorkerLike;
  } catch {
    return null;
  }
}

function createAbortError(): Error {
  const err = new Error('Operação de salvamento cancelada.');
  err.name = 'AbortError';
  return err;
}

/**
 * Bounded Web Worker Pool for heavy `.skcartaz` JSON validation, serialization,
 * deserialization, and OPFS background writes.
 *
 * - Keeps the main UI thread responsive while typing, dragging canvas layers,
 *   or exporting batches of PSD-backed posters (up to 12 MB each).
 * - Lazily spawns workers up to `poolSize`, dispatches to idle workers, and
 *   queues overflow tasks in FIFO order.
 * - Automatically recovers from worker crashes and falls back gracefully in
 *   non-Worker environments (Node.js tests / SSR).
 */
export function createSaveWorkerPool(options?: SaveWorkerPoolOptions): SaveWorkerPool {
  const maxPoolSize = Math.max(1, Math.min(8, options?.poolSize ?? defaultPoolSize()));
  const customFactory = options?.workerFactory;

  let nextTaskId = 1;
  let disposed = false;
  let workerSupportChecked = false;
  let workersAvailable = false;
  let completedTasks = 0;
  let failedTasks = 0;

  const slots: WorkerSlot[] = [];
  const queue: QueuedTask[] = [];

  const spawnWorkerSlot = (): WorkerSlot | null => {
    if (disposed || slots.length >= maxPoolSize) return null;
    if (workerSupportChecked && !workersAvailable) return null;

    let worker: WorkerLike | null = null;
    try {
      worker = customFactory ? customFactory() : defaultWorkerFactory();
    } catch {
      worker = null;
    }

    workerSupportChecked = true;
    if (!worker) {
      workersAvailable = false;
      return null;
    }
    workersAvailable = true;

    const slot: WorkerSlot = {
      worker,
      currentTask: null,
    };

    worker.onmessage = event => {
      const task = slot.currentTask;
      slot.currentTask = null;
      if (task) {
        if (event.data?.ok) {
          completedTasks++;
        } else {
          failedTasks++;
        }
        task.resolve(event.data, true);
      }
      drainQueue();
    };

    worker.onerror = event => {
      const task = slot.currentTask;
      slot.currentTask = null;
      failedTasks++;

      // Remove and terminate the crashed worker so the pool can cleanly respawn
      const idx = slots.indexOf(slot);
      if (idx !== -1) {
        slots.splice(idx, 1);
      }
      try {
        worker?.terminate();
      } catch {
        // ignore cleanup error
      }

      if (task) {
        const msg =
          event && 'message' in event && typeof event.message === 'string' && event.message
            ? event.message
            : 'Falha inesperada no worker de salvamento.';
        task.reject(new Error(msg));
      }
      drainQueue();
    };

    slots.push(slot);
    return slot;
  };

  const runFallback = (task: QueuedTask) => {
    setTimeout(() => {
      if (disposed || task.signal?.aborted) {
        task.reject(createAbortError());
        return;
      }
      processSaveWorkerTask(task.request)
        .then(res => {
          if (res.ok) completedTasks++;
          else failedTasks++;
          task.resolve(res, false);
        })
        .catch(err => {
          failedTasks++;
          task.reject(err instanceof Error ? err : new Error(String(err)));
        });
    }, 0);
  };

  const drainQueue = () => {
    if (disposed) return;

    while (queue.length > 0) {
      // Skip already-aborted queued tasks before dispatching
      if (queue[0].signal?.aborted) {
        const aborted = queue.shift()!;
        aborted.reject(createAbortError());
        continue;
      }

      let idleSlot = slots.find(s => s.currentTask === null) ?? null;
      if (!idleSlot && slots.length < maxPoolSize && (!workerSupportChecked || workersAvailable)) {
        idleSlot = spawnWorkerSlot();
      }

      if (!idleSlot) {
        // Either all worker slots are busy (wait for next completion), or workers are unavailable
        if (workerSupportChecked && !workersAvailable) {
          const task = queue.shift()!;
          runFallback(task);
          continue;
        }
        return;
      }

      const task = queue.shift()!;
      idleSlot.currentTask = task;
      try {
        idleSlot.worker.postMessage(task.request);
      } catch (err) {
        idleSlot.currentTask = null;
        failedTasks++;
        task.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const enqueue = (
    buildRequest: (id: number) => SaveWorkerRequest,
    signal?: AbortSignal
  ): Promise<{ response: SaveWorkerResponse; executedInWorker: boolean }> => {
    if (disposed) {
      return Promise.reject(new Error('Pool de workers encerrado.'));
    }
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    const request = buildRequest(nextTaskId++);
    return new Promise((resolve, reject) => {
      const task: QueuedTask = {
        request,
        signal,
        resolve: (response, executedInWorker) => resolve({ response, executedInWorker }),
        reject,
      };
      queue.push(task);
      drainQueue();
    });
  };

  return {
    async serializeDocument(document: Cartaz, signal?: AbortSignal): Promise<SerializeTaskResult> {
      const { response, executedInWorker } = await enqueue(
        id => ({ id, type: 'serialize', document }),
        signal
      );
      if (!response.ok) {
        throw new Error(response.error);
      }
      if (response.type !== 'serialize') {
        throw new Error('Resposta inválida do worker de serialização.');
      }
      return {
        serialized: response.serialized,
        byteLength: response.byteLength,
        durationMs: response.durationMs,
        persistedToOpfs: response.persistedToOpfs,
        executedInWorker,
      };
    },

    async serializeAndPersistOpfs(
      document: Cartaz,
      path: string,
      signal?: AbortSignal
    ): Promise<SerializeTaskResult> {
      const { response, executedInWorker } = await enqueue(
        id => ({ id, type: 'serializeAndPersistOpfs', document, path }),
        signal
      );
      if (!response.ok) {
        throw new Error(response.error);
      }
      if (response.type !== 'serializeAndPersistOpfs') {
        throw new Error('Resposta inválida do worker de salvamento.');
      }
      return {
        serialized: response.serialized,
        byteLength: response.byteLength,
        durationMs: response.durationMs,
        persistedToOpfs: response.persistedToOpfs,
        executedInWorker,
      };
    },

    async deserializeDocument(source: string, signal?: AbortSignal): Promise<Cartaz> {
      const { response } = await enqueue(
        id => ({ id, type: 'deserialize', source }),
        signal
      );
      if (!response.ok) {
        throw new Error(response.error);
      }
      if (response.type !== 'deserialize') {
        throw new Error('Resposta inválida do worker de leitura.');
      }
      return response.document;
    },

    getStats(): SaveWorkerPoolStats {
      return {
        poolSize: maxPoolSize,
        activeWorkers: slots.length,
        busyWorkers: slots.filter(s => s.currentTask !== null).length,
        queuedTasks: queue.length,
        completedTasks,
        failedTasks,
        usingWorkers: workersAvailable,
      };
    },

    terminate() {
      disposed = true;
      while (queue.length > 0) {
        const pending = queue.shift()!;
        pending.reject(createAbortError());
      }
      for (const slot of slots) {
        if (slot.currentTask) {
          slot.currentTask.reject(createAbortError());
          slot.currentTask = null;
        }
        try {
          slot.worker.terminate();
        } catch {
          // ignore
        }
      }
      slots.length = 0;
    },
  };
}

let sharedPool: SaveWorkerPool | null = null;

export function getSharedSaveWorkerPool(): SaveWorkerPool {
  if (!sharedPool) {
    sharedPool = createSaveWorkerPool();
  }
  return sharedPool;
}

export function terminateSharedSaveWorkerPool(): void {
  if (sharedPool) {
    sharedPool.terminate();
    sharedPool = null;
  }
}
