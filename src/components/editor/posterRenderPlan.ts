import type {
  ImportedArtwork,
  ImportedLayerInfo,
  ImportedPricePart,
} from '../../features/cartazes/types';
import {
  clampPartAdjustment,
  computeWholePriceAdjustment,
  normalizePsdPriceParts,
  type DynamicPosterTexts,
  type WholePriceAdjustment,
} from './importedRenderer';

/**
 * Lightweight structural projection of ImportedArtwork passed into the Web Worker.
 * Excludes multi-megabyte base64 fields (`staticBackground`, `originalPreview`) so
 * structured-clone / postMessage stays sub-millisecond even on complex PSDs.
 */
export type SerializableArtworkInput = {
  source: ImportedArtwork['source'];
  canvas: ImportedArtwork['canvas'];
  layers: ImportedLayerInfo[];
  priceParts: ImportedPricePart[];
  templateParts?: ImportedPricePart[];
  posterModel?: ImportedArtwork['posterModel'];
};

export type SerializableDynamicTexts = Omit<DynamicPosterTexts, 'productImage'> & {
  hasProductImage?: boolean;
  productImageBounds?: { left: number; top: number; right: number; bottom: number };
};

export type PosterRenderWorkerInput = {
  artwork: SerializableArtworkInput;
  price: string;
  outputWidth: number;
  outputHeight: number;
  validityText?: string;
  dynamicTexts?: SerializableDynamicTexts;
};

export type PreparedPosterRenderPlan = {
  /** Serialized JSON snapshot of the prepared artwork render state (computed off-thread). */
  serializedPayload: string;
  outputWidth: number;
  outputHeight: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  whole: string;
  fraction: string;
  normalizedPriceParts: ImportedPricePart[];
  templateParts: ImportedPricePart[];
  wholeAdjustment: WholePriceAdjustment;
  hasNativeBoxLayers: boolean;
};

const sanitizePriceForPlan = (value: string) => {
  const normalized = value.replace(/[^\d,.]/g, '').replace('.', ',');
  const [whole = '0', fraction = ''] = normalized.split(',');
  return { whole: whole || '0', fraction: (fraction + '00').slice(0, 2) };
};

/**
 * Extracts only the lightweight structural metadata from an ImportedArtwork
 * before sending it to the Web Worker (avoiding cloning base64 backgrounds).
 */
export function extractSerializableArtwork(artwork: ImportedArtwork): SerializableArtworkInput {
  return {
    source: artwork.source,
    canvas: artwork.canvas,
    layers: artwork.layers,
    priceParts: artwork.priceParts,
    templateParts: artwork.templateParts,
    posterModel: artwork.posterModel,
  };
}

function clampPartList(parts?: ImportedPricePart[]): ImportedPricePart[] {
  if (!parts || parts.length === 0) return [];
  return parts.map(part => {
    if (!part.adjustments) return part;
    return {
      ...part,
      adjustments: clampPartAdjustment(part.adjustments),
    };
  });
}

/**
 * Pure, DOM-free artwork serialization and render preparation routine.
 * Runs inside the Web Worker during interactive editor updates (and directly
 * as a fallback when Workers are unavailable, e.g. Node unit tests or SSR).
 */
export function preparePosterRenderPlan(input: PosterRenderWorkerInput): PreparedPosterRenderPlan {
  const { artwork, price, outputWidth, outputHeight, validityText, dynamicTexts } = input;
  const lightweightArtwork = {
    ...artwork,
    staticBackground: '',
    originalPreview: '',
  } as ImportedArtwork;

  const scale = Math.min(outputWidth / artwork.canvas.width, outputHeight / artwork.canvas.height);
  const offsetX = (outputWidth - artwork.canvas.width * scale) / 2;
  const offsetY = (outputHeight - artwork.canvas.height * scale) / 2;

  const { whole, fraction } = sanitizePriceForPlan(price);
  const normalizedPriceParts = clampPartList(normalizePsdPriceParts(lightweightArtwork));
  const templateParts = clampPartList(artwork.templateParts);
  const wholeAdjustment = computeWholePriceAdjustment(lightweightArtwork, whole);

  const hasNativeBoxLayers = Boolean(
    artwork.layers?.some(l => l.visible && /caixa\s+com|fardo\s+com/i.test(l.text ?? l.name))
  );

  // Off-thread serialization of the complete render descriptor (eliminates main-thread JSON/layout stalls)
  const serializedPayload = JSON.stringify({
    sourceHash: artwork.source.sha256,
    canvas: artwork.canvas,
    outputWidth,
    outputHeight,
    whole,
    fraction,
    validityText: validityText ?? '',
    dynamicTexts: dynamicTexts ?? null,
    normalizedPriceParts,
    templateParts,
    wholeAdjustment,
    hasNativeBoxLayers,
  });

  return {
    serializedPayload,
    outputWidth,
    outputHeight,
    scale,
    offsetX,
    offsetY,
    whole,
    fraction,
    normalizedPriceParts,
    templateParts,
    wholeAdjustment,
    hasNativeBoxLayers,
  };
}
