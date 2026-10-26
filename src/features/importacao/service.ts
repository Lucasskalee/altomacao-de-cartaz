import { invoke, isTauri } from '@tauri-apps/api/core';
import { indexCartazes } from '../cartazes/f7';
import { listFiles } from '../cartazes/storage';
import { comparePrices } from './comparison';
import type { DbfData, DbfEncoding } from './types';

export async function selectDbf(): Promise<{ name: string; buffer: ArrayBuffer } | null> {
  if (!isTauri()) throw new Error('Abra o aplicativo desktop para selecionar um DBF local.');
  const file = await invoke<{ name: string; path: string } | null>('choose_dbf');
  if (!file) return null;
  const buffer = await invoke<ArrayBuffer>('read_dbf', { path: file.path });
  return { name: file.name, buffer };
}
export function parseInWorker(buffer: ArrayBuffer, encoding: DbfEncoding, signal: AbortSignal): Promise<DbfData> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./dbf.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { worker.terminate(); signal.removeEventListener('abort', cancel); };
    const cancel = () => { finish(); reject(new Error('Leitura cancelada.')); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = event => {
      finish();
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.data);
    };
    worker.onerror = () => { finish(); reject(new Error('Falha ao processar o DBF local.')); };
    const copy = buffer.slice(0); worker.postMessage({ buffer: copy, encoding }, [copy]);
  });
}
export async function compareWithLibrary(data: DbfData) {
  const library = await listFiles();
  const index = indexCartazes(library.entries);
  return { rows: comparePrices(data.products, index), invalidCartazes: library.entries.filter(entry => !entry.folder).length - index.length };
}
