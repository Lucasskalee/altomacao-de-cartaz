import type { ImportedArtwork, ImportedPricePart } from '../../features/cartazes/types';

export const MIN_SAFE_HORIZONTAL_SCALE = 0.48;

const sanitizePrice = (value: string) => {
  const normalized = value.replace(/[^\d,.]/g, '').replace('.', ',');
  const [whole = '0', fraction = ''] = normalized.split(',');
  return { whole: whole || '0', fraction: (fraction + '00').slice(0, 2) };
};

const imageCache = new Map<string, Promise<HTMLImageElement>>();
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
      document.fonts.load(`${Math.max(12, 500 * scale)}px Zullia`).catch(() => []),
      document.fonts.load(`${Math.max(12, 200 * scale)}px "Brush Hand New"`).catch(() => []),
    ]);
  }
  const { whole, fraction } = sanitizePrice(price);
  const parts = normalizePsdPriceParts(artwork);
  const wholeAdjustment = computeWholePriceAdjustment(artwork, whole);
  context.save();
  context.translate(offsetX, offsetY);
  context.scale(scale, scale);
  for (const part of parts) {
    drawPart(context, part, whole, fraction, wholeAdjustment, validityText, dynamicTexts);
  }
  if (artwork.templateParts) {
    for (const part of artwork.templateParts) {
      drawPart(context, part, whole, fraction, wholeAdjustment, validityText, dynamicTexts);
    }
  }
  context.restore();
}

function drawPart(
  context: CanvasRenderingContext2D,
  part: ImportedPricePart,
  whole: string,
  fraction: string,
  wholeAdjustment: WholePriceAdjustment,
  validityText?: string,
  dynamicTexts?: DynamicPosterTexts
) {
  const b = part.bounds;
  const height = Math.max(1, b.bottom - b.top);
  const font = part.fontFamily || (part.role === 'validity' ? 'Impact' : 'Zullia');
  context.save();
  context.fillStyle = part.color;
  if (part.shadow) {
    context.shadowOffsetX = part.shadow.dx;
    context.shadowOffsetY = part.shadow.dy;
    context.shadowBlur = part.shadow.blur;
    context.shadowColor = part.shadow.color;
  }
  if (part.role === 'category') {
    const text = (dynamicTexts?.category ?? part.originalText ?? '').trim();
    if (!text) { context.restore(); return; }
    drawTextLayer(context, part, text, 'ArialMT, Arial, Helvetica, sans-serif', true);
    context.restore();
    return;
  }
  if (part.role === 'title') {
    const text = (dynamicTexts?.name ?? part.originalText ?? '').trim();
    if (!text) { context.restore(); return; }
    drawTextLayer(context, part, text, '"Brush Hand New", BrushHandNew, cursive, sans-serif', false);
    context.restore();
    return;
  }
  if (part.role === 'complement') {
    const text = (dynamicTexts?.complement ?? part.originalText ?? '').trim();
    if (!text) { context.restore(); return; }
    drawTextLayer(context, part, text, 'ArialMT, Arial, Helvetica, sans-serif', true);
    context.restore();
    return;
  }
  if (part.role === 'packaging') {
    const text = (dynamicTexts?.unit ?? part.originalText ?? '').trim();
    if (!text) { context.restore(); return; }
    drawTextLayer(context, part, text, '"Brush Hand New", BrushHandNew, cursive, sans-serif', false);
    context.restore();
    return;
  }
  if (part.role === 'fractionRule') {
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
    if (part.transform && part.fontSize) {
      const [a, bm, c, d, e, f] = part.transform;
      context.transform(a, bm, c, d, e, f);
      context.font = `400 ${part.fontSize}px ${quoteFont(font)}, Impact, Arial, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'alphabetic';
      context.fillText(val, 0, 0);
      context.restore();
      return;
    }
    const vFontSize = height * 0.96;
    context.font = `400 ${vFontSize}px ${quoteFont(font)}, Impact, Arial, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';
    context.fillText(val, (b.left + b.right) / 2, b.bottom);
    context.restore();
    return;
  }

  const value = part.role === 'whole' ? whole : part.role === 'fraction' ? fraction : ',';
  if (part.transform && part.fontSize) {
    if (part.role === 'whole') {
      const matrix = wholeAdjustment.normalizedTransform ?? part.transform;
      const [a, bm, c, d, e, f] = matrix;
      context.font = `400 ${part.fontSize}px ${quoteFont(font)}, Zullia, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'alphabetic';

      const isUnchangedSingle =
        value === (part.originalText ?? '').trim() &&
        !wholeAdjustment.normalized &&
        wholeAdjustment.horizontalScale >= 0.999;

      if (isUnchangedSingle) {
        context.transform(a, bm, c, d, e, f);
        context.fillText(value, 0, 0);
        context.restore();
        return;
      }

      const normXx = Math.hypot(a, bm);
      const measuredLocal = Math.max(1, context.measureText(value).width);
      const unscaledPxWidth = Math.max(
        measuredLocal * normXx,
        wholeAdjustment.estimatedUnscaledWidth
      );
      const hScale = Math.max(
        MIN_SAFE_HORIZONTAL_SCALE,
        Math.min(1, wholeAdjustment.availableWidth / unscaledPxWidth, wholeAdjustment.horizontalScale)
      );
      const renderedWidthPx = unscaledPxWidth * hScale;
      const targetRight = Math.min(
        wholeAdjustment.safeRightLimit,
        Math.max(b.right, b.left + renderedWidthPx)
      );
      const targetVisualCenterX = Math.max(
        wholeAdjustment.safeLeftLimit + renderedWidthPx / 2,
        targetRight - renderedWidthPx / 2
      );
      const txFinal = targetVisualCenterX + 0.38 * part.fontSize * c;

      context.transform(a, bm, c, d, txFinal, f);
      context.scale(hScale, 1);
      context.fillText(value, 0, 0);
      context.restore();
      return;
    }

    const [a, bm, c, d, e, f] = part.transform;
    context.transform(a, bm, c, d, e, f);
    context.font = `400 ${part.fontSize}px ${quoteFont(font)}, Zullia, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';
    context.fillText(value, 0, 0);
    context.restore();
    return;
  }

  const fontSize = height * (part.role === 'decimal' ? 1.18 : 1.14);
  context.font = `400 ${fontSize}px ${quoteFont(font)}, Zullia, sans-serif`;
  context.textBaseline = 'alphabetic';
  if (part.role === 'whole') {
    context.textAlign = 'right';
    const available = wholeAdjustment.availableWidth;
    const measured = Math.max(1, context.measureText(value).width);
    const hScale = measured > available ? Math.max(MIN_SAFE_HORIZONTAL_SCALE, available / measured) : 1;
    const targetRight = Math.min(wholeAdjustment.safeRightLimit, b.right);
    context.translate(targetRight, b.bottom);
    context.scale(hScale, 1);
    context.fillText(value, 0, 0);
  } else {
    context.textAlign = 'left';
    context.fillText(value, b.left, b.bottom);
  }
  context.restore();
}

function drawTextLayer(
  context: CanvasRenderingContext2D,
  part: ImportedPricePart,
  text: string,
  fallbackFont: string,
  strokeOutline: boolean
) {
  const b = part.bounds;
  const height = Math.max(1, b.bottom - b.top);
  const fontName = part.fontFamily ? `${quoteFont(part.fontFamily)}, ${fallbackFont}` : fallbackFont;

  if (part.transform && part.fontSize) {
    const [a, bm, c, d, e, f] = part.transform;
    context.transform(a, bm, c, d, e, f);
    context.font = `400 ${part.fontSize}px ${fontName}`;
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';
    if (strokeOutline) {
      context.save();
      context.lineWidth = (part.stroke?.size ?? 4) * 2;
      context.strokeStyle = part.stroke?.color ?? '#000000';
      context.strokeText(text, 0, 0);
      context.restore();
    }
    context.fillText(text, 0, 0);
    return;
  }

  const fontSize = height * 0.85;
  context.font = `bold ${fontSize}px ${fontName}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const cx = (b.left + b.right) / 2;
  const cy = (b.top + b.bottom) / 2;
  if (strokeOutline) {
    context.save();
    context.lineWidth = 4;
    context.strokeStyle = '#000000';
    context.strokeText(text, cx, cy);
    context.restore();
  }
  context.fillText(text, cx, cy);
}

function quoteFont(value: string) {
  return `"${value.replace(/["\\]/g, '')}"`;
}

export async function importedPng(artwork: ImportedArtwork, price: string): Promise<string> {
  const canvas = document.createElement('canvas');
  await drawImported(canvas, artwork, price, 1748, 2480);
  return canvas.toDataURL('image/png');
}
