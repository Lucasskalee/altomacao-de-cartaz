import { invoke, isTauri } from '@tauri-apps/api/core';

export async function selectPsd(): Promise<{name:string;buffer:ArrayBuffer} | null> {
  if (!isTauri()) throw new Error('Abra o aplicativo desktop para selecionar um PSD local.');
  const path=await invoke<string | null>('choose_psd'); if (!path) return null;
  const buffer=await invoke<ArrayBuffer>('read_psd',{path});
  return {name:path.split(/[\\/]/).pop() || 'arte.psd',buffer};
}
