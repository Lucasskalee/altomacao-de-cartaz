import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Cartaz, Library } from './types';
import { deserialize, serialize } from './serialization';
import { findCartazesByF7 as findInIndex, getF7, indexCartazes } from './f7';
type Request = { action: string; path?: string; destination?: string; name?: string; content?: string; overwrite?: boolean };
export async function files<T>(request: Request): Promise<T> {
  if (!isTauri()) throw new Error('Abra o aplicativo desktop para acessar a biblioteca e os diálogos de arquivos.');
  return invoke<T>('files', { request });
}
export const listFiles = () => files<Library>({ action: 'list' });
/** Fresh recursive disk lookup for future batch updates; no network or mutation. */
export async function findCartazesByF7(f7: string) {
  if (!getF7(f7)) return [];
  return findInIndex(f7, indexCartazes((await listFiles()).entries));
}
export const openDocument = async (path: string) => deserialize(await files<string>({ action: 'read', path }));
export const saveDocument = (path: string, document: Cartaz, overwrite = false) => files<string>({ action: 'save', path, content: serialize(document), overwrite });
export const saveExportDocument = (path: string, document: Cartaz) => files<string>({ action: 'exportSave', path, content: serialize(document), overwrite: true });
export const chooseOpen = () => files<string | null>({ action: 'openDialog' });
export const chooseSave = (name: string) => files<string | null>({ action: 'saveDialog', name });
export const chooseFolder = () => files<string | null>({ action: 'folderDialog' });
export const createFolder = (path: string, name: string) => files<string>({ action: 'mkdir', path, name });
export const rename = (path: string, name: string) => files<string>({ action: 'rename', path, name });
export const move = (path: string, destination: string) => files<string>({ action: 'move', path, destination });
export const remove = (path: string) => files<boolean>({ action: 'delete', path });
export const parent = (path: string) => path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')));

export function normalizeLibraryPath(path: string): string {
  return path.replace(/\//g, '\\').toLowerCase();
}

/**
 * Updates or inserts a single saved cartaz entry in the in-memory Library snapshot
 * so saving a poster doesn't require re-reading thousands of files from disk.
 */
export function upsertLibraryEntry(
  library: Library | null,
  savedPath: string,
  document: Cartaz,
  modifiedAt = Date.now()
): Library | null {
  if (!library || !savedPath) return library;
  const serialized = serialize(document);
  const normSaved = normalizeLibraryPath(savedPath);
  const isPsd = normSaved.endsWith('.psd');
  const companionSkNorm = isPsd
    ? normSaved.replace(/\.psd$/i, '.skcartaz')
    : normSaved.replace(/\.skcartaz$/i, '.psd');
  const fileNamePart = savedPath.split(/[\\/]/).pop() || savedPath;

  let updatedPrimary = false;
  const nextEntries = library.entries.map(entry => {
    if (entry.folder) return entry;
    const normEntry = normalizeLibraryPath(entry.path);
    if (normEntry === normSaved) {
      updatedPrimary = true;
      return { ...entry, content: serialized, error: undefined, modifiedAt };
    }
    if (normEntry === companionSkNorm) {
      return { ...entry, content: serialized, error: undefined, modifiedAt };
    }
    return entry;
  });

  if (!updatedPrimary) {
    const normRoot = normalizeLibraryPath(library.root);
    if (normSaved.startsWith(normRoot + '\\') || normSaved.startsWith(normRoot + '/')) {
      nextEntries.push({
        path: savedPath,
        name: fileNamePart,
        folder: false,
        content: serialized,
        modifiedAt,
      });
    }
  }

  return { ...library, entries: nextEntries };
}

/**
 * Removes a deleted file or folder subtree from the in-memory Library snapshot.
 */
export function removeLibraryEntry(library: Library | null, removedPath: string): Library | null {
  if (!library || !removedPath) return library;
  const normTarget = normalizeLibraryPath(removedPath);
  const prefix = normTarget + '\\';
  const nextEntries = library.entries.filter(entry => {
    const normEntry = normalizeLibraryPath(entry.path);
    return normEntry !== normTarget && !normEntry.startsWith(prefix);
  });
  return { ...library, entries: nextEntries };
}

