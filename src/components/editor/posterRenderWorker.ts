import {
  preparePosterRenderPlan,
  type PosterRenderWorkerInput,
  type PreparedPosterRenderPlan,
} from './posterRenderPlan';

export type PosterWorkerRequest = {
  requestId: number;
  input: PosterRenderWorkerInput;
};

export type PosterWorkerResponse =
  | {
      requestId: number;
      ok: true;
      plan: PreparedPosterRenderPlan;
    }
  | {
      requestId: number;
      ok: false;
      error: string;
    };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<PosterWorkerRequest>) => void) | null;
  postMessage: (message: PosterWorkerResponse) => void;
};

workerScope.onmessage = (event: MessageEvent<PosterWorkerRequest>) => {
  const { requestId, input } = event.data;
  try {
    const plan = preparePosterRenderPlan(input);
    workerScope.postMessage({ requestId, ok: true, plan });
  } catch (err) {
    workerScope.postMessage({
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
