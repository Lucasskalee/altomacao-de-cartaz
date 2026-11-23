import { readPsd, writePsd, initializeCanvas, type Layer, type Psd } from 'ag-psd';
import type { ScantechExportJob, ScantechExportJobResult, ScantechExportBatchResult } from './types';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { readPsdByPath } from '../psd/service';
import { OFFICIAL_BOX_LAYERS, BOX_TEMPLATE_CANVAS } from './boxModelTemplate';

let canvasReady = false;
export function ensureCanvasInitialized(): void {
  if (canvasReady) return;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    canvasReady = true;
    return;
  }
  const makeImageData = (w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4),
    width: w,
    height: h,
  });
  initializeCanvas(
    ((w: number, h: number) => ({
      width: w,
      height: h,
      getContext: () => ({
        getImageData: (_x: number, _y: number, cw: number, ch: number) => makeImageData(cw, ch),
        createImageData: (cw: number, ch: number) => makeImageData(cw, ch),
        putImageData: () => {},
      }),
    })) as any,
    makeImageData as any
  );
  canvasReady = true;
}

export function resolveLayerByPath(
  container: { children?: Layer[] },
  pathStr: string | null | undefined
): Layer | null {
  if (!pathStr || !container?.children) return null;
  const parts = pathStr.split('.');
  let current: any = container;
  let isNumericPath = true;
  for (const part of parts) {
    const idx = parseInt(part, 10);
    if (isNaN(idx) || !current?.children || idx < 0 || idx >= current.children.length) {
      isNumericPath = false;
      break;
    }
    current = current.children[idx];
  }
  if (isNumericPath && current && current !== container) {
    return current;
  }

  // Fallback: busca recursiva por nome de camada
  for (const child of container.children) {
    if (child.name === pathStr) return child;
    if (child.children) {
      const found = resolveLayerByPath(child, pathStr);
      if (found) return found;
    }
  }
  return null;
}

function createLayerCanvas(w: number, h: number): any {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  const makeImageData = (cw: number, ch: number) => ({
    data: new Uint8ClampedArray(cw * ch * 4),
    width: cw,
    height: ch,
  });
  return {
    width: w,
    height: h,
    getContext: () => ({
      getImageData: (_x: number, _y: number, cw: number, ch: number) => makeImageData(cw, ch),
      createImageData: (cw: number, ch: number) => makeImageData(cw, ch),
      putImageData: () => {},
      clearRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      save: () => {},
      restore: () => {},
      setTransform: () => {},
      measureText: (txt: string) => ({ width: txt.length * 10 }),
    }),
  };
}

/**
 * Calcula a matriz afim de transformação de Reais ajustada com precisão cirúrgica,
 * garantindo alinhamento à direita junto à vírgula e escala horizontal para evitar
 * colisões com centavos ou limites da página no Photoshop CS6.
 */
export function computeAdjustedWholeTransform(
  wholeLayer: Layer,
  newWhole: string,
  fractionLayer?: Layer | null,
  canvasWidth = 1179
): {
  transform: [number, number, number, number, number, number];
  horizontalScale: number;
} | null {
  if (!wholeLayer.text?.transform || wholeLayer.text.transform.length !== 6) {
    return null;
  }
  const [a, bm, c, d, e, f] = wholeLayer.text.transform;
  const origText = (wholeLayer.text.text || '0').trim();
  const value = newWhole.trim();
  const fontSize = typeof wholeLayer.text.style?.fontSize === 'number' && wholeLayer.text.style.fontSize > 0
    ? wholeLayer.text.style.fontSize
    : 50;

  // Medição no espaço do transform usando canvas se disponível, com fallback para métricas Zullia
  let origLocal = 0;
  let measuredLocal = 0;

  const canvas = createLayerCanvas(10, 10);
  const ctx = canvas?.getContext?.('2d');
  if (ctx && typeof ctx.measureText === 'function') {
    ctx.font = `400 ${fontSize}px "Zullia", sans-serif`;
    origLocal = ctx.measureText(origText).width;
    measuredLocal = ctx.measureText(value).width;
  }

  const estimateZulliaWidth = (text: string) => {
    let units = 0;
    for (const ch of text) {
      if (ch === '1') units += 0.36;
      else if (ch === '0') units += 0.58;
      else if (ch === '2' || ch === '3' || ch === '5') units += 0.54;
      else if (ch === '4' || ch === '6' || ch === '9') units += 0.56;
      else if (ch === '7') units += 0.48;
      else if (ch === '8') units += 0.55;
      else units += 0.54;
    }
    return units * fontSize;
  };

  if (origLocal <= 0 || isNaN(origLocal) || origLocal === origText.length * 10) {
    origLocal = estimateZulliaWidth(origText);
  }
  if (measuredLocal <= 0 || isNaN(measuredLocal) || measuredLocal === value.length * 10) {
    measuredLocal = estimateZulliaWidth(value);
  }

  const scaleX = Math.hypot(a, bm);
  const unscaledPxWidth = measuredLocal * scaleX;

  // Limite seguro à esquerda e à direita
  const obstacleLeft = fractionLayer?.left && fractionLayer.left > 100
    ? fractionLayer.left
    : canvasWidth * 0.55;
  const safeRightLimit = Math.max(120, obstacleLeft - 20);
  const safeLeftLimit = 36;
  const availableWidth = Math.max(120, safeRightLimit - safeLeftLimit);

  const hScale = unscaledPxWidth > availableWidth
    ? Math.max(0.48, availableWidth / unscaledPxWidth)
    : 1.0;

  // Alinhamento à direita preservando a proximidade da vírgula
  const deltaU = (origLocal - measuredLocal * hScale) / 2;
  const targetTx = e + deltaU * a;
  const targetTy = f + deltaU * bm;

  return {
    transform: [
      a * hScale,
      bm * hScale,
      c,
      d,
      targetTx,
      targetTy,
    ],
    horizontalScale: hScale,
  };
}

/**
 * Renderiza o texto atualizado diretamente no canal de bitmap (layer.canvas) com bounds expandidos
 * e matriz afim de transformação (transform).
 * No Photoshop CS6, camadas de texto dependem do canal de bitmap para exibição imediata ao abrir o arquivo.
 * Se o bitmap for descartado, o Photoshop CS6 colapsa os bounds da camada para 0x0, deixando o texto invisível.
 * Se o bitmap for estreito, o texto e os efeitos (traçado de 74px e dropShadow) são cortados nas bordas.
 * Esta função aplica um padding generoso (padX/padY), aplica a matriz afim nativa (setTransform) e desenha
 * o novo texto com a cor e baseline exatos da camada, garantindo exibição instantânea, completa e sem cortes.
 */
export function renderTextLayerToBitmap(
  layer: Layer,
  newText: string,
  docWidth?: number,
  docHeight?: number
): void {
  // Descarta os pixels legados antigos em cache
  delete layer.imageData;

  const rawLeft = layer.left ?? 0;
  const rawRight = layer.right ?? rawLeft;
  const rawTop = layer.top ?? 0;
  const rawBottom = layer.bottom ?? rawTop;

  const transform = layer.text?.transform;
  const hasTransform = Array.isArray(transform) && transform.length === 6;

  const oldLen = layer.text?.text?.trim().length ?? 1;
  const newLen = newText.trim().length;
  const charDiff = Math.max(0, newLen - oldLen);
  const extraWidth = charDiff * 160;

  // Margem generosa para nunca cortar glifos inclinados (Zullia 15.6°) nem traçados de 74px e sombras projetadas
  const padX = 140 + extraWidth;
  const padY = 70;

  const newLeft = Math.max(0, Math.round(rawLeft - padX));
  const newRight = typeof docWidth === 'number' && docWidth > 0
    ? Math.min(docWidth, Math.round(rawRight + padX))
    : Math.round(rawRight + padX);
  const newTop = Math.max(0, Math.round(rawTop - padY));
  const newBottom = typeof docHeight === 'number' && docHeight > 0
    ? Math.min(docHeight, Math.round(rawBottom + padY))
    : Math.round(rawBottom + padY);

  layer.left = newLeft;
  layer.right = newRight;
  layer.top = newTop;
  layer.bottom = newBottom;

  const width = Math.max(1, newRight - newLeft);
  const height = Math.max(1, newBottom - newTop);

  const canvas = createLayerCanvas(width, height);
  layer.canvas = canvas;

  try {
    const ctx = canvas.getContext?.('2d');
    if (ctx) {
      ctx.clearRect?.(0, 0, width, height);
      ctx.save?.();

      const style = layer.text?.style;
      const fontName = style?.font?.name ?? 'Zullia';
      const color: any = style?.fillColor;
      let fillStyle = '#000000';
      if (color && typeof color.r === 'number' && typeof color.g === 'number' && typeof color.b === 'number') {
        const r = Math.min(255, Math.max(0, Math.round(color.r)));
        const g = Math.min(255, Math.max(0, Math.round(color.g)));
        const b = Math.min(255, Math.max(0, Math.round(color.b)));
        fillStyle = `rgb(${r},${g},${b})`;
      }
      ctx.fillStyle = fillStyle;

      if (hasTransform) {
        const [a, b, c, d, tx, ty] = transform;
        const localTx = tx - newLeft;
        const localTy = ty - newTop;

        // Aplica a matriz afim do texto posicionando a âncora localmente no canvas
        ctx.setTransform?.(a, b, c, d, localTx, localTy);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';

        const fontSize = typeof style?.fontSize === 'number' && style.fontSize > 0 ? style.fontSize : 50;
        ctx.font = `${fontSize}px "${fontName}", "Brush Hand New", Arial, Impact, sans-serif`;
        ctx.fillText?.(newText.trim(), 0, 0);
      } else {
        const fontSize = Math.max(12, Math.round(height * 0.75));
        ctx.font = `${fontSize}px "${fontName}", Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText?.(newText.trim(), width / 2, height / 2);
      }

      ctx.restore?.();
    }
  } catch {
    // mock / fallback
  }
}

export function invalidateTextLayerPixelCache(layer: Layer): void {
  delete layer.canvas;
  delete layer.imageData;
}

export function findFirstTextLayerMatching(
  container: { children?: Layer[] },
  pattern: RegExp
): Layer | null {
  if (!container?.children) return null;
  for (const layer of container.children) {
    if (!layer.hidden && layer.text && pattern.test(layer.text.text || '')) {
      return layer;
    }
    if (layer.children) {
      const found = findFirstTextLayerMatching(layer, pattern);
      if (found) return found;
    }
  }
  return null;
}

export function validateExportJobBasics(job: ScantechExportJob): string | null {
  if (!job.wholeValue || !job.wholeValue.trim() || !/^\d+$/.test(job.wholeValue.trim())) {
    return `F7 ${job.f7}: Parte inteira do preço (Reais) inválida.`;
  }
  if (!job.fractionValue || !job.fractionValue.trim() || !/^\d{2}$/.test(job.fractionValue.trim())) {
    return `F7 ${job.f7}: Centavos do preço inválidos (devem ter 2 dígitos).`;
  }
  if (!job.sourcePsdPath || !job.sourcePsdPath.trim()) {
    return `F7 ${job.f7}: Arquivo PSD original não vinculado.`;
  }
  if (!job.outputPsdPath || !job.outputPsdPath.trim()) {
    return `F7 ${job.f7}: Caminho de destino para gravação do PSD não informado.`;
  }
  const normSrc = job.sourcePsdPath.replace(/\\/g, '/').toLowerCase();
  const normDst = job.outputPsdPath.replace(/\\/g, '/').toLowerCase();
  if (normSrc === normDst) {
    return `F7 ${job.f7}: Bloqueado por segurança: o arquivo de saída não pode sobrescrever o PSD original.`;
  }
  return null;
}

export type ScantechDirectExportIo = {
  readSourcePsd: (sourcePath: string) => Promise<ArrayBuffer>;
  writeOutputPsd: (outputPath: string, sourcePsdPath: string, bytes: Uint8Array) => Promise<{ fileSize: number }>;
};

export const defaultDirectExportIo: ScantechDirectExportIo = {
  readSourcePsd: async (sourcePath: string) => {
    if (isTauri()) {
      const { buffer } = await readPsdByPath(sourcePath);
      return buffer;
    }
    const proc = (globalThis as any).process;
    if (proc?.versions?.node) {
      const dynamicImport = new Function('m', 'return import(m)');
      const fs = await dynamicImport('node:fs/promises');
      const buf = await fs.readFile(sourcePath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    throw new Error('Ambiente não suportado para leitura de PSD.');
  },
  writeOutputPsd: async (outputPath: string, sourcePsdPath: string, bytes: Uint8Array) => {
    if (isTauri()) {
      const res = await invoke<{ fileSize: number }>('write_scantech_psd', {
        request: {
          outputPath,
          sourcePsdPath,
          bytes: Array.from(bytes),
        },
      });
      return res;
    }
    const proc = (globalThis as any).process;
    if (proc?.versions?.node) {
      const dynamicImport = new Function('m', 'return import(m)');
      const fs = await dynamicImport('node:fs/promises');
      const pathModule = await dynamicImport('node:path');
      const parent = pathModule.dirname(outputPath);
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(outputPath, bytes);
      const stat = await fs.stat(outputPath);
      return { fileSize: stat.size };
    }
    throw new Error('Ambiente não suportado para gravação de PSD.');
  },
};

function preparePsdForWriting(psd: Psd) {
  psd.colorMode = 3; // ColorMode.RGB
  psd.bitsPerChannel = 8;
  const cleanLayer = (layer: Layer) => {
    if (layer.rawData && (layer.rawData.bitsPerChannel !== 8 || layer.rawData.colorMode !== 3)) {
      delete (layer as any).rawData;
    }
    if (layer.children) {
      layer.children.forEach(cleanLayer);
    }
  };
  (psd.children ?? []).forEach(cleanLayer);
}

export async function executeScantechDirectExportJob(
  job: ScantechExportJob,
  io: ScantechDirectExportIo = defaultDirectExportIo
): Promise<ScantechExportJobResult> {
  const basicErr = validateExportJobBasics(job);
  if (basicErr) {
    return {
      itemId: job.itemId,
      f7: job.f7,
      ok: false,
      outputPsdPath: job.outputPsdPath,
      error: basicErr,
      warnings: [],
      wholeApplied: null,
      fractionApplied: null,
      validityApplied: null,
      horizontalScaleApplied: null,
      normalizedTransform: null,
      fileSize: null,
    };
  }

  ensureCanvasInitialized();

  let rawBuffer: ArrayBuffer;
  try {
    rawBuffer = await io.readSourcePsd(job.sourcePsdPath);
  } catch (e) {
    return {
      itemId: job.itemId,
      f7: job.f7,
      ok: false,
      outputPsdPath: job.outputPsdPath,
      error: `Não foi possível ler o PSD original: ${e instanceof Error ? e.message : String(e)}`,
      warnings: [],
      wholeApplied: null,
      fractionApplied: null,
      validityApplied: null,
      horizontalScaleApplied: null,
      normalizedTransform: null,
      fileSize: null,
    };
  }

  let psd: Psd;
  try {
    psd = readPsd(rawBuffer, { useImageData: true, throwForMissingFeatures: false });
  } catch (e) {
    return {
      itemId: job.itemId,
      f7: job.f7,
      ok: false,
      outputPsdPath: job.outputPsdPath,
      error: `Falha ao interpretar a estrutura do PSD: ${e instanceof Error ? e.message : String(e)}`,
      warnings: [],
      wholeApplied: null,
      fractionApplied: null,
      validityApplied: null,
      horizontalScaleApplied: null,
      normalizedTransform: null,
      fileSize: null,
    };
  }

  const wholeLayer = resolveLayerByPath(psd, job.wholeLayerId);
  if (!wholeLayer || !wholeLayer.text) {
    return {
      itemId: job.itemId,
      f7: job.f7,
      ok: false,
      outputPsdPath: job.outputPsdPath,
      error: `Camada de Reais (${job.wholeLayerId}) não encontrada no PSD ou não é uma camada de texto editável.`,
      warnings: [],
      wholeApplied: null,
      fractionApplied: null,
      validityApplied: null,
      horizontalScaleApplied: null,
      normalizedTransform: null,
      fileSize: null,
    };
  }

  const fractionLayer = resolveLayerByPath(psd, job.fractionLayerId);
  if (!fractionLayer || !fractionLayer.text) {
    return {
      itemId: job.itemId,
      f7: job.f7,
      ok: false,
      outputPsdPath: job.outputPsdPath,
      error: `Camada de Centavos (${job.fractionLayerId}) não encontrada no PSD ou não é uma camada de texto editável.`,
      warnings: [],
      wholeApplied: null,
      fractionApplied: null,
      validityApplied: null,
      horizontalScaleApplied: null,
      normalizedTransform: null,
      fileSize: null,
    };
  }

  // Altera os textos usando os valores da planilha
  wholeLayer.text.text = job.wholeValue.trim();
  fractionLayer.text.text = job.fractionValue.trim();

  let validityApplied = '';
  if (job.validityText) {
    let validityLayer = resolveLayerByPath(psd, job.validityLayerId);
    if (!validityLayer || !validityLayer.text) {
      validityLayer = findFirstTextLayerMatching(
        psd,
        /(oferta\s+v[aá]lida|v[aá]lid[ao]\s+at[eé]|v[aá]lid[ao]\s+de\b|promo[cç][aã]o|vencimento|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b)/i
      );
    }
    if (validityLayer && validityLayer.text) {
      validityLayer.text.text = job.validityText.trim();
      validityApplied = validityLayer.text.text;
    }
  }

  // Descarta o composite global antigo (com preços desatualizados achatados)
  delete psd.canvas;
  delete psd.imageData;

  let normalizedTransformApplied = false;
  let appliedHScale = 1.0;

  if (Array.isArray(job.normalizedTransform) && job.normalizedTransform.length === 6) {
    wholeLayer.text.transform = [...job.normalizedTransform];
    normalizedTransformApplied = true;
  } else if (wholeLayer.text.transform && wholeLayer.text.transform.length === 6) {
    const [xx, xy, yx, yy, tx, ty] = wholeLayer.text.transform;
    const scaleX = Math.hypot(xx, xy);
    const rotRad = Math.atan2(xy, xx);
    const rotDeg = (rotRad * 180) / Math.PI;
    const skewDeg = (Math.atan2(yx, yy) * 180) / Math.PI;
    let rotDelta = job.rotateDeltaDeg ?? 0;
    let skewDelta = job.skewDeltaDeg ?? 0;
    const isOnes = /^1{2,}$/.test(job.wholeValue.trim());

    if (rotDelta === 0 && skewDelta === 0 && isOnes && (Math.abs(rotDeg) > 0.8 || skewDeg - rotDeg < 13.5)) {
      rotDelta = Math.abs(rotDeg) > 0.8 ? -rotDeg : 0;
      const afterRot = skewDeg - rotDelta;
      const targetSkew = Math.min(17.5, Math.max(afterRot, 15.6));
      skewDelta = targetSkew - afterRot;
    }

    if (Math.abs(rotDelta) > 0.1 || Math.abs(skewDelta) > 0.1) {
      const targetSkew = skewDeg + skewDelta;
      const normXx = scaleX;
      const normXy = 0;
      const normYy = yy * Math.cos(rotRad) - yx * Math.sin(rotRad);
      const normYx = normYy * Math.tan((targetSkew * Math.PI) / 180);
      wholeLayer.text.transform = [normXx, normXy, normYx, normYy, tx, ty];
      normalizedTransformApplied = true;
    }
  }

  const adjJob = computeAdjustedWholeTransform(wholeLayer, job.wholeValue, fractionLayer, psd.width);
  if (adjJob) {
    wholeLayer.text.transform = adjJob.transform;
    normalizedTransformApplied = true;
    if (adjJob.horizontalScale < 1) {
      appliedHScale = Math.min(appliedHScale, adjJob.horizontalScale);
    }
  }

  if (typeof job.horizontalScale === 'number' && job.horizontalScale > 0 && job.horizontalScale < 1) {
    appliedHScale = job.horizontalScale;
    if (wholeLayer.text.style) {
      wholeLayer.text.style.horizontalScale = appliedHScale;
    }
    if (Array.isArray(wholeLayer.text.styleRuns)) {
      for (const run of wholeLayer.text.styleRuns) {
        if (run.style) run.style.horizontalScale = appliedHScale;
      }
    }
  }

  // Renderiza os bitmaps atualizados com matriz afim e bounds expandidos para exibição
  // imediata no Photoshop CS6 sem cortes e com a tipografia Zullia exata.
  renderTextLayerToBitmap(wholeLayer, job.wholeValue, psd.width, psd.height);
  renderTextLayerToBitmap(fractionLayer, job.fractionValue, psd.width, psd.height);
  if (validityApplied) {
    let validityLayer = resolveLayerByPath(psd, job.validityLayerId);
    if (!validityLayer || !validityLayer.text) {
      validityLayer = findFirstTextLayerMatching(
        psd,
        /(oferta\s+v[aá]lida|v[aá]lid[ao]\s+at[eé]|v[aá]lid[ao]\s+de\b|promo[cç][aã]o|vencimento|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b)/i
      );
    }
    if (validityLayer && validityLayer.text) {
      renderTextLayerToBitmap(validityLayer, validityApplied, psd.width, psd.height);
    }
  }

  let outBytes: ArrayBuffer;
  try {
    preparePsdForWriting(psd);
    outBytes = writePsd(psd, { invalidateTextLayers: true });
  } catch (e) {
    return {
      itemId: job.itemId,
      f7: job.f7,
      ok: false,
      outputPsdPath: job.outputPsdPath,
      error: `Falha ao codificar novo arquivo PSD: ${e instanceof Error ? e.message : String(e)}`,
      warnings: [],
      wholeApplied: null,
      fractionApplied: null,
      validityApplied: null,
      horizontalScaleApplied: null,
      normalizedTransform: null,
      fileSize: null,
    };
  }

  let fileSize: number;
  try {
    const writeRes = await io.writeOutputPsd(job.outputPsdPath, job.sourcePsdPath, new Uint8Array(outBytes));
    fileSize = writeRes.fileSize;
  } catch (e) {
    return {
      itemId: job.itemId,
      f7: job.f7,
      ok: false,
      outputPsdPath: job.outputPsdPath,
      error: `Erro ao gravar arquivo PSD de destino: ${e instanceof Error ? e.message : String(e)}`,
      warnings: [],
      wholeApplied: null,
      fractionApplied: null,
      validityApplied: null,
      horizontalScaleApplied: null,
      normalizedTransform: null,
      fileSize: null,
    };
  }

  return {
    itemId: job.itemId,
    f7: job.f7,
    ok: true,
    outputPsdPath: job.outputPsdPath,
    error: null,
    warnings: [],
    wholeApplied: job.wholeValue.trim(),
    fractionApplied: job.fractionValue.trim(),
    validityApplied: validityApplied || null,
    horizontalScaleApplied: appliedHScale,
    normalizedTransform: normalizedTransformApplied,
    fileSize,
  };
}

export async function exportScantechPsdsDirect(
  jobs: ScantechExportJob[],
  io: ScantechDirectExportIo = defaultDirectExportIo
): Promise<ScantechExportBatchResult> {
  if (jobs.length === 0) {
    return {
      photoshopVersion: null,
      directExport: true,
      engine: 'ag-psd (direto)',
      results: [],
    };
  }

  const results: ScantechExportJobResult[] = [];
  for (const job of jobs) {
    const res = await executeScantechDirectExportJob(job, io);
    results.push(res);
  }

  return {
    photoshopVersion: null,
    directExport: true,
    engine: 'ag-psd (direto)',
    results,
  };
}

export type DerivedPsdPayload = {
  sourcePsdPath?: string | null;
  sourcePsdBuffer?: ArrayBuffer;
  outputPsdPath: string;
  allowSamePath?: boolean;
  category?: string;
  title: string;
  complement?: string;
  packaging?: string;
  whole: string;
  fraction: string;
  validityText?: string;
  hasBoxPrice?: boolean;
  boxQuantity?: number;
  boxUnitLabel?: string;
  boxWhole?: string;
  boxFraction?: string;
  productImage?: { dataUrl: string; fileName?: string };
  roles: {
    categoryLayerId?: string;
    titleLayerId?: string;
    complementLayerId?: string;
    packagingLayerId?: string;
    wholeLayerId?: string;
    fractionLayerId?: string;
    validityLayerId?: string;
    boxQtyLayerId?: string;
    boxWholeLayerId?: string;
    boxFractionLayerId?: string;
  };
};

export async function exportDerivedPsdDirect(
  payload: DerivedPsdPayload,
  io: ScantechDirectExportIo = defaultDirectExportIo
): Promise<{ ok: boolean; error?: string; outputPsdPath: string; bytes?: Uint8Array }> {
  if (!payload.sourcePsdBuffer && (!payload.sourcePsdPath || !payload.sourcePsdPath.trim())) {
    return { ok: false, error: 'Arquivo PSD de referência não informado.', outputPsdPath: payload.outputPsdPath };
  }
  if (!payload.outputPsdPath || !payload.outputPsdPath.trim()) {
    return { ok: false, error: 'Caminho de saída do PSD não informado.', outputPsdPath: payload.outputPsdPath };
  }
  const normSrc = (payload.sourcePsdPath || '').replace(/\\/g, '/').toLowerCase();
  const normDst = payload.outputPsdPath.replace(/\\/g, '/').toLowerCase();
  if (normSrc && normSrc === normDst && !payload.allowSamePath) {
    return { ok: false, error: 'Bloqueado por segurança: o arquivo de saída não pode sobrescrever o PSD de referência original.', outputPsdPath: payload.outputPsdPath };
  }

  ensureCanvasInitialized();

  let rawBuffer: ArrayBuffer;
  if (payload.sourcePsdBuffer) {
    rawBuffer = payload.sourcePsdBuffer;
  } else {
    try {
      rawBuffer = await io.readSourcePsd(payload.sourcePsdPath!);
    } catch (e) {
      return { ok: false, error: `Falha ao ler o PSD de referência: ${e instanceof Error ? e.message : String(e)}`, outputPsdPath: payload.outputPsdPath };
    }
  }

  let psd: Psd;
  try {
    psd = readPsd(rawBuffer, { useImageData: true, throwForMissingFeatures: false });
  } catch (e) {
    return { ok: false, error: `Falha ao interpretar o PSD: ${e instanceof Error ? e.message : String(e)}`, outputPsdPath: payload.outputPsdPath };
  }

  let updatedAnyText = false;

  if (payload.roles.wholeLayerId) {
    const wholeLayer = resolveLayerByPath(psd, payload.roles.wholeLayerId);
    if (wholeLayer && wholeLayer.text) {
      const fractionLayer = payload.roles.fractionLayerId
        ? resolveLayerByPath(psd, payload.roles.fractionLayerId)
        : null;
      const adj = computeAdjustedWholeTransform(wholeLayer, payload.whole, fractionLayer, psd.width);
      if (adj) {
        wholeLayer.text.transform = adj.transform;
        if (adj.horizontalScale < 1 && wholeLayer.text.style) {
          wholeLayer.text.style.horizontalScale = adj.horizontalScale;
        }
      }
      wholeLayer.text.text = payload.whole.trim();
      renderTextLayerToBitmap(wholeLayer, payload.whole, psd.width, psd.height);
      updatedAnyText = true;
    }
  }

  if (payload.roles.fractionLayerId) {
    const fractionLayer = resolveLayerByPath(psd, payload.roles.fractionLayerId);
    if (fractionLayer && fractionLayer.text) {
      fractionLayer.text.text = payload.fraction.trim();
      renderTextLayerToBitmap(fractionLayer, payload.fraction, psd.width, psd.height);
      updatedAnyText = true;
    }
  }

  if (payload.category && payload.roles.categoryLayerId) {
    const catLayer = resolveLayerByPath(psd, payload.roles.categoryLayerId);
    if (catLayer && catLayer.text) {
      catLayer.text.text = payload.category.trim();
      renderTextLayerToBitmap(catLayer, catLayer.text.text, psd.width, psd.height);
      updatedAnyText = true;
    }
  }

  if (payload.title && payload.roles.titleLayerId) {
    const titleLayer = resolveLayerByPath(psd, payload.roles.titleLayerId);
    if (titleLayer && titleLayer.text) {
      const trimmedTitle = payload.title.trim();
      titleLayer.text.text = trimmedTitle;

      // Se o título for extenso (ex.: mais de 20 caracteres ou com quebra de linha),
      // reduz proporcionalmente o tamanho da fonte no PSD derivado para evitar que o
      // Photoshop CS6 quebre linhas sobre elementos decorativos subjacentes.
      const currentFontSize =
        titleLayer.text.style?.fontSize ??
        titleLayer.text.styleRuns?.[0]?.style?.fontSize;

      if (currentFontSize && (trimmedTitle.length > 20 || trimmedTitle.includes('\n'))) {
        const charCount = trimmedTitle.length;
        let scaleFactor = 1.0;
        if (charCount > 35) {
          scaleFactor = 0.65;
        } else if (charCount > 26) {
          scaleFactor = 0.75;
        } else if (charCount > 20) {
          scaleFactor = 0.85;
        }
        const newFontSize = Math.round(currentFontSize * scaleFactor);
        if (titleLayer.text.style) {
          titleLayer.text.style.fontSize = newFontSize;
        }
        if (titleLayer.text.styleRuns) {
          for (const run of titleLayer.text.styleRuns) {
            if (run.style) run.style.fontSize = newFontSize;
          }
        }
      }

      renderTextLayerToBitmap(titleLayer, titleLayer.text.text, psd.width, psd.height);
      updatedAnyText = true;
    }
  }

  if (payload.complement && payload.roles.complementLayerId) {
    const compLayer = resolveLayerByPath(psd, payload.roles.complementLayerId);
    if (compLayer && compLayer.text) {
      compLayer.text.text = payload.complement.trim();
      renderTextLayerToBitmap(compLayer, compLayer.text.text, psd.width, psd.height);
      updatedAnyText = true;
    }
  }

  if (payload.packaging && payload.roles.packagingLayerId) {
    const packLayer = resolveLayerByPath(psd, payload.roles.packagingLayerId);
    if (packLayer && packLayer.text) {
      packLayer.text.text = payload.packaging.trim();
      renderTextLayerToBitmap(packLayer, packLayer.text.text, psd.width, psd.height);
      updatedAnyText = true;
    }
  }

  if (payload.validityText) {
    let valLayer = resolveLayerByPath(psd, payload.roles.validityLayerId);
    if (!valLayer || !valLayer.text) {
      valLayer = findFirstTextLayerMatching(
        psd,
        /(oferta\s+v[aá]lida|v[aá]lid[ao]\s+at[eé]|v[aá]lid[ao]\s+de\b|promo[cç][aã]o|vencimento|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b)/i
      );
    }
    if (valLayer && valLayer.text) {
      valLayer.text.text = payload.validityText.trim();
      renderTextLayerToBitmap(valLayer, valLayer.text.text, psd.width, psd.height);
      updatedAnyText = true;
    }
  }

function scaleAndCenterPriceLayer(
  layer: Layer,
  canvasW: number,
  canvasH: number
): void {
  const centerX = canvasW / 2;
  const origCenterY = canvasH * 0.62;
  const targetCenterY = canvasH * 0.57;
  const scale = 0.66;

  if (layer.text?.transform) {
    const t = layer.text.transform;
    const a = t[0] * scale;
    const b = t[1] * scale;
    const c = t[2] * scale;
    const d = t[3] * scale;
    const tx = centerX + (t[4] - centerX) * scale;
    const ty = targetCenterY + (t[5] - origCenterY) * scale;
    layer.text.transform = [a, b, c, d, tx, ty];
  } else if (layer.text?.style?.fontSize) {
    layer.text.style.fontSize = Math.round(layer.text.style.fontSize * scale);
  }

  if (typeof layer.left === 'number' && typeof layer.right === 'number') {
    const w = (layer.right - layer.left) * scale;
    const midX = centerX + ((layer.left + layer.right) / 2 - centerX) * scale;
    layer.left = Math.round(midX - w / 2);
    layer.right = Math.round(midX + w / 2);
  }
  if (typeof layer.top === 'number' && typeof layer.bottom === 'number') {
    const h = (layer.bottom - layer.top) * scale;
    const midY = targetCenterY + ((layer.top + layer.bottom) / 2 - origCenterY) * scale;
    layer.top = Math.round(midY - h / 2);
    layer.bottom = Math.round(midY + h / 2);
  }
}

  // Atualização dos campos de Caixa Fechada / Atacado
  if (payload.hasBoxPrice || payload.boxWhole || payload.boxFraction) {
    const mainWholeId = payload.roles.wholeLayerId;
    const mainFractionId = payload.roles.fractionLayerId;

    const hasNativeBoxStructure = Boolean(
      (payload.roles.boxWholeLayerId && resolveLayerByPath(psd, payload.roles.boxWholeLayerId)) ||
      findFirstTextLayerMatching(psd, /caixa\s+com|fardo\s+com/i)
    );

    let bWholeLayer: Layer | null = null;
    if (hasNativeBoxStructure) {
      bWholeLayer = resolveLayerByPath(psd, payload.roles.boxWholeLayerId);
      if (!bWholeLayer || !bWholeLayer.text) {
        bWholeLayer = findFirstTextLayerMatching(psd, /^(?:32|47|105|\d{1,4})$/);
        if (bWholeLayer && (bWholeLayer.name === mainWholeId || bWholeLayer.name === mainFractionId)) {
          bWholeLayer = null;
        }
      }
    }

    if (!hasNativeBoxStructure && (payload.hasBoxPrice || payload.boxWhole)) {
      // Injeta cirurgicamente as camadas do formato de caixa no PSD para o Photoshop CS6
      // Calibrado fielmente a partir do modelo_de_caixa.psd oficial
      const canvasW = psd.width;
      const canvasH = psd.height;

      // 1. Limpa camadas de caixa pré-existentes de exportações anteriores para evitar duplicações
      const BOX_LAYER_NAMES = new Set([
        'Rectangle 2 cópia',
        'Rectangle 3 cópia 2',
        'CAIXA COM ',
        'CAIXA COM',
        '12 UND. ',
        '12 UND.',
        '46',
        '68',
        '32',
        '20',
        '28',
        ',  cópia 3',
        ', cópia 3',
      ]);
      if (psd.children) {
        psd.children = psd.children.filter(l => !l.name || !BOX_LAYER_NAMES.has(l.name));
      }

      // 2. Reduz e centraliza a camada de preço unitário (vermelho) no espaço entre o título e a caixa
      const mainWhole = resolveLayerByPath(psd, mainWholeId);
      if (mainWhole && mainWhole.text) {
        scaleAndCenterPriceLayer(mainWhole, canvasW, canvasH);
        renderTextLayerToBitmap(mainWhole, mainWhole.text.text, psd.width, psd.height);
      }
      const mainFrac = resolveLayerByPath(psd, mainFractionId);
      if (mainFrac && mainFrac.text) {
        scaleAndCenterPriceLayer(mainFrac, canvasW, canvasH);
        renderTextLayerToBitmap(mainFrac, mainFrac.text.text, psd.width, psd.height);
      }
      if (payload.roles.packagingLayerId) {
        const packLayer = resolveLayerByPath(psd, payload.roles.packagingLayerId);
        if (packLayer && packLayer.text) {
          scaleAndCenterPriceLayer(packLayer, canvasW, canvasH);
          renderTextLayerToBitmap(packLayer, packLayer.text.text, psd.width, psd.height);
        }
      }
      const commaUnitLayer = findFirstTextLayerMatching(psd, /^,\s*(?:c[oó]pia)?$/i);
      if (commaUnitLayer && commaUnitLayer.text && commaUnitLayer !== mainWhole && commaUnitLayer !== mainFrac) {
        scaleAndCenterPriceLayer(commaUnitLayer, canvasW, canvasH);
        renderTextLayerToBitmap(commaUnitLayer, commaUnitLayer.text.text, psd.width, psd.height);
      }

      // 3. Injeta as 7 camadas oficiais calibradas fielmente a partir do modelo_de_caixa.psd
      const scaleX = canvasW / BOX_TEMPLATE_CANVAS.width;
      const scaleY = canvasH / BOX_TEMPLATE_CANVAS.height;

      const bWhole = payload.boxWhole ?? '0';
      const bFrac = payload.boxFraction ?? '00';
      const qtyStr = `${payload.boxQuantity ?? 12} ${(payload.boxUnitLabel ?? 'UND.').toUpperCase()} `;

      const newBoxLayers: Layer[] = [];
      for (const templateLayer of OFFICIAL_BOX_LAYERS) {
        const cloned: Layer = JSON.parse(JSON.stringify(templateLayer));

        if (typeof cloned.left === 'number') cloned.left = Math.round(cloned.left * scaleX);
        if (typeof cloned.right === 'number') cloned.right = Math.round(cloned.right * scaleX);
        if (typeof cloned.top === 'number') cloned.top = Math.round(cloned.top * scaleY);
        if (typeof cloned.bottom === 'number') cloned.bottom = Math.round(cloned.bottom * scaleY);

        if (cloned.text && cloned.text.transform) {
          cloned.text.transform[0] *= scaleX;
          cloned.text.transform[1] *= scaleX;
          cloned.text.transform[2] *= scaleY;
          cloned.text.transform[3] *= scaleY;
          cloned.text.transform[4] *= scaleX;
          cloned.text.transform[5] *= scaleY;
        }

        if (cloned.name === '46' || cloned.name === '32') {
          cloned.name = '46';
          if (cloned.text) cloned.text.text = bWhole;
        } else if (cloned.name === '68' || cloned.name === '28') {
          cloned.name = '68';
          if (cloned.text) cloned.text.text = bFrac;
        } else if (cloned.name && cloned.name.includes('UND.')) {
          cloned.name = '12 UND. ';
          if (cloned.text) cloned.text.text = qtyStr;
        } else if (cloned.name && cloned.name.includes('CAIXA COM')) {
          cloned.name = 'CAIXA COM ';
          if (cloned.text) cloned.text.text = 'CAIXA COM ';
        }

        if (cloned.text) {
          renderTextLayerToBitmap(cloned, cloned.text.text, psd.width, psd.height);
        }

        newBoxLayers.push(cloned);
      }

      if (!psd.children) psd.children = [];
      psd.children.push(...newBoxLayers);
      updatedAnyText = true;
    } else {
      if (payload.boxWhole && bWholeLayer && bWholeLayer.text) {
        bWholeLayer.text.text = payload.boxWhole.trim();
        renderTextLayerToBitmap(bWholeLayer, bWholeLayer.text.text, psd.width, psd.height);
        updatedAnyText = true;
      }

      if (payload.boxFraction) {
        let bFracLayer = resolveLayerByPath(psd, payload.roles.boxFractionLayerId);
        if (!bFracLayer || !bFracLayer.text) {
          bFracLayer = findFirstTextLayerMatching(psd, /^(?:28|88|48|\d{2})$/);
          if (bFracLayer && (bFracLayer.name === mainWholeId || bFracLayer.name === mainFractionId)) {
            bFracLayer = null;
          }
        }
        if (bFracLayer && bFracLayer.text) {
          bFracLayer.text.text = payload.boxFraction.trim();
          renderTextLayerToBitmap(bFracLayer, bFracLayer.text.text, psd.width, psd.height);
          updatedAnyText = true;
        }
      }

      if (payload.boxQuantity != null || payload.boxUnitLabel) {
        let bQtyLayer = resolveLayerByPath(psd, payload.roles.boxQtyLayerId);
        if (!bQtyLayer || !bQtyLayer.text) {
          bQtyLayer = findFirstTextLayerMatching(psd, /^\d+\s*(?:UND|UN|CX|PCT)\.?\s*$/i);
        }
        if (bQtyLayer && bQtyLayer.text) {
          const qtyStr = `${payload.boxQuantity ?? 12} ${payload.boxUnitLabel ?? 'UND.'} `;
          bQtyLayer.text.text = qtyStr;
          renderTextLayerToBitmap(bQtyLayer, bQtyLayer.text.text, psd.width, psd.height);
          updatedAnyText = true;
        }
      }
    }
  }

  if (updatedAnyText) {
    delete psd.canvas;
    delete psd.imageData;
  }

  let outBytes: ArrayBuffer;
  try {
    preparePsdForWriting(psd);
    outBytes = writePsd(psd, { invalidateTextLayers: true });
  } catch (e) {
    return { ok: false, error: `Falha ao serializar PSD atualizado: ${e instanceof Error ? e.message : String(e)}`, outputPsdPath: payload.outputPsdPath };
  }

  try {
    if (payload.allowSamePath && normSrc === normDst) {
      try {
        await io.writeOutputPsd(payload.outputPsdPath + '.bak', payload.sourcePsdPath || '', new Uint8Array(rawBuffer));
      } catch {
        // backup do PSD anterior
      }
    }
    await io.writeOutputPsd(payload.outputPsdPath, payload.sourcePsdPath || '', new Uint8Array(outBytes));
  } catch (e) {
    return { ok: false, error: `Falha ao gravar PSD derivado: ${e instanceof Error ? e.message : String(e)}`, outputPsdPath: payload.outputPsdPath };
  }

  return { ok: true, outputPsdPath: payload.outputPsdPath, bytes: new Uint8Array(outBytes) };
}
