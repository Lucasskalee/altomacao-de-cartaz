import type { Cartaz } from './types';
import { MAX_DOCUMENT_CHARS, validate } from './validation';

export type SaveWorkerRequest =
  | {
      id: number;
      type: 'serialize';
      document: Cartaz;
    }
  | {
      id: number;
      type: 'serializeAndPersistOpfs';
      document: Cartaz;
      path: string;
    }
  | {
      id: number;
      type: 'deserialize';
      source: string;
    };

export type SaveWorkerSuccessResponse =
  | {
      id: number;
      ok: true;
      type: 'serialize' | 'serializeAndPersistOpfs';
      serialized: string;
      byteLength: number;
      durationMs: number;
      persistedToOpfs: boolean;
    }
  | {
      id: number;
      ok: true;
      type: 'deserialize';
      document: Cartaz;
      durationMs: number;
    };

export type SaveWorkerErrorResponse = {
  id: number;
  ok: false;
  error: string;
};

export type SaveWorkerResponse = SaveWorkerSuccessResponse | SaveWorkerErrorResponse;

type OpfsSyncHandle = {
  truncate: (newSize: number) => void;
  write: (buffer: Uint8Array, options?: { at?: number }) => number;
  flush: () => void;
  close: () => void;
};

type OpfsFileHandleLike = {
  createSyncAccessHandle?: () => Promise<OpfsSyncHandle>;
  createWritable?: () => Promise<{
    write: (data: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

type OpfsDirectoryHandleLike = {
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsDirectoryHandleLike>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsFileHandleLike>;
};

const encoder = new TextEncoder();

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function sanitizeOpfsFileName(rawPath: string): string {
  const leaf = rawPath.split(/[\\/]/).pop() || 'cartaz.skcartaz';
  const safe = leaf.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return safe || 'cartaz.skcartaz';
}

async function persistBytesToOpfs(path: string, bytes: Uint8Array): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const storageApi = (navigator as unknown as {
    storage?: { getDirectory?: () => Promise<OpfsDirectoryHandleLike> };
  }).storage;
  if (!storageApi || typeof storageApi.getDirectory !== 'function') {
    return false;
  }

  try {
    const root = await storageApi.getDirectory();
    const dir = await root.getDirectoryHandle('skalee-cartazes', { create: true });
    const fileHandle = await dir.getFileHandle(sanitizeOpfsFileName(path), { create: true });

    // Prefer FileSystemSyncAccessHandle inside Dedicated Web Worker for fastest off-main-thread I/O
    if (typeof fileHandle.createSyncAccessHandle === 'function') {
      const accessHandle = await fileHandle.createSyncAccessHandle();
      try {
        accessHandle.truncate(0);
        accessHandle.write(bytes, { at: 0 });
        accessHandle.flush();
      } finally {
        accessHandle.close();
      }
      return true;
    }

    if (typeof fileHandle.createWritable === 'function') {
      const writable = await fileHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return true;
    }

    return false;
  } catch {
    // OPFS may be unavailable in restricted iframes or private browsing; never fail the save
    return false;
  }
}

/**
 * Pure worker task processor used inside the Web Worker and as an automatic
 * fallback in runtimes without Web Workers (e.g. Node.js unit tests).
 */
export async function processSaveWorkerTask(request: SaveWorkerRequest): Promise<SaveWorkerResponse> {
  const start = nowMs();
  try {
    if (request.type === 'deserialize') {
      if (request.source.length > MAX_DOCUMENT_CHARS) {
        throw new Error('Documento excede 12 MB.');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.source);
      } catch {
        throw new Error('Arquivo JSON inválido ou corrompido.');
      }
      validate(parsed);
      return {
        id: request.id,
        ok: true,
        type: 'deserialize',
        document: parsed,
        durationMs: Math.max(0, nowMs() - start),
      };
    }

    validate(request.document);
    const serialized = JSON.stringify(request.document, null, 2);
    if (serialized.length > MAX_DOCUMENT_CHARS) {
      throw new Error('Documento excede 12 MB.');
    }

    const bytes = encoder.encode(serialized);
    let persistedToOpfs = false;
    if (request.type === 'serializeAndPersistOpfs') {
      persistedToOpfs = await persistBytesToOpfs(request.path, bytes);
    }

    return {
      id: request.id,
      ok: true,
      type: request.type,
      serialized,
      byteLength: bytes.byteLength,
      durationMs: Math.max(0, nowMs() - start),
      persistedToOpfs,
    };
  } catch (err) {
    return {
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type WorkerGlobalLike = {
  addEventListener: (type: 'message', listener: (event: MessageEvent<SaveWorkerRequest>) => void) => void;
  postMessage: (message: SaveWorkerResponse) => void;
};

// Only attach the worker message listener when running inside a real Web Worker global scope
if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof (self as unknown as WorkerGlobalLike).postMessage === 'function') {
  const workerGlobal = self as unknown as WorkerGlobalLike;
  workerGlobal.addEventListener('message', async event => {
    const response = await processSaveWorkerTask(event.data);
    workerGlobal.postMessage(response);
  });
}
