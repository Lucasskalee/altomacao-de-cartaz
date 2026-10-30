import type { ImportedArtwork, ImportedPricePart } from '../cartazes/types';

export const MIN_TITLE_HORIZONTAL_SCALE = 0.65;
export const MIN_TITLE_FONT_SIZE_RATIO = 0.55;

export type TextLayoutAdjustment = {
  originalText: string;
  lines: string[];
  fontSize: number;
  originalFontSize: number;
  horizontalScale: number;
  lineHeight: number;
  totalHeight: number;
  safeWidth: number;
  safeBottomLimit: number;
  hasCollisionWarning: boolean;
  appliedAdjustment: boolean;
};

/**
 * Encontra o limite inferior seguro para a renderização de um texto no modelo,
 * inspecionando camadas subsequentes no PSD (como linhas decorativas, complementos, preços).
 */
export function computeSafeBottomLimit(
  part: ImportedPricePart,
  artwork?: ImportedArtwork
): number {
  const b = part.bounds;
  const initialLimit = b.bottom + Math.max(12, (b.bottom - b.top) * 0.45);
  if (!artwork || !artwork.layers || artwork.layers.length === 0) {
    return initialLimit;
  }

  // Procura elementos visíveis abaixo da camada atual
  const candidates: number[] = [];
  const partCenterY = (b.top + b.bottom) / 2;

  for (const layer of artwork.layers) {
    if (!layer.visible || layer.id === part.layerId) continue;
    // Ignora camadas que ficam totalmente acima ou no mesmo nível
    if (layer.bounds.top <= b.top + 5) continue;
    // Se a camada está abaixo da camada atual
    if (layer.bounds.top > partCenterY) {
      // Elementos que funcionam como barreira inferior:
      // 1. Linhas decorativas (pouca altura, largura expressiva)
      // 2. Outros textos (complemento, preço)
      // 3. Regras de fração
      const isDivider =
        (layer.type === 'vector' || layer.type === 'raster') &&
        layer.bounds.bottom - layer.bounds.top <= 25 &&
        layer.bounds.right - layer.bounds.left >= 100;

      const isTextOrPrice =
        layer.type === 'text' ||
        artwork.priceParts.some(p => p.layerId === layer.id) ||
        artwork.templateParts?.some(p => p.layerId === layer.id && p.role !== part.role);

      if (isDivider || isTextOrPrice) {
        candidates.push(layer.bounds.top);
      }
    }
  }

  if (candidates.length > 0) {
    const closestObstacleTop = Math.min(...candidates);
    // Margem de segurança de pelo menos 8px acima do obstáculo mais próximo
    return Math.max(b.bottom, closestObstacleTop - 8);
  }

  return initialLimit;
}

/**
 * Calcula a geometria segura para renderização de um título ou texto dinâmico,
 * reutilizada tanto pelo renderizador Canvas quanto pela exportação PSD direta.
 */
export function computeTextLayoutAdjustment(
  part: ImportedPricePart,
  rawText: string,
  measureTextWidth: (text: string, fontPx: number) => number,
  artwork?: ImportedArtwork
): TextLayoutAdjustment {
  const text = (rawText || '').trim();
  const b = part.bounds;
  const originalFontSize = part.fontSize || Math.max(16, (b.bottom - b.top) * 0.85);
  const safeWidth = Math.max(120, b.right - b.left);
  const safeBottomLimit = computeSafeBottomLimit(part, artwork);
  const safeAvailableHeight = Math.max(originalFontSize, safeBottomLimit - b.top);

  if (!text) {
    return {
      originalText: text,
      lines: [''],
      fontSize: originalFontSize,
      originalFontSize,
      horizontalScale: 1,
      lineHeight: originalFontSize * 1.15,
      totalHeight: originalFontSize,
      safeWidth,
      safeBottomLimit,
      hasCollisionWarning: false,
      appliedAdjustment: false,
    };
  }

  // Trata quebras explícitas de linha (\n)
  const explicitLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let lines = explicitLines.length > 0 ? explicitLines : [text];

  // Se o texto original couber perfeitamente em 1 linha e não tiver quebra explícita
  if (lines.length === 1) {
    const unscaledWidth = measureTextWidth(lines[0], originalFontSize);
    if (unscaledWidth <= safeWidth) {
      return {
        originalText: text,
        lines,
        fontSize: originalFontSize,
        originalFontSize,
        horizontalScale: 1,
        lineHeight: originalFontSize * 1.15,
        totalHeight: originalFontSize,
        safeWidth,
        safeBottomLimit,
        hasCollisionWarning: false,
        appliedAdjustment: false,
      };
    }
  }

  // Tenta compressão horizontal moderada primeiro para manter em linha única (se não tiver quebra explícita)
  if (lines.length === 1) {
    const unscaledWidth = measureTextWidth(lines[0], originalFontSize);
    const requiredHScale = safeWidth / unscaledWidth;
    if (requiredHScale >= MIN_TITLE_HORIZONTAL_SCALE) {
      return {
        originalText: text,
        lines,
        fontSize: originalFontSize,
        originalFontSize,
        horizontalScale: Math.max(MIN_TITLE_HORIZONTAL_SCALE, Math.min(1, requiredHScale)),
        lineHeight: originalFontSize * 1.15,
        totalHeight: originalFontSize,
        safeWidth,
        safeBottomLimit,
        hasCollisionWarning: false,
        appliedAdjustment: true,
      };
    }
  }

  // Se exceder a compressão horizontal moderada em 1 linha, divide inteligentemente em 2 linhas
  // a menos que já venha com quebras explícitas
  if (explicitLines.length <= 1) {
    const words = text.split(/\s+/);
    if (words.length >= 2) {
      let bestBreakIdx = Math.ceil(words.length / 2);
      // Busca ponto de equilíbrio de comprimento entre linha 1 e 2
      let minDiff = Infinity;
      for (let i = 1; i < words.length; i++) {
        const l1 = words.slice(0, i).join(' ');
        const l2 = words.slice(i).join(' ');
        const diff = Math.abs(l1.length - l2.length);
        if (diff < minDiff) {
          minDiff = diff;
          bestBreakIdx = i;
        }
      }
      lines = [words.slice(0, bestBreakIdx).join(' '), words.slice(bestBreakIdx).join(' ')];
    }
  }

  // Ajusta o tamanho da fonte para que as linhas caibam na altura disponível (sem invadir a linha decorativa)
  const numLines = lines.length;
  let targetFontSize = originalFontSize;
  const maxAllowedHeight = safeAvailableHeight;

  // Altura necessária com a fonte original
  let calculatedLineHeight = targetFontSize * 1.05;
  let calculatedTotalHeight = numLines * calculatedLineHeight;

  if (calculatedTotalHeight > maxAllowedHeight) {
    // Reduz a fonte proporcionalmente para respeitar o limite inferior
    const scaleFactor = Math.max(MIN_TITLE_FONT_SIZE_RATIO, maxAllowedHeight / calculatedTotalHeight);
    targetFontSize = Math.round(originalFontSize * scaleFactor);
    calculatedLineHeight = targetFontSize * 1.05;
    calculatedTotalHeight = numLines * calculatedLineHeight;
  }

  // Após definir a fonte verticalmente, confere a largura máxima entre as linhas
  let maxLineWidth = 0;
  for (const line of lines) {
    const w = measureTextWidth(line, targetFontSize);
    if (w > maxLineWidth) maxLineWidth = w;
  }

  let finalHScale = 1;
  if (maxLineWidth > safeWidth) {
    finalHScale = Math.max(MIN_TITLE_HORIZONTAL_SCALE, safeWidth / maxLineWidth);
  }

  // Se mesmo com compressão e redução o texto ultrapassar a barreira de segurança
  const hasCollisionWarning = b.top + calculatedTotalHeight > safeBottomLimit + 4;

  return {
    originalText: text,
    lines,
    fontSize: targetFontSize,
    originalFontSize,
    horizontalScale: finalHScale,
    lineHeight: calculatedLineHeight,
    totalHeight: calculatedTotalHeight,
    safeWidth,
    safeBottomLimit,
    hasCollisionWarning,
    appliedAdjustment: true,
  };
}
