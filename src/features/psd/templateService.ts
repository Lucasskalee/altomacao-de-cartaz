import type { Cartaz, ImportedArtwork, PosterTemplateModel } from '../cartazes/types';
import { analyzePsd, buildArtwork } from './importer';

const artworkCache = new Map<PosterTemplateModel, ImportedArtwork>();

export function getTemplateFileName(model: PosterTemplateModel): string {
  switch (model) {
    case 'vencimento':
      return 'modelo_vencimento.psd';
    case 'caixa':
      return 'modelo_caixa.psd';
    default:
      return 'modelo_oferta.psd';
  }
}

export async function fetchTemplateBuffer(model: PosterTemplateModel): Promise<ArrayBuffer> {
  const fileName = getTemplateFileName(model);
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
  const fileName = getTemplateFileName(model);
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
      name: initial?.name || (model === 'vencimento' ? 'BALANCE' : model === 'caixa' ? 'CERVEJA AMSTEL' : 'PRODUTO'),
      complement: initial?.complement || (model === 'vencimento' ? 'SABORES' : model === 'caixa' ? 'LAGER LATA 269ML' : 'SABORES'),
      category: initial?.category || (model === 'vencimento' ? 'RAÇÃO' : model === 'caixa' ? 'BEBIDAS' : 'MERCEARIA'),
      unit: initial?.unit || (model === 'vencimento' ? '900G' : 'UN'),
      priceCents: initial?.priceCents ?? (model === 'caixa' ? 269 : 1197),
      productCode: initial?.productCode ?? null,
      validityText: initial?.validityText || (model === 'vencimento' ? '02/12' : ''),
      hasBoxPrice: model === 'caixa' ? true : Boolean((initial as any)?.hasBoxPrice),
      boxQuantity: model === 'caixa' ? ((initial as any)?.boxQuantity ?? 12) : (initial as any)?.boxQuantity,
      boxUnitLabel: ((initial as any)?.boxUnitLabel as string) || 'UND.',
      boxPriceCents: model === 'caixa' ? ((initial as any)?.boxPriceCents ?? 3228) : (initial as any)?.boxPriceCents,
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

export function isOfficialTemplateArtwork(artwork?: ImportedArtwork | null): boolean {
  if (!artwork) return false;
  const srcPath = (artwork.source?.sourcePath || '').replace(/\\/g, '/').toLowerCase();
  const fileName = (artwork.source?.fileName || '').toLowerCase();
  return (
    srcPath.startsWith('/templates/') ||
    fileName === 'modelo_oferta.psd' ||
    fileName === 'modelo_caixa.psd' ||
    fileName === 'modelo_vencimento.psd' ||
    fileName === 'modelo_fardo.psd'
  );
}

function artworkHasVencimentoLayer(artwork: ImportedArtwork): boolean {
  return (
    artwork.priceParts.some(p => p.role === 'validity') ||
    artwork.layers.some(
      l => l.visible && /vencimento|pr[oó]ximo\s+ao\s+vencimento|n[aã]o\s+efetuamos\s+a\s+troca/i.test(l.text ?? l.name)
    )
  );
}

export async function switchPosterModel(
  currentDoc: Cartaz,
  targetModel: PosterTemplateModel
): Promise<Cartaz> {
  const isCustomUserPsd =
    currentDoc.layout.template === 'imported-psd' &&
    !isOfficialTemplateArtwork(currentDoc.layout.artwork);

  let artwork: ImportedArtwork;
  if (isCustomUserPsd && currentDoc.layout.template === 'imported-psd') {
    // Se o cartaz for um PSD customizado importado pelo usuário, preservamos a arte original
    // exceto ao migrar para Vencimento quando o PSD customizado não possui camada de validade/vencimento.
    if (targetModel === 'vencimento' && !artworkHasVencimentoLayer(currentDoc.layout.artwork)) {
      artwork = await getOfficialArtwork('vencimento');
    } else {
      artwork = { ...currentDoc.layout.artwork, posterModel: targetModel };
    }
  } else if (targetModel === 'caixa') {
    // Usa o modelo base de Oferta com posterModel='caixa' para renderização ao vivo editável
    // da faixa de Caixa/Fardo no canvas (a exportação PSD direta usa modelo_caixa.psd).
    const baseOffer = await getOfficialArtwork('oferta');
    artwork = { ...baseOffer, posterModel: 'caixa' };
  } else {
    artwork = await getOfficialArtwork(targetModel);
  }

  const currentProd = currentDoc.product;
  const currentModel = getPosterModel(currentDoc);
  let validityText = currentProd.validityText ?? '';
  if (targetModel === 'vencimento') {
    validityText = validityText || '02/12';
  } else if (currentModel === 'vencimento') {
    validityText = '';
  }

  const hasBoxPrice = targetModel === 'caixa';
  const boxQuantity = currentProd.boxQuantity ?? 12;
  const boxUnitLabel = currentProd.boxUnitLabel ?? 'UND.';
  const boxPriceCents = currentProd.boxPriceCents ?? (currentDoc.product.priceCents * boxQuantity);

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
      hasBoxPrice,
      boxQuantity,
      boxUnitLabel,
      boxPriceCents,
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
    if (hasVencimento) return 'vencimento';
    const hasCaixa = Boolean((doc.product as any).hasBoxPrice) || doc.layout.artwork.layers.some(l =>
      l.visible && /caixa\s+com|fardo\s+com/i.test(l.text ?? l.name)
    );
    if (hasCaixa) return 'caixa';
    return 'oferta';
  }
  if ((doc.product as any).hasBoxPrice) return 'caixa';
  return (doc.product as any).posterModel === 'vencimento' ? 'vencimento' : 'oferta';
}
