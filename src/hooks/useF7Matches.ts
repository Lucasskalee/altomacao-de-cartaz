import { useEffect, useMemo, useState } from 'react';
import {
  findCartazesByF7 as findInIndex,
  getF7,
  indexCartazes,
  type IndexedCartaz,
} from '../features/cartazes/f7';
import { findCartazesByF7 } from '../features/cartazes/storage';
import type { Entry } from '../features/cartazes/types';

export function useF7Matches(
  value: unknown,
  currentPath: string | null,
  libraryEntries?: Entry[] | null
) {
  const f7 = getF7(value);
  const [revision, setRevision] = useState(0);
  const hasMemoryIndex = Array.isArray(libraryEntries);

  // Build in-memory F7 index once per library snapshot instead of scanning 3,000+ files on every keystroke.
  const memoryIndex = useMemo(
    () => (hasMemoryIndex ? indexCartazes(libraryEntries) : null),
    [hasMemoryIndex, libraryEntries]
  );

  const memoryMatches = useMemo(() => {
    if (!f7 || !memoryIndex) return null;
    return findInIndex(f7, memoryIndex).filter(item => item.path !== currentPath);
  }, [f7, memoryIndex, currentPath]);

  const request = useMemo(() => ({ f7, currentPath, revision }), [f7, currentPath, revision]);
  const [result, setResult] = useState<{
    request: typeof request | null;
    matches: IndexedCartaz[];
    checking: boolean;
    error: string;
  }>({ request: null, matches: [], checking: false, error: '' });

  useEffect(() => {
    if (!request.f7 || hasMemoryIndex) return;
    const code = request.f7;
    let active = true;
    // Fallback disk lookup when library entries haven't been loaded into memory yet.
    const timer = window.setTimeout(() => {
      setResult({ request, matches: [], checking: true, error: '' });
      findCartazesByF7(code)
        .then(matches => {
          if (active) setResult({ request, matches, checking: false, error: '' });
        })
        .catch(error => {
          if (active) setResult({ request, matches: [], checking: false, error: String(error) });
        });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [request, hasMemoryIndex]);

  if (hasMemoryIndex) {
    return {
      matches: memoryMatches ?? [],
      checking: false,
      error: '',
      refresh: () => setRevision(previous => previous + 1),
    };
  }

  return {
    matches: f7 && result.request === request ? result.matches.filter(item => item.path !== currentPath) : [],
    checking: Boolean(f7 && (result.request !== request || result.checking)),
    error: f7 && result.request === request ? result.error : '',
    refresh: () => setRevision(previous => previous + 1),
  };
}

