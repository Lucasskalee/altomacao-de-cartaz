import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Cartaz, ImportedPricePart, PartAdjustment, PosterTemplateModel } from '../features/cartazes/types';
import type { ConfirmDialogRequest } from '../components/common/ConfirmModal';
import { type AsyncSaveProgress, yieldToMain } from '../features/cartazes/asyncSave';
import { createDocument, duplicate } from '../features/cartazes/serialization';
import { formatCentsBr } from '../features/cartazes/presentation';
import { priceToCents, fileName } from '../features/cartazes/validation';
import * as storage from '../features/cartazes/storage';
import { digitsOnly } from '../features/cartazes/f7';
import {
  clampPartAdjustment,
  getPartKey,
  repairInvertedPsdArtwork,
} from '../components/editor/importedRenderer';
import { readPsdByPath, selectPsd } from '../features/psd/service';
import { analyzePsd, buildArtwork } from '../features/psd/importer';
import { prepareLinkedArtworkAutomatically } from '../features/psd/editLinkedArtwork';
import { exportDerivedPsdDirect } from '../features/scantech/directExport';
import { createOfficialDocument, fetchTemplateBuffer, getPosterModel, switchPosterModel } from '../features/psd/templateService';

export type UseCartazOptions = {
  confirmAction?: (request: ConfirmDialogRequest) => Promise<boolean>;
};

export type SaveCartazOptions = {
  skipOverwriteConfirm?: boolean;
  isAutoSave?: boolean;
  onProgress?: (progress: AsyncSaveProgress) => void;
};

/**
 * Pure state transition keeping `price` (string input) and `document.product.priceCents`
 * permanently synchronized whether edited in the Main Editor or in the Surgical Layer Editor.
 */
export function applyProductFieldChange(
  doc: Cartaz,
  currentPrice: string,
  field: string,
  value: unknown
): { document: Cartaz; price: string } {
  if (field === 'price') {
    const nextPrice = String(value ?? '');
    let nextCents = doc.product.priceCents;
    try {
      nextCents = priceToCents(nextPrice);
    } catch {
      // Keep last valid cents while the user is mid-typing (e.g., "12," or empty)
    }
    return {
      price: nextPrice,
      document:
        nextCents !== doc.product.priceCents
          ? { ...doc, product: { ...doc.product, priceCents: nextCents } }
          : doc,
    };
  }

  if (field === 'priceCents') {
    const numeric = typeof value === 'number' ? value : Number(value);
    const safeCents = Number.isFinite(numeric) && numeric >= 0 ? Math.min(99_999_999, Math.round(numeric)) : 0;
    return {
      price: formatCentsBr(safeCents),
      document: { ...doc, product: { ...doc.product, priceCents: safeCents } },
    };
  }

  const normalizedValue = field === 'productCode' && typeof value === 'string' ? digitsOnly(value) : value;
  return {
    price: currentPrice,
    document: { ...doc, product: { ...doc.product, [field]: normalizedValue } },
  };
}

/**
 * Pure helper applying or resetting a direct canvas adjustment (dx, dy, scale)
 * on a specific ImportedPricePart (`role:layerId`) or resetting all layers (`'*'`).
 */
export function applyPartAdjustmentToDocument(
  doc: Cartaz,
  partKey: string,
  adjustment: PartAdjustment | null
): Cartaz {
  if (doc.layout.template !== 'imported-psd') return doc;
  const resetAll = partKey === '*' && adjustment === null;
  const normalizedAdj = adjustment ? clampPartAdjustment(adjustment) : null;
  const isIdentity =
    !normalizedAdj || (normalizedAdj.dx === 0 && normalizedAdj.dy === 0 && normalizedAdj.scale === 1);

  const mapParts = (parts?: ImportedPricePart[]) => {
    if (!parts) return parts;
    let changed = false;
    const next = parts.map(part => {
      if (!resetAll && getPartKey(part) !== partKey) return part;
      changed = true;
      if (isIdentity) {
        const { adjustments: _removed, ...rest } = part;
        return rest;
      }
      return { ...part, adjustments: normalizedAdj };
    });
    return changed ? next : parts;
  };

  const nextPriceParts = mapParts(doc.layout.artwork.priceParts) ?? doc.layout.artwork.priceParts;
  const nextTemplateParts = mapParts(doc.layout.artwork.templateParts);

  if (
    nextPriceParts === doc.layout.artwork.priceParts &&
    nextTemplateParts === doc.layout.artwork.templateParts
  ) {
    return doc;
  }

  return {
    ...doc,
    layout: {
      ...doc.layout,
      artwork: {
        ...doc.layout.artwork,
        priceParts: nextPriceParts,
        templateParts: nextTemplateParts,
      },
    },
  };
}

/**
 * Applies multiple part adjustments atomically in a single document update
 * (used when moving/scaling the Price Group together).
 */
export function applyPartAdjustmentsBatchToDocument(
  doc: Cartaz,
  updates: Record<string, PartAdjustment | null>
): Cartaz {
  if (doc.layout.template !== 'imported-psd') return doc;
  const keys = Object.keys(updates);
  if (keys.length === 0) return doc;
  let nextDoc = doc;
  for (const key of keys) {
    nextDoc = applyPartAdjustmentToDocument(nextDoc, key, updates[key]);
  }
  return nextDoc;
}

export function useCartaz(options?: UseCartazOptions) {
  const [document, setDocument] = useState(createDocument);
  const [price, setPrice] = useState('2,89');
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);

  const documentRef = useRef(document);
  documentRef.current = document;
  const priceRef = useRef(price);
  priceRef.current = price;
  const pathRef = useRef(path);
  pathRef.current = path;
  const revisionRef = useRef(0);
  const backedUpPathRef = useRef<string | null>(null);

  const bumpRevision = () => {
    revisionRef.current += 1;
    setRevision(revisionRef.current);
  };

  const markDirty = () => {
    bumpRevision();
    setDirty(true);
  };

  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirty) return true;
    if (isTauri()) {
      return await storage.files<boolean>({ action: 'confirmDiscard' });
    }
    if (options?.confirmAction) {
      return await options.confirmAction({
        title: 'Descartar alterações não salvas?',
        description: 'Existem edições pendentes no cartaz atual. Se continuar sem salvar, essas alterações serão perdidas.',
        confirmLabel: 'Descartar alterações',
        cancelLabel: 'Voltar ao editor',
        tone: 'warning',
      });
    }
    return true;
  };

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
    const formattedPrice = formatCentsBr(d.product.priceCents);
    documentRef.current = d;
    priceRef.current = formattedPrice;
    pathRef.current = p;
    backedUpPathRef.current = null;
    bumpRevision();
    setDocument(d); setPrice(formattedPrice); setPath(p); setDirty(changed);
  };
  const current = (): Cartaz => {
    const baseDoc = documentRef.current;
    return { ...baseDoc, product: { ...baseDoc.product, priceCents: priceToCents(priceRef.current) } };
  };
  const posterModel: PosterTemplateModel = getPosterModel(document);
  return {
    document, price, path, dirty, revision, current, posterModel,
    async switchModel(targetModel: PosterTemplateModel) {
      try {
        const updated = await switchPosterModel(current(), targetModel);
        load(updated, pathRef.current, true);
        return true;
      } catch (err) {
        console.error('Erro ao alternar modelo do cartaz:', err);
        return false;
      }
    },
    async newOfficial(targetModel: PosterTemplateModel) {
      if (!await confirmDiscard()) return false;
      try {
        const doc = await createOfficialDocument(targetModel);
        load(doc, null, true);
        return true;
      } catch (err) {
        console.error('Erro ao criar cartaz com modelo oficial:', err);
        return false;
      }
    },
    fixInvertedPsdLayers() {
      const currentDoc = documentRef.current;
      if (currentDoc.layout.template !== 'imported-psd') return;
      const { artwork, correctedPriceCents } = repairInvertedPsdArtwork(currentDoc.layout.artwork);
      setDocument(d => d.layout.template === 'imported-psd' ? ({
        ...d,
        product: { ...d.product, priceCents: correctedPriceCents ?? d.product.priceCents },
        layout: { ...d.layout, artwork },
      }) : d);
      if (correctedPriceCents !== null) {
        const formatted = formatCentsBr(correctedPriceCents);
        priceRef.current = formatted;
        setPrice(formatted);
      }
      markDirty();
    },
    async refreshSaved(paths: string[]) {
      const normalize = (value: string) => value.replace(/\//g, '\\').toLowerCase();
      if (!dirty && path && paths.some(value => normalize(value) === normalize(path))) load(await storage.openDocument(path), path);
    },
    change(field: string, value: unknown) {
      if (field === 'price') {
        const nextPrice = String(value ?? '');
        priceRef.current = nextPrice;
        setPrice(nextPrice);
        try {
          const parsedCents = priceToCents(nextPrice);
          setDocument(d =>
            d.product.priceCents === parsedCents
              ? d
              : { ...d, product: { ...d.product, priceCents: parsedCents } }
          );
        } catch {
          // Keep previous valid priceCents while user finishes typing
        }
      } else if (field === 'priceCents') {
        const numeric = typeof value === 'number' ? value : Number(value);
        const safeCents = Number.isFinite(numeric) && numeric >= 0 ? Math.min(99_999_999, Math.round(numeric)) : 0;
        const formatted = formatCentsBr(safeCents);
        priceRef.current = formatted;
        setPrice(formatted);
        setDocument(d => ({ ...d, product: { ...d.product, priceCents: safeCents } }));
      } else {
        setDocument(d => ({
          ...d,
          product: {
            ...d.product,
            [field]: field === 'productCode' && typeof value === 'string' ? digitsOnly(value) : value,
          },
        }));
      }
      markDirty();
    },
    changeLayout(patch: Partial<Cartaz['layout']>) {
      setDocument(d => ({ ...d, layout: { ...d.layout, ...patch } as Cartaz['layout'] }));
      markDirty();
    },
    updatePartAdjustment(partKey: string, adjustment: PartAdjustment) {
      setDocument(d => applyPartAdjustmentToDocument(d, partKey, adjustment));
      markDirty();
    },
    updateMultiplePartAdjustments(updates: Record<string, PartAdjustment | null>) {
      setDocument(d => applyPartAdjustmentsBatchToDocument(d, updates));
      markDirty();
    },
    resetPartAdjustments(partKey?: string) {
      setDocument(d => applyPartAdjustmentToDocument(d, partKey ?? '*', null));
      markDirty();
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
    async open(p?: string, prepareTexts = false) {
      if (!await confirmDiscard()) return null;
      const selected = p ?? await storage.chooseOpen();
      if (!selected) return null;
      let document: Cartaz = null as any;
      let preparationError = '';
      let prepared = false;

      if (selected.toLowerCase().endsWith('.psd')) {
        const companionPath = selected.replace(/\.psd$/i, '.skcartaz');
        let companionLoaded = false;
        try {
          document = await storage.openDocument(companionPath);
          companionLoaded = true;
        } catch {
          // Sem companion ou companion inacessível; abre diretamente do PSD
        }

        if (!companionLoaded) {
          try {
            const source = await readPsdByPath(selected);
            const analysis = await analyzePsd(source.buffer, source.name, source.path);
            const artwork = buildArtwork(analysis, analysis.suggested, analysis.templateSuggested);
            const catText = artwork.templateParts?.find(p => p.role === 'category')?.originalText ?? '';
            const titleText = artwork.templateParts?.find(p => p.role === 'title')?.originalText ?? analysis.metadata.name;
            const compText = artwork.templateParts?.find(p => p.role === 'complement')?.originalText ?? analysis.metadata.complement;
            const packText = artwork.templateParts?.find(p => p.role === 'packaging')?.originalText ?? analysis.metadata.unit;
            const valText = artwork.priceParts?.find(p => p.role === 'validity')?.originalText ?? analysis.metadata.validityText ?? '';
            const now = new Date().toISOString();
            const upperPath = (source.path || source.name).toUpperCase();
            const detectedPaper =
              upperPath.includes('MÉDIO') || upperPath.includes('MEDIO') || upperPath.includes('A5')
                ? 'A5'
                : upperPath.includes('A4')
                ? 'A4'
                : upperPath.includes('A3')
                ? 'A3'
                : upperPath.includes('EXTERNO') || upperPath.includes('2X2')
                ? 'expositor-a3-2x2'
                : 'A6';
            document = {
              schemaVersion: 1,
              id: crypto.randomUUID(),
              product: {
                name: (titleText || 'PRODUTO').toUpperCase(),
                complement: (compText || '').toUpperCase(),
                unit: (packText || 'UN').toUpperCase(),
                priceCents: analysis.metadata.price ? priceToCents(analysis.metadata.price) : 289,
                productCode: null,
                category: catText.toUpperCase(),
                validityText: valText,
              },
              layout: {
                template: 'imported-psd',
                paper: detectedPaper,
                orientation: 'portrait',
                artwork,
              },
              metadata: {
                createdAt: now,
                updatedAt: now,
              },
            };
            prepared = true;
          } catch (ex) {
            throw new Error(`Falha ao abrir arquivo PSD: ${ex instanceof Error ? ex.message : String(ex)}`);
          }
        }
      } else {
        const original = await storage.openDocument(selected);
        document = original;
        if (prepareTexts && original.layout.template === 'imported-psd' &&
            !original.layout.artwork.templateParts?.length) {
          try {
            const sourcePath = original.layout.artwork.source.sourcePath;
            if (!sourcePath) throw new Error('O caminho do PSD original não está registrado.');
            const source = await readPsdByPath(sourcePath);
            const analysis = await analyzePsd(source.buffer, source.name, source.path);
            document = prepareLinkedArtworkAutomatically(original, analysis);
            prepared = true;
          } catch (ex) {
            preparationError = ex instanceof Error ? ex.message : String(ex);
          }
        }
      }
      load(document, selected, prepared);
      return { prepared, preparationError };
    },
    stageDocument(d: Cartaz, expectedPath: string | null) {
      if (path !== expectedPath) throw new Error('O cartaz aberto no editor mudou. Reabra-o pela pasta de ofertas antes de continuar.');
      load(d, expectedPath, true);
    },
    async save(as = false, saveOpts?: SaveCartazOptions) {
      const isAutoSave = Boolean(saveOpts?.isAutoSave);
      const report = (percent: number, stage: string) => {
        saveOpts?.onProgress?.({ percent, stage });
      };

      const activePath = pathRef.current;
      if (isAutoSave && !activePath) {
        return null;
      }

      const snapshotRevision = revisionRef.current;
      const snapshotDocId = documentRef.current.id;
      const d = as && activePath ? duplicate(current()) : current();
      const updatedAt = new Date().toISOString();
      d.metadata = { ...d.metadata, updatedAt };

      report(18, 'Validando e preparando cartaz…');
      await yieldToMain();

      const baseName = d.product.productCode
        ? `${d.product.productCode} - ${d.product.name}${d.product.complement ? ' ' + d.product.complement : ''}`
        : `${d.product.name}${d.product.complement ? ' ' + d.product.complement : ''}`;
      const cleanBase = fileName(baseName).replace(/\.skcartaz$/i, '');
      const suggestedPsdName = `${cleanBase}.psd`;

      // Web Preview / Demo fallback so debounced async save and progress UI work seamlessly without freezing
      if (!isTauri()) {
        const selected = as || !activePath
          ? `C:\\Skalee\\Cartazes\\${cleanBase}${as ? ' (copia)' : ''}.skcartaz`
          : activePath;

        report(55, 'Serializando alterações…');
        await yieldToMain();
        await new Promise(resolve => setTimeout(resolve, isAutoSave ? 90 : 120));
        report(90, 'Atualizando biblioteca local…');
        await yieldToMain();

        const sameDocStillOpen = documentRef.current.id === snapshotDocId;
        if (as || sameDocStillOpen) {
          pathRef.current = selected;
          setPath(selected);
          if (as) {
            load(d, selected, false);
          } else if (revisionRef.current === snapshotRevision) {
            setDocument(prev => ({
              ...prev,
              metadata: { ...prev.metadata, updatedAt },
            }));
            setDirty(false);
          }
        }
        report(100, 'Salvo localmente');
        return { path: selected, document: d };
      }

      const selected = as || !activePath ? await storage.chooseSave(suggestedPsdName) : activePath;
      if (!selected) return null;
      if (as && selected === activePath) throw new Error('Salvar como exige outro nome para preservar o original.');

      const isPsd = selected.toLowerCase().endsWith('.psd');
      const destPsdPath = isPsd ? selected : selected.replace(/\.skcartaz$/i, '') + '.psd';
      const destSkPath = isPsd ? selected.replace(/\.psd$/i, '') + '.skcartaz' : selected;

      // Confirmação acessível (apenas no salvamento manual) e backup automático ao sobrescrever
      if (!as && selected === activePath) {
        const docName = activePath.split(/[\\/]/).pop() || 'cartaz';
        const skipConfirm = Boolean(saveOpts?.skipOverwriteConfirm) || isAutoSave;
        const confirmed = skipConfirm
          ? true
          : options?.confirmAction
          ? await options.confirmAction({
              title: 'Salvar alterações no cartaz existente?',
              description: `As novas alterações serão gravadas em "${docName}".`,
              note: 'Um backup de segurança (.bak.skcartaz) da versão anterior será criado automaticamente antes de sobrescrever.',
              confirmLabel: 'Salvar e criar backup',
              cancelLabel: 'Cancelar',
              tone: 'primary',
            })
          : true;
        if (!confirmed) return null;

        const needsBackup = !isAutoSave || backedUpPathRef.current !== destSkPath;
        if (needsBackup) {
          report(32, 'Criando cópia de segurança…');
          await yieldToMain();
          try {
            const oldContent = await storage.files<string>({ action: 'read', path: destSkPath });
            const backupPath = destSkPath.replace(/\.skcartaz$/i, '') + '.bak.skcartaz';
            await storage.files<string>({ action: 'save', path: backupPath, content: oldContent, overwrite: true });
            backedUpPathRef.current = destSkPath;
          } catch {
            // Backup não bloqueia o salvamento
          }
        }
      }

      // No salvamento automático (debounced), priorizamos gravação rápida do .skcartaz para zero travamento.
      // No salvamento manual (Salvar / Salvar Como), sincronizamos também o arquivo .psd derivado.
      if (!isAutoSave && d.layout.template === 'imported-psd') {
        const srcPath = d.layout.artwork?.source?.sourcePath;
        const normSrc = (srcPath || '').replace(/\\/g, '/').toLowerCase();
        const normDst = destPsdPath.replace(/\\/g, '/').toLowerCase();
        const isOverwriteSame = !as && selected === activePath;

        if (normSrc !== normDst || isOverwriteSame || isPsd) {
          report(48, 'Atualizando camadas do arquivo PSD…');
          await yieldToMain();

          const wholePart = d.layout.artwork.priceParts.find(p => p.role === 'whole');
          const fractionPart = d.layout.artwork.priceParts.find(p => p.role === 'fraction');
          const catPart = d.layout.artwork.templateParts?.find(p => p.role === 'category');
          const titlePart = d.layout.artwork.templateParts?.find(p => p.role === 'title');
          const compPart = d.layout.artwork.templateParts?.find(p => p.role === 'complement');
          const packPart = d.layout.artwork.templateParts?.find(p => p.role === 'packaging');
          const valPart = d.layout.artwork.priceParts.find(p => p.role === 'validity');
          const wholeVal = formatCentsBr(d.product.priceCents).split(',')[0];
          const fractionVal = formatCentsBr(d.product.priceCents).split(',')[1];
          const boxWholeVal = (d.product as any).hasBoxPrice && (d.product as any).boxPriceCents
            ? String(Math.floor((d.product as any).boxPriceCents / 100))
            : undefined;
          const boxFractionVal = (d.product as any).hasBoxPrice && (d.product as any).boxPriceCents
            ? String((d.product as any).boxPriceCents % 100).padStart(2, '0')
            : undefined;

          let sourceBuffer: ArrayBuffer | undefined;
          let sourcePathToUse = srcPath;
          if (!srcPath || srcPath.startsWith('/templates/')) {
            try {
              sourceBuffer = await fetchTemplateBuffer(getPosterModel(d));
              sourcePathToUse = undefined;
            } catch {
              // fallback
            }
          }

          try {
            const exp = await exportDerivedPsdDirect({
              sourcePsdPath: sourcePathToUse || undefined,
              sourcePsdBuffer: sourceBuffer,
              outputPsdPath: destPsdPath,
              allowSamePath: isOverwriteSame,
              category: (d.product as any).category,
              title: d.product.name,
              complement: d.product.complement,
              packaging: d.product.unit,
              whole: wholeVal,
              fraction: fractionVal,
              validityText: (d.product as any).validityText,
              hasBoxPrice: Boolean((d.product as any).hasBoxPrice),
              boxQuantity: Number((d.product as any).boxQuantity) || 12,
              boxUnitLabel: ((d.product as any).boxUnitLabel as string) || 'UND.',
              boxWhole: boxWholeVal,
              boxFraction: boxFractionVal,
              boxPackageType: (d.product as any).boxPackageType,
              boxPackageLabel: (d.product as any).boxPackageLabel,
              unitBadgeMode: (d.product as any).unitBadgeMode,
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
              report(70, 'Verificando integridade do PSD…');
              await yieldToMain();
              const derived = await readPsdByPath(destPsdPath);
              const analysis = await analyzePsd(derived.buffer, derived.name, derived.path);
              d.layout.artwork.source = {
                ...d.layout.artwork.source,
                fileName: analysis.fileName,
                sha256: analysis.hash,
                sourcePath: destPsdPath,
              };
            }
          } catch {
            // Em caso de erro na gravação do PSD, o documento .skcartaz continua sendo salvo
          }
        }
      }

      report(84, 'Gravando arquivo no disco…');
      await yieldToMain();
      await storage.saveDocument(destSkPath, d, !as && selected === activePath);

      // Reconcilia estado sem sobrescrever edições digitadas enquanto o arquivo gravava
      const sameDocStillOpen = documentRef.current.id === snapshotDocId;
      if (as) {
        load(d, selected, false);
      } else if (sameDocStillOpen) {
        pathRef.current = selected;
        setPath(selected);
        if (revisionRef.current === snapshotRevision) {
          setDocument(prev => {
            const nextLayout =
              prev.layout.template === 'imported-psd' && d.layout.template === 'imported-psd'
                ? {
                    ...prev.layout,
                    artwork: {
                      ...prev.layout.artwork,
                      source: d.layout.artwork.source,
                    },
                  }
                : prev.layout;
            return {
              ...prev,
              layout: nextLayout,
              metadata: { ...prev.metadata, updatedAt },
            };
          });
          setDirty(false);
        }
      }

      report(100, 'Salvo no computador');
      return { path: selected, document: d };
    },
    async duplicate() { if (await confirmDiscard()) { load(duplicate(current()), null, true); return true; } return false; },
    relocate(old: string, next: string) { if (path === old || path?.startsWith(old + '\\') || path?.startsWith(old + '/')) setPath(next + path.slice(old.length)); },
    removed(old: string) { if (path === old || path?.startsWith(old + '\\') || path?.startsWith(old + '/')) { setPath(null); markDirty(); } },
  };
}
