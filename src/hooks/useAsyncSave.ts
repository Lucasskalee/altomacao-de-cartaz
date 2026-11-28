import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createDebouncedAsyncSaver,
  INITIAL_ASYNC_SAVE_STATE,
  type AsyncSaveProgress,
  type AsyncSaveState,
  type DebouncedAsyncSaver,
} from '../features/cartazes/asyncSave';
import { getSharedSaveWorkerPool, type SaveWorkerPool } from '../features/cartazes/saveWorkerPool';

export type UseAsyncSaveOptions = {
  debounceMs?: number;
  autoSaveEnabled: boolean;
  canAutoSave: boolean;
  dirty: boolean;
  documentId: string;
  revision: number;
  workerPool?: SaveWorkerPool;
  performSave: (params: {
    as: boolean;
    skipOverwriteConfirm: boolean;
    isAutoSave: boolean;
    workerPool: SaveWorkerPool;
    onProgress: (progress: AsyncSaveProgress) => void;
  }) => Promise<boolean>;
  onError?: (message: string) => void;
};

/**
 * React hook coordinating debounced asynchronous saves backed by a Web Worker pool.
 * Keeps JSON validation/serialization and background file persistence off the main UI thread.
 */
export function useAsyncSave({
  debounceMs = 900,
  autoSaveEnabled,
  canAutoSave,
  dirty,
  documentId,
  revision,
  workerPool,
  performSave,
  onError,
}: UseAsyncSaveOptions) {
  const [asyncSaveState, setAsyncSaveState] = useState<AsyncSaveState>(INITIAL_ASYNC_SAVE_STATE);
  const saverRef = useRef<DebouncedAsyncSaver | null>(null);
  const poolRef = useRef<SaveWorkerPool>(workerPool ?? getSharedSaveWorkerPool());
  const performSaveRef = useRef(performSave);
  performSaveRef.current = performSave;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const manualRequestRef = useRef<{ as: boolean; skipOverwriteConfirm: boolean }>({
    as: false,
    skipOverwriteConfirm: false,
  });

  useEffect(() => {
    const saver = createDebouncedAsyncSaver({
      debounceMs,
      performSave: ({ reason, onProgress }) => {
        const isAutoSave = reason === 'auto';
        const req = manualRequestRef.current;
        return performSaveRef.current({
          as: isAutoSave ? false : req.as,
          skipOverwriteConfirm: isAutoSave ? true : req.skipOverwriteConfirm,
          isAutoSave,
          workerPool: poolRef.current,
          onProgress,
        });
      },
      onStateChange: next => {
        setAsyncSaveState(next);
      },
    });
    saverRef.current = saver;
    return () => {
      saver.dispose();
      saverRef.current = null;
    };
  }, [debounceMs]);

  useEffect(() => {
    saverRef.current?.reset();
  }, [documentId]);

  useEffect(() => {
    const saver = saverRef.current;
    if (!saver) return;
    if (!autoSaveEnabled || !dirty || !canAutoSave) {
      if (!dirty) saver.cancel();
      return;
    }
    saver.schedule();
  }, [autoSaveEnabled, dirty, canAutoSave, revision]);

  const flushSave = useCallback(async (as = false, skipOverwriteConfirm = false): Promise<boolean> => {
    const saver = saverRef.current;
    if (!saver) {
      try {
        return await performSaveRef.current({
          as,
          skipOverwriteConfirm,
          isAutoSave: false,
          workerPool: poolRef.current,
          onProgress: () => {},
        });
      } catch (ex) {
        onErrorRef.current?.(String(ex));
        return false;
      }
    }

    manualRequestRef.current = { as, skipOverwriteConfirm };
    try {
      const ok = await saver.flush('manual');
      const finalState = saver.getState();
      if (!ok && finalState.phase === 'error' && finalState.error) {
        onErrorRef.current?.(finalState.error);
      }
      return ok;
    } finally {
      manualRequestRef.current = { as: false, skipOverwriteConfirm: false };
    }
  }, []);

  const resetSaveState = useCallback(() => {
    saverRef.current?.reset();
  }, []);

  return {
    asyncSaveState,
    flushSave,
    resetSaveState,
    workerPool: poolRef.current,
  };
}
