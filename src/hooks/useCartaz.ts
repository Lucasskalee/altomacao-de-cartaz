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
import { selectPsd } from '../features/psd/service';
import { analyzePsd, buildArtwork } from '../features/psd/importer';
import { exportDerivedPsdDirect } from '../features/scantech/directExport';
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
    async openReferencePsd() {
      if (!await confirmDiscard()) return false;
      const selected = await selectPsd();
      if (!selected) return false;
      const analysis = await analyzePsd(selected.buffer, selected.name, selected.path ?? null);
      if (!analysis.suggested.whole || !analysis.suggested.fraction) {
        throw new Error('Não foi possível identificar as camadas de reais e centavos no PSD.');
      }
      const artwork = buildArtwork(analysis, analysis.suggested, analysis.templateSuggested);
      const catText = artwork.templateParts?.find(p => p.role === 'category')?.originalText ?? '';
      const titleText = artwork.templateParts?.find(p => p.role === 'title')?.originalText ?? analysis.metadata.name;
      const compText = artwork.templateParts?.find(p => p.role === 'complement')?.originalText ?? analysis.metadata.complement;
      const packText = artwork.templateParts?.find(p => p.role === 'packaging')?.originalText ?? analysis.metadata.unit;
      const valText = artwork.priceParts?.find(p => p.role === 'validity')?.originalText ?? analysis.metadata.validityText ?? '';
      const now = new Date().toISOString();
      const doc: Cartaz = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        product: {
          name: titleText.toUpperCase(),
          complement: compText.toUpperCase(),
          unit: packText.toUpperCase() || 'UN',
          priceCents: analysis.metadata.price ? priceToCents(analysis.metadata.price) : 289,
          productCode: null,
          category: catText.toUpperCase(),
          validityText: valText,
        },
        layout: {
          template: 'imported-psd',
          paper: 'A5',
          orientation: 'portrait',
          artwork,
        },
        metadata: {
          createdAt: now,
          updatedAt: now,
        },
      };
      load(doc, null, true);
      return true;
    },
    async open(p?: string) {
      if (!await confirmDiscard()) return false;
      const selected = p ?? await storage.chooseOpen();
      if (!selected) return false;
      const d = await storage.openDocument(selected); load(d, selected); return true;
    },
    async save(as = false) {
      const d = current();
      d.metadata = { ...d.metadata, updatedAt: new Date().toISOString() };
      const baseName = d.product.productCode
        ? `${d.product.productCode} - ${d.product.name}${d.product.complement ? ' ' + d.product.complement : ''}`
        : `${d.product.name}${d.product.complement ? ' ' + d.product.complement : ''}`;
      const selected = as || !path ? await storage.chooseSave(fileName(baseName)) : path;
      if (!selected) return false;
      if (as && selected === path) throw new Error('Salvar como exige outro nome para preservar o original.');

      // Cenário 5: Confirmação e backup ao salvar alterações sobre o mesmo cartaz existente
      if (!as && selected === path) {
        const docName = path.split(/[\\/]/).pop() || 'cartaz';
        const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(`Deseja salvar as alterações em "${docName}"?\n\nUm backup de segurança do cartaz anterior será criado automaticamente.`)
          : true;
        if (!confirmed) return false;

        try {
          const oldContent = await storage.files<string>({ action: 'read', path });
          const backupPath = path.replace(/\.skcartaz$/i, '') + '.bak.skcartaz';
          await storage.files<string>({ action: 'save', path: backupPath, content: oldContent, overwrite: true });
        } catch {
          // Backup não bloqueia o salvamento
        }
      }

      if (d.layout.template === 'imported-psd' && d.layout.artwork.source.sourcePath) {
        const destPsdPath = selected.replace(/\.skcartaz$/i, '') + '.psd';
        const normSrc = d.layout.artwork.source.sourcePath.replace(/\\/g, '/').toLowerCase();
        const normDst = destPsdPath.replace(/\\/g, '/').toLowerCase();
        const isOverwriteSame = !as && selected === path;

        if (normSrc !== normDst || isOverwriteSame) {
          const wholePart = d.layout.artwork.priceParts.find(p => p.role === 'whole');
          const fractionPart = d.layout.artwork.priceParts.find(p => p.role === 'fraction');
          const catPart = d.layout.artwork.templateParts?.find(p => p.role === 'category');
          const titlePart = d.layout.artwork.templateParts?.find(p => p.role === 'title');
          const compPart = d.layout.artwork.templateParts?.find(p => p.role === 'complement');
          const packPart = d.layout.artwork.templateParts?.find(p => p.role === 'packaging');
          const valPart = d.layout.artwork.priceParts.find(p => p.role === 'validity');
          const wholeVal = formatCentsBr(d.product.priceCents).split(',')[0];
          const fractionVal = formatCentsBr(d.product.priceCents).split(',')[1];
          try {
            const exp = await exportDerivedPsdDirect({
              sourcePsdPath: d.layout.artwork.source.sourcePath,
              outputPsdPath: destPsdPath,
              allowSamePath: isOverwriteSame,
              category: (d.product as any).category,
              title: d.product.name,
              complement: d.product.complement,
              packaging: d.product.unit,
              whole: wholeVal,
              fraction: fractionVal,
              validityText: (d.product as any).validityText,
              roles: {
                wholeLayerId: wholePart?.layerId,
                fractionLayerId: fractionPart?.layerId,
                categoryLayerId: catPart?.layerId,
                titleLayerId: titlePart?.layerId,
                complementLayerId: compPart?.layerId,
                packagingLayerId: packPart?.layerId,
                validityLayerId: valPart?.layerId,
              },
            });
            if (exp.ok) {
              d.layout.artwork.source.sourcePath = destPsdPath;
            }
          } catch {
            // Em caso de erro na gravação do PSD, o documento .skcartaz continua sendo salvo
          }
        }
      }

      await storage.saveDocument(selected, d, !as && selected === path);
      load(d, selected);
      return true;
    },
    async duplicate() { if (await confirmDiscard()) { load(duplicate(current()), null, true); return true; } return false; },
    relocate(old: string, next: string) { if (path === old || path?.startsWith(old + '\\') || path?.startsWith(old + '/')) setPath(next + path.slice(old.length)); },
    removed(old: string) { if (path === old || path?.startsWith(old + '\\') || path?.startsWith(old + '/')) { setPath(null); setDirty(true); } },
  };
}
