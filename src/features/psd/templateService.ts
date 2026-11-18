import type { Cartaz, ImportedArtwork, PosterTemplateModel } from '../cartazes/types';
import { analyzePsd, buildArtwork } from './importer';

const artworkCache = new Map<PosterTemplateModel, ImportedArtwork>();

export async function fetchTemplateBuffer(model: PosterTemplateModel): Promise<ArrayBuffer> {
  const fileName = model === 'vencimento' ? 'modelo_vencimento.psd' : 'modelo_oferta.psd';
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    const res = await window.fetch(`/templates/${fileName}`);
    if (!res.ok) throw new Error(`Falha ao carregar modelo oficial ${fileName}: ${res.statusText}`);
    return await res.arrayBuffer();
  }
  const proc = (globalThis as any).process;
  if (proc?.versions?.node) {
    const dynamicImport = new Function('m', 'return import(m)');
    const fs = await dynamicImport('node:fs/promises');
    const path = await dynamicImport('node:path');
    const fullPath = path.resolve(proc.cwd(), 'public/templates', fileName);
    const buf = await fs.readFile(fullPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  throw new Error('Ambiente não suportado para carregar modelos.');
}

export async function getOfficialArtwork(model: PosterTemplateModel): Promise<ImportedArtwork> {
  const cached = artworkCache.get(model);
  if (cached) return cached;
  const buffer = await fetchTemplateBuffer(model);
  const fileName = model === 'vencimento' ? 'modelo_vencimento.psd' : 'modelo_oferta.psd';
  const analysis = await analyzePsd(buffer, fileName, `/templates/${fileName}`);
  const artwork = buildArtwork(analysis, analysis.suggested, analysis.templateSuggested);
  artwork.posterModel = model;
  artworkCache.set(model, artwork);
  return artwork;
}

export function clearTemplateCache(): void {
  artworkCache.clear();
}

export async function createOfficialDocument(
  model: PosterTemplateModel,
  initial?: Partial<Cartaz['product']> & { category?: string }
): Promise<Cartaz> {
  const artwork = await getOfficialArtwork(model);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    product: {
      name: initial?.name || (model === 'vencimento' ? 'BALANCE' : 'PRODUTO'),
      complement: initial?.complement || (model === 'vencimento' ? 'SABORES' : 'SABORES'),
      category: initial?.category || (model === 'vencimento' ? 'RAÇÃO' : 'MERCEARIA'),
      unit: initial?.unit || (model === 'vencimento' ? '900G' : 'UN'),
      priceCents: initial?.priceCents ?? 1197,
      productCode: initial?.productCode ?? null,
      validityText: initial?.validityText || (model === 'vencimento' ? '02/12' : ''),
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
}

export async function switchPosterModel(
  currentDoc: Cartaz,
  targetModel: PosterTemplateModel
): Promise<Cartaz> {
  const artwork = await getOfficialArtwork(targetModel);
  const currentProd = currentDoc.product as any;
  const currentModel = getPosterModel(currentDoc);
  let validityText = currentProd.validityText ?? '';
  if (targetModel === 'vencimento' && (!validityText || currentModel === 'oferta')) {
    validityText = validityText || '02/12';
  } else if (targetModel === 'oferta' && currentModel === 'vencimento') {
    validityText = '';
  }

  return {
    ...currentDoc,
    product: {
      ...currentDoc.product,
      name: currentDoc.product.name,
      complement: currentDoc.product.complement,
      category: currentProd.category || '',
      unit: currentDoc.product.unit || 'UN',
      priceCents: currentDoc.product.priceCents,
      productCode: currentDoc.product.productCode ?? null,
      validityText,
    },
    layout: {
      ...currentDoc.layout,
      template: 'imported-psd',
      artwork,
    },
    metadata: {
      ...currentDoc.metadata,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function getPosterModel(doc: Cartaz): PosterTemplateModel {
  if (doc.layout.template === 'imported-psd') {
    if (doc.layout.artwork.posterModel) return doc.layout.artwork.posterModel;
    const hasVencimento = doc.layout.artwork.layers.some(l =>
      l.visible && /vencimento|pr[oó]ximo\s+ao\s+vencimento|n[aã]o\s+efetuamos\s+a\s+troca/i.test(l.text ?? l.name)
    );
    return hasVencimento ? 'vencimento' : 'oferta';
  }
  return (doc.product as any).posterModel === 'vencimento' ? 'vencimento' : 'oferta';
}
