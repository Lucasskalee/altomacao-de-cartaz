export type AsyncSavePhase = 'idle' | 'scheduled' | 'saving' | 'saved' | 'error';

export type AsyncSaveProgress = {
  percent: number;
  stage: string;
};

export type AsyncSaveState = {
  phase: AsyncSavePhase;
  percent: number;
  stage: string;
  queuedChanges: number;
  lastSavedAt: number | null;
  error: string | null;
};

export const INITIAL_ASYNC_SAVE_STATE: AsyncSaveState = {
  phase: 'idle',
  percent: 0,
  stage: '',
  queuedChanges: 0,
  lastSavedAt: null,
  error: null,
};

export type DebouncedSaveReason = 'auto' | 'manual';

export type DebouncedAsyncSaverOptions = {
  debounceMs?: number;
  performSave: (context: {
    reason: DebouncedSaveReason;
    onProgress: (progress: AsyncSaveProgress) => void;
  }) => Promise<boolean>;
  onStateChange?: (state: AsyncSaveState) => void;
};

export type DebouncedAsyncSaver = {
  schedule: () => void;
  flush: (reason?: DebouncedSaveReason) => Promise<boolean>;
  cancel: () => void;
  reset: () => void;
  isInFlight: () => boolean;
  getState: () => AsyncSaveState;
  dispose: () => void;
};

/**
 * Yields control back to the browser event loop so keystrokes, cursor updates,
 * and canvas interactions stay responsive between heavy serialization/write steps.
 */
export function yieldToMain(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

/**
 * Coordinates debounced, single-flight asynchronous saves.
 * - Coalesces rapid edits into a single disk write after `debounceMs` of inactivity.
 * - Serializes writes so two disk operations never race on the same file.
 * - If edits occur while a write is in flight, queues one follow-up save automatically
 *   so the latest state is never lost.
 * - Supports immediate `flush('manual')` for Ctrl+S / Save button / batch navigation.
 */
export function createDebouncedAsyncSaver(options: DebouncedAsyncSaverOptions): DebouncedAsyncSaver {
  const debounceMs = Math.max(0, options.debounceMs ?? 900);
  let state: AsyncSaveState = { ...INITIAL_ASYNC_SAVE_STATE };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlightPromise: Promise<boolean> | null = null;
  let pendingFollowUp = false;
  let pendingReason: DebouncedSaveReason = 'auto';
  let disposed = false;

  const emit = (patch: Partial<AsyncSaveState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    options.onStateChange?.(state);
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const executeRun = async (initialReason: DebouncedSaveReason): Promise<boolean> => {
    let reason: DebouncedSaveReason = initialReason;
    let lastResult = false;

    while (!disposed) {
      pendingFollowUp = false;
      emit({
        phase: 'saving',
        percent: 12,
        stage: reason === 'auto' ? 'Salvando automaticamente…' : 'Preparando salvamento…',
        error: null,
      });

      try {
        const ok = await options.performSave({
          reason,
          onProgress: progress => {
            if (disposed) return;
            const clamped = Math.max(0, Math.min(100, Math.round(progress.percent)));
            emit({
              phase: 'saving',
              percent: clamped,
              stage: progress.stage,
              error: null,
            });
          },
        });
        lastResult = ok;

        if (disposed) return ok;

        if (pendingFollowUp) {
          // New edits arrived while writing: immediately coalesce into one follow-up write
          reason = pendingReason;
          pendingReason = 'auto';
          emit({
            phase: 'saving',
            percent: 15,
            stage: 'Gravando alterações recentes…',
            queuedChanges: Math.max(0, state.queuedChanges - 1),
          });
          continue;
        }

        if (ok) {
          emit({
            phase: 'saved',
            percent: 100,
            stage: 'Salvo no computador',
            queuedChanges: 0,
            lastSavedAt: Date.now(),
            error: null,
          });
        } else {
          // User cancelled save dialog or no save was needed
          emit({
            phase: 'idle',
            percent: 0,
            stage: '',
            queuedChanges: 0,
            error: null,
          });
        }
        return ok;
      } catch (err) {
        pendingFollowUp = false;
        const message = err instanceof Error ? err.message : String(err);
        emit({
          phase: 'error',
          percent: 0,
          stage: 'Falha ao salvar',
          queuedChanges: 0,
          error: message,
        });
        return false;
      }
    }

    return lastResult;
  };

  const startFlight = (reason: DebouncedSaveReason): Promise<boolean> => {
    if (inFlightPromise) {
      pendingFollowUp = true;
      if (reason === 'manual') pendingReason = 'manual';
      return inFlightPromise;
    }

    const promise = executeRun(reason).finally(() => {
      inFlightPromise = null;
    });
    inFlightPromise = promise;
    return promise;
  };

  return {
    schedule() {
      if (disposed) return;
      clearTimer();

      if (inFlightPromise) {
        pendingFollowUp = true;
        emit({
          queuedChanges: state.queuedChanges + 1,
        });
        return;
      }

      emit({
        phase: 'scheduled',
        percent: 8,
        stage: 'Aguardando pausa para salvar…',
        queuedChanges: state.queuedChanges + 1,
        error: null,
      });

      timer = setTimeout(() => {
        timer = null;
        if (!disposed) {
          void startFlight('auto');
        }
      }, debounceMs);
    },

    async flush(reason: DebouncedSaveReason = 'manual') {
      if (disposed) return false;
      clearTimer();
      return startFlight(reason);
    },

    cancel() {
      clearTimer();
      pendingFollowUp = false;
      if (!inFlightPromise && state.phase === 'scheduled') {
        emit({
          phase: 'idle',
          percent: 0,
          stage: '',
          queuedChanges: 0,
        });
      }
    },

    reset() {
      clearTimer();
      pendingFollowUp = false;
      if (!inFlightPromise) {
        state = { ...INITIAL_ASYNC_SAVE_STATE };
        if (!disposed) {
          options.onStateChange?.(state);
        }
      }
    },

    isInFlight() {
      return inFlightPromise !== null;
    },

    getState() {
      return state;
    },

    dispose() {
      disposed = true;
      clearTimer();
      pendingFollowUp = false;
    },
  };
}
