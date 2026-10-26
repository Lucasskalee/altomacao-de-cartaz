import { parseDbf } from './dbf';
import type { DbfEncoding } from './types';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ buffer: ArrayBuffer; encoding: DbfEncoding }>) => void) | null;
  postMessage: (message: unknown) => void;
};
scope.onmessage = event => {
  try { scope.postMessage({ data: parseDbf(new Uint8Array(event.data.buffer), event.data.encoding) }); }
  catch (error) { scope.postMessage({ error: String(error) }); }
};
