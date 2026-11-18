import { readPsd, writePsd, initializeCanvas, type Layer, type Psd } from 'ag-psd';
import type { ScantechExportJob, ScantechExportJobResult, ScantechExportBatchResult } from './types';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { readPsdByPath } from '../psd/service';

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
  if (!pathStr) return null;
  const parts = pathStr.split('.');
  let current: any = container;
  for (const part of parts) {
    const idx = parseInt(part, 10);
    if (isNaN(idx) || !current?.children || idx < 0 || idx >= current.children.length) {
      return null;
    }
    current = current.children[idx];
  }
  return current ?? null;
}

function createLayerCanvas(w: number, h: number): any {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    return c;
  }
  const makeImageData = (cw: number, ch: number) => ({
    data: new Uint8ClampedArray(cw * ch * 4),
    width: cw,
    height: ch,
  });
  return {
    width: Math.max(1, w),
    height: Math.max(1, h),
    getContext: () => ({
      getImageData: (_x: number, _y: number, cw: number, ch: number) => makeImageData(cw, ch),
      createImageData: (cw: number, ch: number) => makeImageData(cw, ch),
      putImageData: () => {},
      clearRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      save: () => {},
      restore: () => {},
      measureText: (txt: string) => ({ width: txt.length * 10 }),
    }),
  };
}

/**
 * Atualiza o bitmap da camada de texto re-desenhando o texto atualizado.
 * Remove os pixels legados antigos (layer.imageData) e desenha o novo texto no layer.canvas.
 * Isso garante que o Photoshop CS6 abra o PSD exibindo imediatamente os preços novos,
 * sem reter bitmaps velhos em cache e sem precisar que o usuário clique na camada com a ferramenta T.
 */
export function updateTextLayerBitmap(layer: Layer, newText: string): void {
  const width = Math.max(1, (layer.right ?? 0) - (layer.left ?? 0));
  const height = Math.max(1, (layer.bottom ?? 0) - (layer.top ?? 0));

  // Descarta os pixels legados antigos em cache
  delete layer.imageData;

  let canvas: any = layer.canvas;
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = createLayerCanvas(width, height);
  }

  const ctx = canvas?.getContext?.('2d');
  if (ctx) {
    try {
      ctx.clearRect?.(0, 0, width, height);

      const style = layer.text?.style;
      const fontSize = Math.max(12, Math.round(style?.fontSize ?? (height * 0.8)));
      const fontName = style?.font?.name ?? 'sans-serif';
      const color: any = style?.fillColor;
      let fillStyle = '#000000';
      if (color) {
        let r = 0, g = 0, b = 0;
        if (typeof color.r === 'number' && typeof color.g === 'number' && typeof color.b === 'number') {
          r = color.r; g = color.g; b = color.b;
        } else if (typeof color.fr === 'number' && typeof color.fg === 'number' && typeof color.fb === 'number') {
          r = Math.round(color.fr * 255); g = Math.round(color.fg * 255); b = Math.round(color.fb * 255);
        } else if (typeof color.red === 'number' && typeof color.green === 'number' && typeof color.blue === 'number') {
          r = color.red <= 1 ? Math.round(color.red * 255) : Math.round(color.red);
          g = color.green <= 1 ? Math.round(color.green * 255) : Math.round(color.green);
          b = color.blue <= 1 ? Math.round(color.blue * 255) : Math.round(color.blue);
        }
        r = Math.min(255, Math.max(0, r));
        g = Math.min(255, Math.max(0, g));
        b = Math.min(255, Math.max(0, b));
        fillStyle = `rgb(${r},${g},${b})`;
      }

      ctx.save?.();
      if (ctx.font !== undefined) {
        ctx.font = `bold ${fontSize}px "${fontName}", sans-serif`;
      }
      if (ctx.fillStyle !== undefined) {
        ctx.fillStyle = fillStyle;
      }
      if (ctx.textAlign !== undefined) {
        ctx.textAlign = 'center';
      }
      if (ctx.textBaseline !== undefined) {
        ctx.textBaseline = 'middle';
      }

      ctx.fillText?.(newText, width / 2, height / 2);
      ctx.restore?.();
    } catch {
      // Ignora silenciosamente se o contexto do mock não implementar métodos adicionais
    }
  }

  layer.canvas = canvas;
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

  // Altera os textos usando os valores da planilha e atualiza o bitmap da camada
  // desenhando o novo texto, descartando pixels antigos para que o Photoshop CS6
  // renderize imediatamente a nova arte ao abrir o arquivo.
  wholeLayer.text.text = job.wholeValue.trim();
  updateTextLayerBitmap(wholeLayer, wholeLayer.text.text);

  fractionLayer.text.text = job.fractionValue.trim();
  updateTextLayerBitmap(fractionLayer, fractionLayer.text.text);

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
      updateTextLayerBitmap(validityLayer, validityLayer.text.text);
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

  let outBytes: ArrayBuffer;
  try {
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
  sourcePsdPath: string;
  outputPsdPath: string;
  allowSamePath?: boolean;
  category?: string;
  title: string;
  complement?: string;
  packaging?: string;
  whole: string;
  fraction: string;
  validityText?: string;
  roles: {
    categoryLayerId?: string;
    titleLayerId?: string;
    complementLayerId?: string;
    packagingLayerId?: string;
    wholeLayerId?: string;
    fractionLayerId?: string;
    validityLayerId?: string;
  };
};

export async function exportDerivedPsdDirect(
  payload: DerivedPsdPayload,
  io: ScantechDirectExportIo = defaultDirectExportIo
): Promise<{ ok: boolean; error?: string; outputPsdPath: string }> {
  if (!payload.sourcePsdPath || !payload.sourcePsdPath.trim()) {
    return { ok: false, error: 'Arquivo PSD de referência não informado.', outputPsdPath: payload.outputPsdPath };
  }
  if (!payload.outputPsdPath || !payload.outputPsdPath.trim()) {
    return { ok: false, error: 'Caminho de saída do PSD não informado.', outputPsdPath: payload.outputPsdPath };
  }
  const normSrc = payload.sourcePsdPath.replace(/\\/g, '/').toLowerCase();
  const normDst = payload.outputPsdPath.replace(/\\/g, '/').toLowerCase();
  if (normSrc === normDst && !payload.allowSamePath) {
    return { ok: false, error: 'Bloqueado por segurança: o arquivo de saída não pode sobrescrever o PSD de referência original.', outputPsdPath: payload.outputPsdPath };
  }

  ensureCanvasInitialized();

  let rawBuffer: ArrayBuffer;
  try {
    rawBuffer = await io.readSourcePsd(payload.sourcePsdPath);
  } catch (e) {
    return { ok: false, error: `Falha ao ler o PSD de referência: ${e instanceof Error ? e.message : String(e)}`, outputPsdPath: payload.outputPsdPath };
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
      wholeLayer.text.text = payload.whole.trim();
      updateTextLayerBitmap(wholeLayer, wholeLayer.text.text);
      updatedAnyText = true;
    }
  }

  if (payload.roles.fractionLayerId) {
    const fractionLayer = resolveLayerByPath(psd, payload.roles.fractionLayerId);
    if (fractionLayer && fractionLayer.text) {
      fractionLayer.text.text = payload.fraction.trim();
      updateTextLayerBitmap(fractionLayer, fractionLayer.text.text);
      updatedAnyText = true;
    }
  }

  if (payload.category && payload.roles.categoryLayerId) {
    const catLayer = resolveLayerByPath(psd, payload.roles.categoryLayerId);
    if (catLayer && catLayer.text) {
      catLayer.text.text = payload.category.trim();
      updateTextLayerBitmap(catLayer, catLayer.text.text);
      updatedAnyText = true;
    }
  }

  if (payload.title && payload.roles.titleLayerId) {
    const titleLayer = resolveLayerByPath(psd, payload.roles.titleLayerId);
    if (titleLayer && titleLayer.text) {
      const trimmedTitle = payload.title.trim();
      titleLayer.text.text = trimmedTitle;
      updateTextLayerBitmap(titleLayer, titleLayer.text.text);
      updatedAnyText = true;

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
    }
  }

  if (payload.complement && payload.roles.complementLayerId) {
    const compLayer = resolveLayerByPath(psd, payload.roles.complementLayerId);
    if (compLayer && compLayer.text) {
      compLayer.text.text = payload.complement.trim();
      updateTextLayerBitmap(compLayer, compLayer.text.text);
      updatedAnyText = true;
    }
  }

  if (payload.packaging && payload.roles.packagingLayerId) {
    const packLayer = resolveLayerByPath(psd, payload.roles.packagingLayerId);
    if (packLayer && packLayer.text) {
      packLayer.text.text = payload.packaging.trim();
      updateTextLayerBitmap(packLayer, packLayer.text.text);
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
      updateTextLayerBitmap(valLayer, valLayer.text.text);
      updatedAnyText = true;
    }
  }

  if (updatedAnyText) {
    delete psd.canvas;
    delete psd.imageData;
  }

  let outBytes: ArrayBuffer;
  try {
    outBytes = writePsd(psd, { invalidateTextLayers: true });
  } catch (e) {
    return { ok: false, error: `Falha ao serializar PSD atualizado: ${e instanceof Error ? e.message : String(e)}`, outputPsdPath: payload.outputPsdPath };
  }

  try {
    if (payload.allowSamePath && normSrc === normDst) {
      try {
        await io.writeOutputPsd(payload.outputPsdPath + '.bak', payload.sourcePsdPath, new Uint8Array(rawBuffer));
      } catch {
        // backup do PSD anterior
      }
    }
    await io.writeOutputPsd(payload.outputPsdPath, payload.sourcePsdPath, new Uint8Array(outBytes));
  } catch (e) {
    return { ok: false, error: `Falha ao gravar PSD derivado: ${e instanceof Error ? e.message : String(e)}`, outputPsdPath: payload.outputPsdPath };
  }

  return { ok: true, outputPsdPath: payload.outputPsdPath };
}
