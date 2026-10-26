import { readPsd, type Layer, type Psd, type RGB, type RGBA, type FRGB } from 'ag-psd';
import type { ImportedArtwork, ImportedLayerInfo, ImportedPricePart, ImportedPriceRole } from '../cartazes/types';

export const PSD_MAX_BYTES = 25 * 1024 * 1024;
export type PsdRoleMap = Partial<Record<ImportedPriceRole, string>>;
export type PsdProductMetadata = { name: string; complement: string; unit: string; price: string };
export type PsdAnalysis = {
  fileName: string; hash: string; width: number; height: number; resolutionPpi: number;
  originalPreview: string; layers: ImportedLayerInfo[]; suggested: PsdRoleMap; metadata: PsdProductMetadata; warnings: string[];
  psd: Psd; runtime: Map<string, Layer>;
};

export async function analyzePsd(bytes: ArrayBuffer, fileName: string): Promise<PsdAnalysis> {
  if (bytes.byteLength < 26 || bytes.byteLength > PSD_MAX_BYTES) throw new Error('O PSD deve ter entre 26 bytes e 25 MB.');
  const signature = new TextDecoder('ascii').decode(bytes.slice(0, 4));
  if (signature !== '8BPS') throw new Error('Arquivo inválido: assinatura PSD não encontrada.');
  let psd: Psd;
  try {
    psd = readPsd(bytes, { skipThumbnail: true, skipLinkedFilesData: true, totalMemoryLimit: 256 * 1024 * 1024, throwForMissingFeatures: false });
  } catch (error) { throw new Error(`Não foi possível interpretar o PSD: ${String(error)}`); }
  if (psd.width < 1 || psd.height < 1 || psd.width > 10_000 || psd.height > 10_000) throw new Error('Dimensões PSD fora do limite de 10.000 × 10.000 px.');
  if (psd.bitsPerChannel !== 8 || psd.colorMode !== 3) throw new Error('O piloto aceita somente PSD RGB com 8 bits por canal.');
  if (!psd.canvas) throw new Error('O PSD não contém uma composição visual utilizável.');
  const runtime = new Map<string, Layer>();
  const layers: ImportedLayerInfo[] = [];
  flatten(psd.children ?? [], 0, '', true, runtime, layers);
  if (layers.length > 300) throw new Error('O PSD excede o limite de 300 camadas.');
  const suggested = suggest(layers);
  const metadata = extractMetadata(layers, suggested);
  const warnings: string[] = [];
  const ratio = psd.width / psd.height, a5 = 148 / 210;
  if (Math.abs(ratio - a5) / a5 > .005) warnings.push('A proporção difere do A5; será aplicado encaixe proporcional com margens, sem distorção.');
  if (!suggested.whole || !suggested.fraction) warnings.push('Confirme manualmente as camadas de reais e centavos.');
  if (!metadata.price) warnings.push('O preço original não pôde ser reconhecido automaticamente nas camadas. Informe o preço e confirme o mapeamento.');
  const resolutionPpi = psd.imageResources?.resolutionInfo?.horizontalResolution ?? 72;
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2,'0')).join('');
  return { fileName, hash, width: psd.width, height: psd.height, resolutionPpi, originalPreview: psd.canvas.toDataURL('image/png'), layers, suggested, metadata, warnings, psd, runtime };
}

function flatten(source: Layer[], depth: number, prefix: string, parentVisible: boolean, runtime: Map<string, Layer>, result: ImportedLayerInfo[]) {
  source.forEach((layer, index) => {
    const id = prefix ? `${prefix}.${index}` : String(index);
    const visible = parentVisible && !layer.hidden;
    runtime.set(id, layer);
    const bounds = { left: layer.left ?? 0, top: layer.top ?? 0, right: layer.right ?? 0, bottom: layer.bottom ?? 0 };
    const type = layer.children ? 'group' : layer.text ? 'text' : layer.vectorFill || layer.vectorStroke ? 'vector' : layer.canvas ? 'raster' : 'empty';
    const style = layer.text?.style ?? layer.text?.styleRuns?.[0]?.style;
    result.push({ id, name: layer.name || `Camada ${index + 1}`, type, visible, depth, bounds, text: layer.text?.text?.trim() || undefined, font: style?.font?.name });
    if (layer.children) flatten(layer.children, depth + 1, id, visible, runtime, result);
  });
}

function suggest(layers: ImportedLayerInfo[]): PsdRoleMap {
  const visible = layers.filter(layer => layer.visible);
  const byText = (pattern: RegExp) => visible.find(layer => pattern.test(layer.text?.trim() ?? ''))?.id;
  const decimalId = byText(/^,$/);
  const fractionRuleId = visible.find(layer => /rectangle\s*3|linha.*cent|cent.*linha/i.test(layer.name))?.id;

  const numericCandidates = visible.filter(layer => {
    if (layer.id === decimalId || layer.id === fractionRuleId) return false;
    const text = (layer.text ?? layer.name ?? '').trim();
    return /^\d{1,3}$/.test(text);
  });

  if (numericCandidates.length >= 2) {
    // Em cartazes A5, os Reais (parte inteira) ficam à esquerda e os Centavos (2 dígitos) ficam à direita
    const sortedByLeft = [...numericCandidates].sort((a, b) => {
      const centerA = (a.bounds.left + a.bounds.right) / 2;
      const centerB = (b.bounds.left + b.bounds.right) / 2;
      if (Math.abs(centerA - centerB) > 10) return centerA - centerB;
      const heightA = a.bounds.bottom - a.bounds.top;
      const heightB = b.bounds.bottom - b.bounds.top;
      return heightB - heightA;
    });
    const wholeCandidate = sortedByLeft[0];
    const fractionCandidate =
      sortedByLeft.slice(1).find(layer => /^\d{2}$/.test((layer.text ?? layer.name ?? '').trim())) ??
      sortedByLeft[1];
    return {
      whole: wholeCandidate?.id,
      fraction: fractionCandidate?.id,
      decimal: decimalId,
      fractionRule: fractionRuleId,
    };
  }

  return {
    whole: byText(/^\d{1,3}$/),
    fraction:
      visible.find(layer => /^\d{2}$/.test(layer.text?.trim() ?? '') && layer.id !== byText(/^\d{1,3}$/))?.id ??
      visible.find(layer => /^\d{2}$/.test(layer.name))?.id,
    decimal: decimalId,
    fractionRule: fractionRuleId,
  };
}

export function extractPriceFromRoles(layers: ImportedLayerInfo[], roles: PsdRoleMap): string {
  if (!roles.whole || !roles.fraction) return '';
  const wholeLayer = layers.find(layer => layer.id === roles.whole);
  const fractionLayer = layers.find(layer => layer.id === roles.fraction);
  const wholeRaw = (wholeLayer?.text ?? wholeLayer?.name ?? '').trim();
  const fractionRaw = (fractionLayer?.text ?? fractionLayer?.name ?? '').trim();
  if (!/^\d{1,6}$/.test(wholeRaw) || !/^\d{1,2}$/.test(fractionRaw)) return '';
  return `${wholeRaw},${fractionRaw.padEnd(2, '0')}`;
}

export function extractMetadata(layers: ImportedLayerInfo[], roles: PsdRoleMap): PsdProductMetadata {
  const excluded = new Set(Object.values(roles).filter(Boolean));
  const unitRegex = /^(KG|UN|PCT|CX|LT|BDJ|MACO|MAÇO|DZ|GR|G|ML)$/i;
  const visible = layers.filter(layer => layer.visible && !excluded.has(layer.id));
  const unitLayer = visible.find(layer => unitRegex.test((layer.text ?? layer.name).trim()));
  const unit = unitLayer ? (unitLayer.text ?? unitLayer.name).trim().toUpperCase().slice(0, 12) : '';
  const textLayers = visible
    .filter(layer => layer.type === 'text' && layer.text && layer.id !== unitLayer?.id && !/^[\d,.\sR$]+$/i.test(layer.text.trim()) && !unitRegex.test(layer.text.trim()))
    .sort((a, b) => a.bounds.top - b.bounds.top);
  const name = (textLayers[0]?.text ?? '').trim().toUpperCase().slice(0, 32);
  const complement = (textLayers[1]?.text ?? '').trim().toUpperCase().slice(0, 28);
  const price = extractPriceFromRoles(layers, roles);
  return { name, complement, unit, price };
}

export function buildArtwork(analysis: PsdAnalysis, roles: PsdRoleMap): ImportedArtwork {
  if (!roles.whole || !roles.fraction) throw new Error('Selecione as camadas de reais e centavos.');
  const selected = new Set(Object.values(roles).filter(Boolean));
  if (selected.size !== Object.values(roles).filter(Boolean).length) throw new Error('Cada função do preço deve usar uma camada diferente.');
  const staticBackground = composeStatic(analysis, selected);
  const priceParts = (Object.entries(roles) as [ImportedPriceRole,string | undefined][]).flatMap(([role,id]) => id ? [partFromLayer(role,id,analysis)] : []);
  const warnings = [...analysis.warnings], preparation: string[] = [];
  const wholePart = priceParts.find(item => item.role === 'whole');
  const fractionPart = priceParts.find(item => item.role === 'fraction');
  if (wholePart && fractionPart) {
    const wholeCenterX = (wholePart.bounds.left + wholePart.bounds.right) / 2;
    const fractionCenterX = (fractionPart.bounds.left + fractionPart.bounds.right) / 2;
    if (wholeCenterX > fractionCenterX + 8) {
      preparation.push('As camadas de Reais e Centavos estão invertidas (Reais posicionado à direita dos Centavos). Inverta o mapeamento antes de salvar.');
    }
  }
  for (const id of selected) {
    const layer = analysis.runtime.get(id!);
    const role=(Object.entries(roles) as [ImportedPriceRole,string | undefined][]).find(([,value])=>value===id)?.[0];
    if (!layer || layer.hidden) preparation.push(`A camada dinâmica ${id} não está visível.`);
    if (role !== 'fractionRule' && (!layer?.text || (layer.text.style ?? layer.text.styleRuns?.[0]?.style)?.font?.name !== 'Zullia')) preparation.push(`A camada ${layer?.name ?? id} não usa texto Zullia compatível com o piloto.`);
  }
  for(const layer of analysis.runtime.values()) {
    const hasRasterMask = Boolean((layer.mask && !layer.mask.disabled && !layer.mask.fromVectorData) || (layer.realMask && !layer.realMask.disabled));
    if(!layer.hidden&&(layer.clipping||hasRasterMask)) preparation.push(`A camada ${layer.name ?? '(sem nome)'} usa máscara ou recorte ainda não suportado.`);
  }
  warnings.push(...new Set(preparation));
  return {
    kind: 'imported-psd', compatibility: preparation.length ? 'requires-preparation' : 'ready',
    source: { fileName: analysis.fileName, sha256: analysis.hash },
    canvas: { width: analysis.width, height: analysis.height, resolutionPpi: analysis.resolutionPpi, fit: 'contain' },
    staticBackground, originalPreview: analysis.originalPreview, priceParts, layers: analysis.layers, warnings,
  };
}

function composeStatic(analysis: PsdAnalysis, excluded: Set<string>): string {
  const canvas = document.createElement('canvas'); canvas.width = analysis.width; canvas.height = analysis.height;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas indisponível para compor a arte.');
  context.clearRect(0,0,canvas.width,canvas.height);
  drawLayers(context, analysis.psd.children ?? [], '', excluded, true);
  return canvas.toDataURL('image/png');
}

function drawLayers(context: CanvasRenderingContext2D, layers: Layer[], prefix: string, excluded: Set<string>, parentVisible: boolean) {
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index], id = prefix ? `${prefix}.${index}` : String(index), visible = parentVisible && !layer.hidden;
    if (!visible || excluded.has(id)) continue;
    if (layer.children) { drawLayers(context, layer.children, id, excluded, visible); continue; }
    if (!layer.canvas) continue;
    context.save();
    context.globalAlpha = typeof layer.opacity === 'number' ? Math.min(1, layer.opacity > 1 ? layer.opacity / 255 : layer.opacity) : 1;
    context.globalCompositeOperation = blend(layer.blendMode);
    context.drawImage(layer.canvas, layer.left ?? 0, layer.top ?? 0);
    context.restore();
  }
}

function blend(mode: Layer['blendMode']): GlobalCompositeOperation {
  const supported: Partial<Record<NonNullable<Layer['blendMode']>,GlobalCompositeOperation>> = { normal:'source-over', multiply:'multiply', screen:'screen', overlay:'overlay', darken:'darken', lighten:'lighten', difference:'difference', exclusion:'exclusion', 'color dodge':'color-dodge', 'color burn':'color-burn', 'hard light':'hard-light', 'soft light':'soft-light', hue:'hue', saturation:'saturation', color:'color', luminosity:'luminosity' };
  return supported[mode ?? 'normal'] ?? 'source-over';
}

function partFromLayer(role: ImportedPriceRole, id: string, analysis: PsdAnalysis): ImportedPricePart {
  const layer = analysis.runtime.get(id); if (!layer) throw new Error('Camada mapeada não encontrada.');
  const info = analysis.layers.find(item => item.id === id)!;
  const style = layer.text?.style ?? layer.text?.styleRuns?.[0]?.style;
  const shadow = layer.effects?.dropShadow?.find(item => item.enabled !== false);
  const distance = shadow?.distance?.value ?? 0, angle = (shadow?.angle ?? 120) * Math.PI / 180;
  return {
    role, layerId: id, bounds: info.bounds, fontFamily: style?.font?.name,
    fontSize: style?.fontSize, originalText: layer.text?.text?.trim(), transform: layer.text?.transform as ImportedPricePart['transform'],
    color: colorHex((role === 'fractionRule' && layer.vectorFill?.type === 'color' ? layer.vectorFill.color : style?.fillColor) as RGB | RGBA | FRGB | undefined),
    shadow: shadow ? { dx: -Math.cos(angle) * distance, dy: Math.sin(angle) * distance, blur: shadow.size?.value ?? 0, color: '#000000' } : undefined,
  };
}

function colorHex(color?: RGB | RGBA | FRGB): string {
  if (!color) return '#c74624';
  const raw = 'fr' in color ? [color.fr,color.fg,color.fb] : [color.r,color.g,color.b];
  const values = raw.map(value => Math.round(Math.max(0,Math.min(255, value <= 1 ? value * 255 : value))));
  return `#${values.map(value => value.toString(16).padStart(2,'0')).join('')}`;
}
