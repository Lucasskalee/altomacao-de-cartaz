import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Cartaz, Library } from './types';
import { deserialize, serialize } from './serialization';
type Request = { action: string; path?: string; destination?: string; name?: string; content?: string; overwrite?: boolean };
export async function files<T>(request: Request): Promise<T> {
  if (!isTauri()) throw new Error('Abra o aplicativo desktop para acessar a biblioteca e os diálogos de arquivos.');
  return invoke<T>('files', { request });
}
export const listFiles = () => files<Library>({ action: 'list' });
export const openDocument = async (path: string) => deserialize(await files<string>({ action: 'read', path }));
export const saveDocument = (path: string, document: Cartaz, overwrite = false) => files<string>({ action: 'save', path, content: serialize(document), overwrite });
export const chooseOpen = () => files<string | null>({ action: 'openDialog' });
export const chooseSave = (name: string) => files<string | null>({ action: 'saveDialog', name });
export const chooseFolder = () => files<string | null>({ action: 'folderDialog' });
export const createFolder = (path: string, name: string) => files<string>({ action: 'mkdir', path, name });
export const rename = (path: string, name: string) => files<string>({ action: 'rename', path, name });
export const move = (path: string, destination: string) => files<string>({ action: 'move', path, destination });
export const remove = (path: string) => files<boolean>({ action: 'delete', path });
export const parent = (path: string) => path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')));
