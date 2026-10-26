import { useEffect, useMemo, useState } from 'react';
import { getF7, type IndexedCartaz } from '../features/cartazes/f7';
import { findCartazesByF7 } from '../features/cartazes/storage';

export function useF7Matches(value: unknown, currentPath: string | null) {
  const f7 = getF7(value);
  const [revision, setRevision] = useState(0);
  const request = useMemo(() => ({ f7, currentPath, revision }), [f7, currentPath, revision]);
  const [result, setResult] = useState<{ request: typeof request | null; matches: IndexedCartaz[]; checking: boolean; error: string }>({ request: null, matches: [], checking: false, error: '' });
  useEffect(() => {
    if (!request.f7) return;
    const code = request.f7;
    let active = true;
    // Delay disk reads while typing, and ignore stale responses after code changes.
    const timer = window.setTimeout(() => {
      setResult({ request, matches: [], checking: true, error: '' });
      findCartazesByF7(code).then(matches => {
        if (active) setResult({ request, matches, checking: false, error: '' });
      }).catch(error => {
        if (active) setResult({ request, matches: [], checking: false, error: String(error) });
      });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [request]);
  return {
    matches: f7 && result.request === request ? result.matches.filter(item => item.path !== currentPath) : [],
    checking: Boolean(f7 && (result.request !== request || result.checking)),
    error: f7 && result.request === request ? result.error : '',
    refresh: () => setRevision(previous => previous + 1),
  };
}
