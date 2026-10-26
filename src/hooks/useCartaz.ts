import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Cartaz } from '../features/cartazes/types';
import { createDocument, duplicate } from '../features/cartazes/serialization';
import { formatCentsBr } from '../features/cartazes/presentation';
import { priceToCents, fileName } from '../features/cartazes/validation';
import * as storage from '../features/cartazes/storage';
import { digitsOnly } from '../features/cartazes/f7';
import { repairInvertedPsdArtwork } from '../components/editor/importedRenderer';
export function useCartaz() {
  const [document, setDocument] = useState(createDocument);
  const [price, setPrice] = useState('2,89');
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const confirmDiscard = async () => !dirty || await storage.files<boolean>({ action: 'confirmDiscard' });
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(async event => {
      event.preventDefault();
      try { if (!dirty || await storage.files<boolean>({ action: 'confirmDiscard' })) await getCurrentWindow().destroy(); }
      catch { /* Keep window open when confirmation fails. */ }
    }).then(fn => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; unlisten?.(); };
  }, [dirty]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const load = (d: Cartaz, p: string | null, changed = false) => {
    setDocument(d); setPrice(formatCentsBr(d.product.priceCents)); setPath(p); setDirty(changed);
  };
  const current = (): Cartaz => ({ ...document, product: { ...document.product, priceCents: priceToCents(price) } });
  return {
    document, price, path, dirty, current,
    fixInvertedPsdLayers() {
      if (document.layout.template !== 'imported-psd') return;
      const { artwork, correctedPriceCents } = repairInvertedPsdArtwork(document.layout.artwork);
      setDocument(d => d.layout.template === 'imported-psd' ? ({
        ...d,
        product: { ...d.product, priceCents: correctedPriceCents ?? d.product.priceCents },
        layout: { ...d.layout, artwork },
      }) : d);
      if (correctedPriceCents !== null) setPrice(formatCentsBr(correctedPriceCents));
      setDirty(true);
    },
    async refreshSaved(paths: string[]) {
      const normalize = (value: string) => value.replace(/\//g, '\\').toLowerCase();
      if (!dirty && path && paths.some(value => normalize(value) === normalize(path))) load(await storage.openDocument(path), path);
    },
    change(field: string, value: string) {
      if (field === 'price') setPrice(value);
      else setDocument(d => ({ ...d, product: { ...d.product, [field]: field === 'productCode' ? digitsOnly(value) : value } }));
      setDirty(true);
    },
    async newDocument() { if (await confirmDiscard()) { load(createDocument(), null, true); return true; } return false; },
    async open(p?: string) {
      if (!await confirmDiscard()) return false;
      const selected = p ?? await storage.chooseOpen();
      if (!selected) return false;
      const d = await storage.openDocument(selected); load(d, selected); return true;
    },
    async save(as = false) {
      const d = current(); d.metadata = { ...d.metadata, updatedAt: new Date().toISOString() };
      const selected = as || !path ? await storage.chooseSave(fileName(d.product.name + '-' + d.product.complement)) : path;
      if (!selected) return false;
      if (as && selected === path) throw new Error('Salvar como exige outro nome para preservar o original.');
      await storage.saveDocument(selected, d, !as && selected === path);
      load(d, selected); return true;
    },
    async duplicate() { if (await confirmDiscard()) { load(duplicate(current()), null, true); return true; } return false; },
    relocate(old: string, next: string) { if (path === old || path?.startsWith(old + '\\') || path?.startsWith(old + '/')) setPath(next + path.slice(old.length)); },
    removed(old: string) { if (path === old || path?.startsWith(old + '\\') || path?.startsWith(old + '/')) { setPath(null); setDirty(true); } },
  };
}
