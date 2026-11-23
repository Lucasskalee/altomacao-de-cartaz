import type { ImportedArtwork, ImportedPricePart } from '../../features/cartazes/types';
import { computeTextLayoutAdjustment, type TextLayoutAdjustment } from '../../features/psd/textAdjustment';

export const MIN_SAFE_HORIZONTAL_SCALE = 0.48;

export function resolveFontFamily(psdFont?: string, fallback = 'sans-serif'): string {
  if (!psdFont) return fallback;
  const clean = psdFont.trim();
  if (/zullia/i.test(clean)) return `'Zullia', sans-serif`;
  if (/brush\s*hand/i.test(clean) || /brushhand/i.test(clean)) {
    return `'Brush Hand New', BrushHandNew, cursive, sans-serif`;
  }
  if (/ariblk|arial[\s-_]*black/i.test(clean)) {
    return `'Arial Black', ArialMT, Arial, sans-serif`;
  }
  if (/arialbd|arial[\s-_]*bold/i.test(clean)) {
    return `'Arial', ArialMT, sans-serif`;
  }
  if (/arial/i.test(clean)) {
    return `ArialMT, Arial, sans-serif`;
  }
  return `'${clean}', ${fallback}`;
}

export function resolveFontWeight(psdFont?: string, defaultWeight = '400'): string {
  if (!psdFont) return defaultWeight;
  if (/black|ariblk/i.test(psdFont)) return '900';
  if (/bold|arialbd/i.test(psdFont)) return '700';
  if (/brush/i.test(psdFont)) return '400';
  return defaultWeight;
}

function renderTransformedGlyphs(
  context: CanvasRenderingContext2D,
  text: string,
  transform: [number, number, number, number, number, number],
  fontStr: string,
  fillColor: string,
  stroke?: { size: number; color: string },
  shadow?: { dx: number; dy: number; blur: number; color: string }
) {
  const [a, bm, c, d, tx, ty] = transform;
  const scaleY = Math.hypot(c, d);
  const localLineWidth = ((stroke?.size ?? 0) / Math.max(1, scaleY)) * 2;

  // Pass 1: Sombra projetada fiel ao Photoshop (renderizada como silhueta sólida deslocada no canvas)
  if (shadow && (shadow.dx !== 0 || shadow.dy !== 0 || shadow.blur > 0)) {
    context.save();
    context.transform(a, bm, c, d, tx + shadow.dx, ty + shadow.dy);
    context.font = fontStr;
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';

    if (shadow.blur > 0) {
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
      context.shadowBlur = shadow.blur;
      context.shadowColor = shadow.color || '#000000';
    }

    if (stroke && stroke.size > 0) {
      context.save();
      context.lineWidth = localLineWidth;
      context.strokeStyle = shadow.color || '#000000';
      context.strokeText(text, 0, 0);
      context.restore();
    }

    context.fillStyle = shadow.color || '#000000';
    context.fillText(text, 0, 0);
    context.restore();
  }

  // Pass 2: Texto frontal com miolo e contorno nítidos
  context.save();
  context.transform(a, bm, c, d, tx, ty);
  context.font = fontStr;
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';

  if (stroke && stroke.size > 0) {
    context.save();
    context.lineWidth = localLineWidth;
    context.strokeStyle = stroke.color || '#000000';
    context.strokeText(text, 0, 0);
    context.restore();
  }

  context.fillStyle = fillColor;
  context.fillText(text, 0, 0);
  context.restore();
}

const sanitizePrice = (value: string) => {
  const normalized = value.replace(/[^\d,.]/g, '').replace('.', ',');
  const [whole = '0', fraction = ''] = normalized.split(',');
  return { whole: whole || '0', fraction: (fraction + '00').slice(0, 2) };
};

const imageCache = new Map<string, Promise<HTMLImageElement>>();
export function clearArtworkImageCache(): void {
  imageCache.clear();
}
function loadImage(source: string) {
  let pending = imageCache.get(source);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Recurso visual incorporado inválido.'));
      image.src = source;
    });
    imageCache.set(source, pending);
  }
  return pending;
}

export function hasInvertedPsdPriceParts(artwork: ImportedArtwork): boolean {
  const wholePart = artwork.priceParts.find(item => item.role === 'whole');
  const fractionPart = artwork.priceParts.find(item => item.role === 'fraction');
  if (!wholePart || !fractionPart) return false;
  const wholeCenterX = (wholePart.bounds.left + wholePart.bounds.right) / 2;
  const fractionCenterX = (fractionPart.bounds.left + fractionPart.bounds.right) / 2;
  return wholeCenterX > fractionCenterX + 8;
}

export function normalizePsdPriceParts(artwork: ImportedArtwork): ImportedPricePart[] {
  if (!hasInvertedPsdPriceParts(artwork)) return artwork.priceParts;
  return artwork.priceParts.map(part => {
    if (part.role === 'whole') return { ...part, role: 'fraction' };
    if (part.role === 'fraction') return { ...part, role: 'whole' };
    return part;
  });
}

export function repairInvertedPsdArtwork(artwork: ImportedArtwork): {
  artwork: ImportedArtwork;
  correctedPriceCents: number | null;
} {
  const normalizedParts = normalizePsdPriceParts(artwork);
  const wholePart = normalizedParts.find(item => item.role === 'whole');
  const fractionPart = normalizedParts.find(item => item.role === 'fraction');
  const wholeRaw = (wholePart?.originalText ?? '').trim();
  const fractionRaw = (fractionPart?.originalText ?? '').trim();
  let correctedPriceCents: number | null = null;
  if (/^\d{1,6}$/.test(wholeRaw) && /^\d{1,2}$/.test(fractionRaw)) {
    correctedPriceCents = Number(wholeRaw) * 100 + Number(fractionRaw.padEnd(2, '0'));
  }
  return {
    artwork: {
      ...artwork,
      priceParts: normalizedParts,
    },
    correctedPriceCents,
  };
}

export type WholePriceAdjustment = {
  wholeText: string;
  originalRotDeg: number;
  originalSkewDeg: number;
  netCounterSkewDeg: number;
  rotateDeltaDeg: number;
  skewDeltaDeg: number;
  targetSkewDeg: number;
  normalized: boolean;
  normalizedTransform: [number, number, number, number, number, number] | null;
  safeLeftLimit: number;
  safeRightLimit: number;
  availableWidth: number;
  estimatedUnscaledWidth: number;
  requiredScale: number;
  horizontalScale: number;
  fitsWithinSafeLimit: boolean;
};

export function computeWholePriceAdjustment(
  artwork: ImportedArtwork,
  wholeInput: string
): WholePriceAdjustment {
  const wholeText = (wholeInput.replace(/\D/g, '') || '0').trim();
  const parts = normalizePsdPriceParts(artwork);
  const wholePart = parts.find(item => item.role === 'whole');
  const fractionPart = parts.find(item => item.role === 'fraction');
  const decimalPart = parts.find(item => item.role === 'decimal');
  const rulePart = parts.find(item => item.role === 'fractionRule');

  if (!wholePart) {
    return {
      wholeText,
      originalRotDeg: 0,
      originalSkewDeg: 0,
      netCounterSkewDeg: 0,
      rotateDeltaDeg: 0,
      skewDeltaDeg: 0,
      targetSkewDeg: 0,
      normalized: false,
      normalizedTransform: null,
      safeLeftLimit: 42,
      safeRightLimit: 560,
      availableWidth: 518,
      estimatedUnscaledWidth: 300,
      requiredScale: 1,
      horizontalScale: 1,
      fitsWithinSafeLimit: false,
    };
  }

  const b = wholePart.bounds;
  const obstacleLefts: number[] = [];
  if (decimalPart && decimalPart.bounds.left > b.left + 40) obstacleLefts.push(decimalPart.bounds.left);
  if (fractionPart && fractionPart.bounds.left > b.left + 40) obstacleLefts.push(fractionPart.bounds.left);
  if (rulePart && rulePart.bounds.left > b.left + 40) obstacleLefts.push(rulePart.bounds.left);

  const minObstacleLeft = obstacleLefts.length > 0 ? Math.min(...obstacleLefts) : null;
  const safeRightLimit =
    minObstacleLeft !== null
      ? Math.min(minObstacleLeft - 18, Math.max(b.right, minObstacleLeft - 24))
      : Math.max(b.right, 555);
  const safeLeftLimit = Math.min(42, Math.max(16, Math.round(b.left * 0.5)));
  const availableWidth = Math.max(120, safeRightLimit - safeLeftLimit);

  let originalRotDeg = 0;
  let originalSkewDeg = 0;
  let netCounterSkewDeg = 0;
  let rotateDeltaDeg = 0;
  let skewDeltaDeg = 0;
  let targetSkewDeg = 0;
  let normalized = false;
  let normalizedTransform: [number, number, number, number, number, number] | null = null;

  const fontSize = wholePart.fontSize ?? 50;
  let normXx = (b.bottom - b.top) / Math.max(1, fontSize);

  if (wholePart.transform && wholePart.transform.length === 6) {
    const [xx, xy, yx, yy, tx, ty] = wholePart.transform;
    const scaleX = Math.hypot(xx, xy);
    const rotRad = Math.atan2(xy, xx);
    originalRotDeg = (rotRad * 180) / Math.PI;
    originalSkewDeg = (Math.atan2(yx, yy) * 180) / Math.PI;
    netCounterSkewDeg = originalSkewDeg - originalRotDeg;

    const isRepeatedOnes = /^1{2,}$/.test(wholeText);
    if (isRepeatedOnes && (Math.abs(originalRotDeg) > 0.8 || netCounterSkewDeg < 13.5)) {
      rotateDeltaDeg = Math.abs(originalRotDeg) > 0.8 ? -originalRotDeg : 0;
      const skewAfterRot = originalSkewDeg - rotateDeltaDeg;
      targetSkewDeg = Math.min(17.5, Math.max(skewAfterRot, 15.6));
      skewDeltaDeg = targetSkewDeg - skewAfterRot;
      normalized = Math.abs(rotateDeltaDeg) > 0.1 || Math.abs(skewDeltaDeg) > 0.2;
    } else if (Math.abs(originalRotDeg) > 1.5) {
      rotateDeltaDeg = -originalRotDeg;
      const skewAfterRot = originalSkewDeg - rotateDeltaDeg;
      targetSkewDeg = Math.min(14.5, Math.max(7.5, skewAfterRot));
      skewDeltaDeg = targetSkewDeg - skewAfterRot;
      normalized = true;
    } else if (wholeText.length >= 2 && netCounterSkewDeg < 4.5 && originalSkewDeg > 0) {
      rotateDeltaDeg = Math.abs(originalRotDeg) > 0.8 ? -originalRotDeg : 0;
      const skewAfterRot = originalSkewDeg - rotateDeltaDeg;
      targetSkewDeg = 8.5;
      skewDeltaDeg = targetSkewDeg - skewAfterRot;
      normalized = true;
    } else {
      targetSkewDeg = originalSkewDeg;
    }

    if (normalized) {
      normXx = scaleX;
      const normXy = 0;
      const normYy = yy * Math.cos(rotRad) - yx * Math.sin(rotRad);
      const normYx = normYy * Math.tan((targetSkewDeg * Math.PI) / 180);
      normalizedTransform = [normXx, normXy, normYx, normYy, tx, ty];
    } else {
      normXx = scaleX;
      normalizedTransform = [xx, xy, yx, yy, tx, ty];
    }
  }

  const origDigits = Math.max(1, (wholePart.originalText ?? '').trim().length);
  const origBoxWidth = Math.max(120, b.right - b.left);
  let estimatedUnscaledWidth: number;
  if (wholeText.length <= origDigits && !normalized) {
    estimatedUnscaledWidth = origBoxWidth;
  } else {
    // Para artes sem transform (ex.: mock nos testes unitários), estima a largura com base na altura da caixa
    const charHeight = wholePart.transform ? fontSize * normXx : b.bottom - b.top;
    let localUnits = 0;
    for (const ch of wholeText) {
      localUnits += ch === '1' ? 0.36 : 0.52;
    }
    estimatedUnscaledWidth = localUnits * charHeight;
  }

  const requiredScale =
    estimatedUnscaledWidth > availableWidth ? availableWidth / estimatedUnscaledWidth : 1;
  const fitsWithinSafeLimit = requiredScale >= MIN_SAFE_HORIZONTAL_SCALE;
  const horizontalScale = Math.max(MIN_SAFE_HORIZONTAL_SCALE, Math.min(1, requiredScale));

  return {
    wholeText,
    originalRotDeg,
    originalSkewDeg,
    netCounterSkewDeg,
    rotateDeltaDeg,
    skewDeltaDeg,
    targetSkewDeg,
    normalized,
    normalizedTransform,
    safeLeftLimit,
    safeRightLimit,
    availableWidth,
    estimatedUnscaledWidth,
    requiredScale,
    horizontalScale,
    fitsWithinSafeLimit,
  };
}

export function importedPriceWarning(artwork: ImportedArtwork, price: string): string {
  const whole = sanitizePrice(price).whole;
  const parts = normalizePsdPriceParts(artwork);
  const part = parts.find(item => item.role === 'whole');
  if (!part) return 'Mapeamento de reais ausente.';
  const origDigits = Math.max(1, (part.originalText ?? '').trim().length);
  if (whole.length > origDigits) {
    const available = Math.max(part.bounds.right - part.bounds.left, part.bounds.right - 24);
    const perDigitWidth = (part.bounds.bottom - part.bounds.top) * (0.62 / origDigits);
    const estimated = whole.length * perDigitWidth;
    if (estimated > available / 0.64) {
      return 'O valor é largo demais para a área mapeada. Reduza os dígitos ou prepare a arte.';
    }
  }
  const adjustment = computeWholePriceAdjustment(artwork, whole);
  if (!adjustment.fitsWithinSafeLimit) {
    return 'O valor é largo demais para a área mapeada. Reduza os dígitos ou prepare a arte.';
  }
  return '';
}

export type DynamicPosterTexts = {
  category?: string;
  name?: string;
  complement?: string;
  unit?: string;
  hasBoxPrice?: boolean;
  boxQuantity?: number;
  boxUnitLabel?: string;
  boxPrice?: string;
  productImage?: { dataUrl: string; fileName?: string; bounds?: { left: number; top: number; right: number; bottom: number } };
  showSurgicalGuides?: boolean;
};

export async function drawImported(
  canvas: HTMLCanvasElement,
  artwork: ImportedArtwork,
  price: string,
  outputWidth = 886,
  outputHeight = 1260,
  validityText?: string,
  dynamicTexts?: DynamicPosterTexts
) {
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas indisponível.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, outputWidth, outputHeight);
  const scale = Math.min(outputWidth / artwork.canvas.width, outputHeight / artwork.canvas.height);
  const offsetX = (outputWidth - artwork.canvas.width * scale) / 2;
  const offsetY = (outputHeight - artwork.canvas.height * scale) / 2;
  const background = await loadImage(artwork.staticBackground);
  context.drawImage(background, offsetX, offsetY, artwork.canvas.width * scale, artwork.canvas.height * scale);
  if ('fonts' in document) {
    await Promise.all([
      document.fonts.load(`400 ${Math.max(12, 500 * scale)}px Zullia`).catch(() => []),
      document.fonts.load(`700 ${Math.max(12, 500 * scale)}px Zullia`).catch(() => []),
      document.fonts.load(`400 ${Math.max(12, 200 * scale)}px "Brush Hand New"`).catch(() => []),
      document.fonts.load(`400 ${Math.max(12, 200 * scale)}px BrushHandNew`).catch(() => []),
      document.fonts.load(`700 ${Math.max(12, 100 * scale)}px Arial`).catch(() => []),
      document.fonts.load(`700 ${Math.max(12, 100 * scale)}px ArialMT`).catch(() => []),
      document.fonts.load(`900 ${Math.max(12, 100 * scale)}px Impact`).catch(() => []),
    ]);
  }
  const { whole, fraction } = sanitizePrice(price);
  const parts = normalizePsdPriceParts(artwork);
  const wholeAdjustment = computeWholePriceAdjustment(artwork, whole);
  context.save();
  context.translate(offsetX, offsetY);
  context.scale(scale, scale);

  if (dynamicTexts?.productImage?.dataUrl) {
    try {
      const prodImg = await loadImage(dynamicTexts.productImage.dataUrl);
      drawProductImageAutoFit(context, artwork, prodImg, dynamicTexts.productImage.bounds);
    } catch {
      // Fallback silently if product image fails to load
    }
  }

  for (const part of parts) {
    drawPart(context, part, whole, fraction, wholeAdjustment, validityText, dynamicTexts, artwork);
  }
  if (artwork.templateParts && artwork.templateParts.length > 0) {
    for (const part of artwork.templateParts) {
      drawPart(context, part, whole, fraction, wholeAdjustment, validityText, dynamicTexts, artwork);
    }
  }

  const hasNativeBoxLayers = Boolean(
    artwork.layers?.some(l => l.visible && /caixa\s+com|fardo\s+com/i.test(l.text ?? l.name))
  );
  if (dynamicTexts?.hasBoxPrice && dynamicTexts?.boxPrice && !hasNativeBoxLayers) {
    drawBoxPriceSection(
      context,
      artwork,
      dynamicTexts.boxPrice,
      dynamicTexts.boxQuantity ?? 12,
      dynamicTexts.boxUnitLabel ?? 'UND.'
    );
  }
  if (dynamicTexts?.showSurgicalGuides) {
    drawSurgicalGuides(context, artwork, dynamicTexts);
  }
  context.restore();
}

function drawProductImageAutoFit(
  context: CanvasRenderingContext2D,
  artwork: ImportedArtwork,
  img: HTMLImageElement,
  customBounds?: { left: number; top: number; right: number; bottom: number }
) {
  const canvasW = artwork.canvas.width;
  const canvasH = artwork.canvas.height;
  const zone = customBounds || {
    left: Math.round(canvasW * 0.18),
    top: Math.round(canvasH * 0.28),
    right: Math.round(canvasW * 0.82),
    bottom: Math.round(canvasH * 0.58),
  };
  const zoneW = zone.right - zone.left;
  const zoneH = zone.bottom - zone.top;
  const fitScale = Math.min(zoneW / img.width, zoneH / img.height);
  const drawW = img.width * fitScale;
  const drawH = img.height * fitScale;
  const drawX = zone.left + (zoneW - drawW) / 2;
  const drawY = zone.top + (zoneH - drawH) / 2;

  context.save();
  context.drawImage(img, drawX, drawY, drawW, drawH);
  context.restore();
}

function drawSurgicalGuides(
  context: CanvasRenderingContext2D,
  artwork: ImportedArtwork,
  dynamicTexts?: DynamicPosterTexts
) {
  const canvasW = artwork.canvas.width;
  const canvasH = artwork.canvas.height;
  context.save();

  // 1. ZONA VERMELHA - LOCK_Fundo_Marca (Bloqueada / Identidade Visual)
  const lockZone = { left: 16, top: 16, right: canvasW - 16, bottom: Math.round(canvasH * 0.16) };
  context.strokeStyle = 'rgba(239, 68, 68, 0.85)';
  context.lineWidth = 4;
  context.setLineDash([]);
  context.strokeRect(lockZone.left, lockZone.top, lockZone.right - lockZone.left, lockZone.bottom - lockZone.top);

  // Tag Bloqueado
  context.fillStyle = '#ef4444';
  context.fillRect(lockZone.left, lockZone.top, 140, 32);
  context.fillStyle = '#ffffff';
  context.font = '700 16px sans-serif';
  context.fillText('🔒 BLOQUEADO', lockZone.left + 10, lockZone.top + 22);

  // 2. ZONA VERDE - EDIT_Titulo_Produto
  const titlePart = artwork.templateParts?.find(p => p.role === 'title');
  const titleZone = titlePart ? titlePart.bounds : {
    left: Math.round(canvasW * 0.08),
    top: Math.round(canvasH * 0.17),
    right: Math.round(canvasW * 0.92),
    bottom: Math.round(canvasH * 0.28),
  };
  context.strokeStyle = '#22c55e';
  context.lineWidth = 3;
  context.setLineDash([8, 6]);
  context.strokeRect(titleZone.left, titleZone.top, titleZone.right - titleZone.left, titleZone.bottom - titleZone.top);

  // Tag Editável no Título
  context.setLineDash([]);
  context.fillStyle = '#22c55e';
  context.fillRect(titleZone.right - 100, Math.max(0, titleZone.top - 28), 100, 28);
  context.fillStyle = '#ffffff';
  context.font = '700 14px sans-serif';
  context.fillText('EDITÁVEL', titleZone.right - 88, Math.max(0, titleZone.top - 9));

  // 3. ZONA VERDE - EDIT_Foto_Produto (Packshot com alças)
  const photoZone = dynamicTexts?.productImage?.bounds || {
    left: Math.round(canvasW * 0.18),
    top: Math.round(canvasH * 0.29),
    right: Math.round(canvasW * 0.82),
    bottom: Math.round(canvasH * 0.58),
  };
  context.strokeStyle = '#22c55e';
  context.lineWidth = 2.5;
  context.setLineDash([]);
  context.strokeRect(photoZone.left, photoZone.top, photoZone.right - photoZone.left, photoZone.bottom - photoZone.top);

  // Alças de ajuste nos cantos (Handles)
  const handleSize = 12;
  const drawHandle = (x: number, y: number) => {
    context.fillStyle = '#ffffff';
    context.fillRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
    context.strokeStyle = '#22c55e';
    context.lineWidth = 2;
    context.strokeRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
  };
  drawHandle(photoZone.left, photoZone.top);
  drawHandle(photoZone.right, photoZone.top);
  drawHandle(photoZone.left, photoZone.bottom);
  drawHandle(photoZone.right, photoZone.bottom);
  drawHandle((photoZone.left + photoZone.right) / 2, photoZone.top);
  drawHandle((photoZone.left + photoZone.right) / 2, photoZone.bottom);
  drawHandle(photoZone.left, (photoZone.top + photoZone.bottom) / 2);
  drawHandle(photoZone.right, (photoZone.top + photoZone.bottom) / 2);

  // 4. ZONA VERDE - EDIT_Preco
  const priceParts = artwork.priceParts || [];
  const wholePart = priceParts.find(p => p.role === 'whole');
  const fractionPart = priceParts.find(p => p.role === 'fraction');
  const priceTop = wholePart ? Math.min(wholePart.bounds.top, fractionPart?.bounds.top ?? wholePart.bounds.top) : Math.round(canvasH * 0.59);
  const priceBottom = wholePart ? Math.max(wholePart.bounds.bottom, fractionPart?.bounds.bottom ?? wholePart.bounds.bottom) : Math.round(canvasH * 0.88);
  const priceLeft = wholePart ? Math.min(wholePart.bounds.left, fractionPart?.bounds.left ?? wholePart.bounds.left) - 30 : Math.round(canvasW * 0.08);
  const priceRight = fractionPart ? Math.max(fractionPart.bounds.right, wholePart?.bounds.right ?? fractionPart.bounds.right) + 30 : Math.round(canvasW * 0.92);

  context.strokeStyle = '#22c55e';
  context.lineWidth = 3;
  context.setLineDash([8, 6]);

  const hasNativeBox = Boolean(
    artwork?.layers?.some(l => l.visible && /caixa\s+com|fardo\s+com/i.test(l.text ?? l.name))
  );
  if (dynamicTexts?.hasBoxPrice && !hasNativeBox) {
    const s = 0.64;
    const targetY = canvasH * 0.63;
    const h = (priceBottom - priceTop) * s;
    const w = (priceRight - priceLeft) * s;
    const midX = (priceLeft + priceRight) / 2;
    const adaptedTop = targetY - h / 2;
    const adaptedLeft = canvasW / 2 + (midX - canvasW / 2) * s - w / 2;
    context.strokeRect(adaptedLeft, adaptedTop, w, h);
  } else {
    context.strokeRect(priceLeft, priceTop, priceRight - priceLeft, priceBottom - priceTop);
  }

  // 5. ZONA VERDE - EDIT_Caixa_Atacado (se ativo)
  if (dynamicTexts?.hasBoxPrice) {
    const boxY = Math.round(canvasH * 0.81);
    const boxZone = { left: Math.round(canvasW * 0.06), top: boxY, right: Math.round(canvasW * 0.94), bottom: canvasH - 20 };
    context.strokeStyle = '#22c55e';
    context.lineWidth = 3;
    context.setLineDash([8, 6]);
    context.strokeRect(boxZone.left, boxZone.top, boxZone.right - boxZone.left, boxZone.bottom - boxZone.top);
  }

  context.restore();
}

function drawBoxPriceSection(
  context: CanvasRenderingContext2D,
  artwork: ImportedArtwork,
  boxPrice: string,
  boxQty = 12,
  boxUnit = 'UND.'
) {
  const { whole, fraction } = sanitizePrice(boxPrice);
  const canvasW = artwork.canvas.width;
  const canvasH = artwork.canvas.height;

  // Linha divisória oficial da caixa (Rectangle 2 cópia a 82.1% da altura do cartaz)
  const lineY = Math.round(canvasH * 0.821);
  const lineLeft = Math.round(canvasW * 0.065);
  const lineRight = Math.round(canvasW * 0.903);
  const barThickness = Math.max(8, Math.round(canvasH * 0.010));

  context.save();
  context.fillStyle = '#000000';
  context.fillRect(lineLeft, lineY, lineRight - lineLeft, barThickness);

  // Rótulo "CAIXA COM" (ArialMT)
  const labelFontSize = Math.round(canvasH * 0.046);
  const labelX = lineLeft + Math.round(canvasW * 0.038);
  context.save();
  context.font = `700 ${labelFontSize}px ArialMT, Arial, sans-serif`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#000000';
  context.fillText('CAIXA COM', labelX, lineY + Math.round(canvasH * 0.058));
  context.restore();

  // Quantidade "12 UND." (Impact)
  const qtyFontSize = Math.round(canvasH * 0.063);
  context.save();
  context.font = `900 ${qtyFontSize}px Impact, "Arial Black", sans-serif`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#000000';
  context.fillText(`${boxQty} ${boxUnit.toUpperCase()}`, labelX, lineY + Math.round(canvasH * 0.125));
  context.restore();

  // Preço Inteiro da Caixa com sombra projetada e cor oficial do modelo (ex: 46 ou 83)
  const wholeFontSize = Math.round(canvasH * 0.145);
  const priceStartX = Math.round(canvasW * 0.44);
  const wholeBaselineY = lineY + Math.round(canvasH * 0.155);

  context.save();
  context.font = `700 ${wholeFontSize}px Zullia, sans-serif`;
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.shadowColor = 'rgba(0, 0, 0, 0.45)';
  context.shadowOffsetX = 3;
  context.shadowOffsetY = 6;
  context.shadowBlur = 3;
  context.fillStyle = '#d72502';
  context.fillText(whole, priceStartX, wholeBaselineY);
  context.restore();

  // Centavos da Caixa (ex: 68 ou 40)
  context.save();
  context.font = `700 ${wholeFontSize}px Zullia, sans-serif`;
  const wholeMetrics = context.measureText(whole);
  const fracX = priceStartX + wholeMetrics.width + Math.round(canvasW * 0.015);
  const fracFontSize = Math.round(canvasH * 0.075);
  const fracBaselineY = lineY + Math.round(canvasH * 0.0872);

  context.font = `700 ${fracFontSize}px Zullia, sans-serif`;
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.shadowColor = 'rgba(0, 0, 0, 0.45)';
  context.shadowOffsetX = 3;
  context.shadowOffsetY = 6;
  context.shadowBlur = 3;
  context.fillStyle = '#d72502';
  context.fillText(fraction, fracX, fracBaselineY);

  // Traço sublinhado dos centavos (Rectangle 3 cópia 2) - calibrado exatamente abaixo dos centavos
  const fracMetrics = context.measureText(fraction);
  const ruleW = Math.max(70, fracMetrics.width + 12);
  const ruleX = fracX - 4;
  const ruleTopY = lineY + Math.round(canvasH * 0.0960);
  const ruleHeight = Math.max(8, Math.round(canvasH * 0.009));

  context.shadowColor = 'transparent';
  context.fillStyle = '#000000';
  context.fillRect(ruleX, ruleTopY, ruleW, ruleHeight);

  // Vírgula (,  cópia 3) - abaixo do traço sublinhado
  const commaFontSize = Math.round(canvasH * 0.055);
  const commaBaselineY = lineY + Math.round(canvasH * 0.1307);
  const commaX = ruleX + 8;

  context.font = `700 ${commaFontSize}px Zullia, sans-serif`;
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.shadowColor = 'rgba(0, 0, 0, 0.45)';
  context.shadowOffsetX = 2;
  context.shadowOffsetY = 4;
  context.shadowBlur = 2;
  context.fillStyle = '#d72502';
  context.fillText(',', commaX, commaBaselineY);

  context.restore();
  context.restore();
}

function drawPart(
  context: CanvasRenderingContext2D,
  part: ImportedPricePart,
  whole: string,
  fraction: string,
  wholeAdjustment: WholePriceAdjustment,
  validityText?: string,
  dynamicTexts?: DynamicPosterTexts,
  artwork?: ImportedArtwork
) {
  const b = part.bounds;
  const height = Math.max(1, b.bottom - b.top);
  const font = part.fontFamily || (part.role === 'validity' ? 'ArialMT, Arial, sans-serif' : 'Zullia');
  context.save();

  // Adaptação cirúrgica de escala e posição quando formato de Caixa está ativo em template que não possui camadas nativas de caixa
  const hasNativeBox = Boolean(
    artwork?.layers?.some(l => l.visible && /caixa\s+com|fardo\s+com/i.test(l.text ?? l.name))
  );
  const isCaixaAdapted = Boolean(dynamicTexts?.hasBoxPrice && !hasNativeBox);
  const isPricePart = part.role === 'whole' || part.role === 'fraction' || part.role === 'decimal' || part.role === 'fractionRule' || part.role === 'packaging';
  const isTopPart = part.role === 'title' || part.role === 'complement' || part.role === 'category' || part.role === 'validity';

  if (isCaixaAdapted && isPricePart) {
    const canvasW = artwork?.canvas.width ?? 886;
    const canvasH = artwork?.canvas.height ?? 1260;
    const centerX = canvasW / 2;
    const wholePart = artwork?.priceParts?.find(p => p.role === 'whole');
    const fracPart = artwork?.priceParts?.find(p => p.role === 'fraction');
    const origTop = wholePart ? Math.min(wholePart.bounds.top, fracPart?.bounds.top ?? wholePart.bounds.top) : canvasH * 0.50;
    const origBottom = wholePart ? Math.max(wholePart.bounds.bottom, fracPart?.bounds.bottom ?? wholePart.bounds.bottom) : canvasH * 0.80;
    const origCenterY = (origTop + origBottom) / 2;
    const targetCenterY = canvasH * 0.63;
    const scale = 0.64;

    context.translate(centerX, targetCenterY);
    context.scale(scale, scale);
    context.translate(-centerX, -origCenterY);
  }

  context.fillStyle = part.color;
  if (part.role === 'category') {
    const text = (dynamicTexts?.category || part.originalText || '').trim();
    if (!text) { context.restore(); return; }
    context.fillStyle = part.color || '#000000';
    drawTextLayer(context, part, text, '"Arial Black", ArialMT, Arial, Helvetica, sans-serif', Boolean(part.stroke && part.stroke.size > 0), artwork);
    context.restore();
    return;
  }
  if (part.role === 'title') {
    const text = (dynamicTexts?.name || part.originalText || '').trim();
    if (!text) { context.restore(); return; }
    context.fillStyle = part.color || '#000000';
    drawTextLayer(context, part, text, '"Brush Hand New", BrushHandNew, cursive, sans-serif', Boolean(part.stroke && part.stroke.size > 0), artwork);
    context.restore();
    return;
  }
  if (part.role === 'complement') {
    const text = (dynamicTexts?.complement || part.originalText || '').trim();
    if (!text) { context.restore(); return; }
    context.fillStyle = part.color || '#000000';
    drawTextLayer(context, part, text, '"Arial Black", ArialMT, Arial, Helvetica, sans-serif', Boolean(part.stroke && part.stroke.size > 0), artwork);
    context.restore();
    return;
  }
  if (part.role === 'packaging') {
    const text = (dynamicTexts?.unit || part.originalText || '').trim();
    if (!text) { context.restore(); return; }
    context.fillStyle = part.color || '#000000';
    drawTextLayer(context, part, text, '"Brush Hand New", BrushHandNew, cursive, sans-serif', Boolean(part.stroke && part.stroke.size > 0), artwork);
    context.restore();
    return;
  }
  if (part.role === 'fractionRule') {
    const shadow = part.shadow || { dx: 6, dy: 10, blur: 0, color: '#000000' };
    if (shadow && (shadow.dx !== 0 || shadow.dy !== 0)) {
      context.save();
      context.fillStyle = shadow.color || '#000000';
      context.fillRect(b.left + shadow.dx, b.top + shadow.dy, b.right - b.left, b.bottom - b.top);
      context.restore();
    }
    context.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
    context.restore();
    return;
  }
  if (part.role === 'validity') {
    const val = (validityText ?? part.originalText ?? '').trim();
    if (!val) {
      context.restore();
      return;
    }
    const valFont = part.fontFamily ? `${quoteFont(part.fontFamily)}, ArialMT, Arial, sans-serif` : 'ArialMT, Arial, sans-serif';
    const strokeSize = part.stroke?.size ?? 2;
    if (part.transform && part.fontSize) {
      const [a, bm, c, d, e, f] = part.transform;
      const scaleY = Math.hypot(c, d);
      const localStrokeWidth = Math.max(1, (strokeSize / Math.max(1, scaleY)) * 2);
      const targetCenterX = (b.left + b.right) / 2;
      const localTargetX = Math.abs(a) > 0.001 ? (targetCenterX - e) / a : 0;
      context.transform(a, bm, c, d, e, f);
      context.font = `bold ${part.fontSize}px ${valFont}`;
      context.textAlign = 'center';
      context.textBaseline = 'alphabetic';
      if (strokeSize > 0) {
        context.save();
        context.lineWidth = localStrokeWidth;
        context.strokeStyle = part.stroke?.color ?? '#000000';
        context.strokeText(val, localTargetX, 0);
        context.restore();
      }
      context.fillText(val, localTargetX, 0);
      context.restore();
      return;
    }
    const vFontSize = height * 0.96;
    context.font = `bold ${vFontSize}px ${valFont}`;
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';
    if (strokeSize > 0) {
      context.save();
      context.lineWidth = strokeSize * 2;
      context.strokeStyle = part.stroke?.color ?? '#000000';
      context.strokeText(val, (b.left + b.right) / 2, b.bottom);
      context.restore();
    }
    context.fillText(val, (b.left + b.right) / 2, b.bottom);
    context.restore();
    return;
  }

  const value = part.role === 'whole' ? whole : part.role === 'fraction' ? fraction : ',';
  const resolvedFont = resolveFontFamily(part.fontFamily, 'Zullia, sans-serif');
  const fontStr = `400 ${part.fontSize || height * 1.14}px ${resolvedFont}`;

  const isPriceNumber = part.role === 'whole' || part.role === 'fraction' || part.role === 'decimal' || part.role === 'fractionRule';
  const effectiveShadow = part.shadow || (isPriceNumber ? { dx: 6, dy: 10, blur: 0, color: '#000000' } : undefined);

  if (part.transform && part.fontSize) {
    if (part.role === 'whole') {
      const [a, bm, c, d, e, f] = part.transform;
      context.font = fontStr;

      const isUnchanged = value === (part.originalText ?? '').trim();
      if (isUnchanged) {
        renderTransformedGlyphs(context, value, part.transform, fontStr, part.color, part.stroke, effectiveShadow);
        context.restore();
        return;
      }

      // Medição precisa no espaço do transform
      const measuredLocal = Math.max(1, context.measureText(value).width);
      const origLocal = Math.max(1, context.measureText(part.originalText || '0').width);
      const scaleX = Math.hypot(a, bm);
      const unscaledPxWidth = measuredLocal * scaleX;

      // Mantém a escala natural 1.0; só comprime se exceder o limite seguro da página
      const available = wholeAdjustment.availableWidth;
      const hScale = unscaledPxWidth > available
        ? Math.max(MIN_SAFE_HORIZONTAL_SCALE, available / unscaledPxWidth)
        : 1.0;

      // Alinhamento à direita preservando a proximidade da vírgula
      const deltaU = (origLocal - measuredLocal * hScale) / 2;
      const targetTx = e + deltaU * a;
      const targetTy = f + deltaU * bm;

      const finalTransform: [number, number, number, number, number, number] = [
        a * hScale,
        bm * hScale,
        c,
        d,
        targetTx,
        targetTy,
      ];

      renderTransformedGlyphs(context, value, finalTransform, fontStr, part.color, part.stroke, effectiveShadow);
      context.restore();
      return;
    }

    // Centavos e vírgula usam o transform original do PSD com renderização precisa de sombra e stroke
    renderTransformedGlyphs(context, value, part.transform, fontStr, part.color, part.stroke, effectiveShadow);
    context.restore();
    return;
  }

  const fontSize = height * (part.role === 'decimal' ? 1.18 : 1.14);
  context.font = `400 ${fontSize}px ${quoteFont(font)}, Zullia, sans-serif`;
  context.textBaseline = 'alphabetic';
  if (part.role === 'whole') {
    const available = wholeAdjustment.availableWidth;
    const measured = Math.max(1, context.measureText(value).width);
    const hScale = measured > available ? Math.max(MIN_SAFE_HORIZONTAL_SCALE, available / measured) : 1;
    const targetRight = Math.min(wholeAdjustment.safeRightLimit, b.right);

    if (effectiveShadow && (effectiveShadow.dx !== 0 || effectiveShadow.dy !== 0)) {
      context.save();
      context.textAlign = 'right';
      context.translate(targetRight + effectiveShadow.dx, b.bottom + effectiveShadow.dy);
      context.scale(hScale, 1);
      context.fillStyle = effectiveShadow.color || '#000000';
      context.fillText(value, 0, 0);
      context.restore();
    }

    context.save();
    context.textAlign = 'right';
    context.translate(targetRight, b.bottom);
    context.scale(hScale, 1);
    context.fillStyle = part.color;
    context.fillText(value, 0, 0);
    context.restore();
  } else {
    if (effectiveShadow && (effectiveShadow.dx !== 0 || effectiveShadow.dy !== 0)) {
      context.save();
      context.textAlign = 'left';
      context.fillStyle = effectiveShadow.color || '#000000';
      context.fillText(value, b.left + effectiveShadow.dx, b.bottom + effectiveShadow.dy);
      context.restore();
    }
    context.save();
    context.textAlign = 'left';
    context.fillStyle = part.color;
    context.fillText(value, b.left, b.bottom);
    context.restore();
  }
  context.restore();
}

function drawTextLayer(
  context: CanvasRenderingContext2D,
  part: ImportedPricePart,
  text: string,
  fallbackFont: string,
  strokeOutline: boolean,
  artwork?: ImportedArtwork
) {
  const b = part.bounds;
  const height = Math.max(1, b.bottom - b.top);
  const resolvedFamily = resolveFontFamily(part.fontFamily, fallbackFont);
  const fontWeight = resolveFontWeight(part.fontFamily, /brush/i.test(resolvedFamily) ? '400' : '900');
  const fontName = resolvedFamily;

  // Medidor de largura contextualizado
  const measureTextWidth = (txt: string, fontPx: number): number => {
    context.save();
    context.font = `${fontWeight} ${fontPx}px ${fontName}`;
    const m = context.measureText(txt);
    context.restore();
    return Math.max(1, m.width);
  };

  const adj = computeTextLayoutAdjustment(part, text, measureTextWidth, artwork);
  const lines = adj.lines;
  const finalFontSize = adj.fontSize;
  const hScale = adj.horizontalScale;
  const lineHeight = adj.lineHeight;

  const hasStroke = strokeOutline && Boolean(part.stroke && part.stroke.size > 0);
  const strokeSize = part.stroke?.size ?? 0;

  if (part.transform && part.fontSize) {
    const [a, bm, c, d, e, f] = part.transform;
    const scaleY = Math.hypot(c, d);
    const localStrokeWidth = Math.max(1, (strokeSize / Math.max(1, scaleY)) * 2);
    const targetCenterX = (b.left + b.right) / 2;
    const localTargetX = Math.abs(a) > 0.001 ? (targetCenterX - e) / a : 0;

    context.save();
    context.transform(a, bm, c, d, e, f);
    context.scale(hScale, 1);
    context.font = `${fontWeight} ${finalFontSize}px ${fontName}`;
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';

    const numLines = lines.length;
    // Quando multilinha, centraliza o bloco verticalmente em torno da baseline original
    const startY = numLines > 1 ? -((numLines - 1) * lineHeight) / 2 : 0;

    lines.forEach((lineText, idx) => {
      const lineY = startY + idx * lineHeight;
      if (hasStroke) {
        context.save();
        context.lineWidth = localStrokeWidth;
        context.strokeStyle = part.stroke?.color ?? '#000000';
        context.strokeText(lineText, localTargetX, lineY);
        context.restore();
      }
      context.fillText(lineText, localTargetX, lineY);
    });

    context.restore();
    return;
  }

  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  const numLines = lines.length;
  const startY = cy - ((numLines - 1) * lineHeight) / 2;

  context.save();
  context.translate(cx, startY);
  context.scale(hScale, 1);
  context.font = `${fontWeight} ${finalFontSize}px ${fontName}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  lines.forEach((lineText, idx) => {
    const lineY = idx * lineHeight;
    if (hasStroke) {
      context.save();
      context.lineWidth = Math.max(1, strokeSize * 2);
      context.strokeStyle = part.stroke?.color ?? '#000000';
      context.strokeText(lineText, 0, lineY);
      context.restore();
    }
    context.fillText(lineText, 0, lineY);
  });

  context.restore();
}

function quoteFont(value: string) {
  return `"${value.replace(/["\\]/g, '')}"`;
}

export async function importedPng(artwork: ImportedArtwork, price: string): Promise<string> {
  const canvas = document.createElement('canvas');
  await drawImported(canvas, artwork, price, 1748, 2480);
  return canvas.toDataURL('image/png');
}
