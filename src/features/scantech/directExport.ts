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

  // Altera os textos usando os valores da planilha
  wholeLayer.text.text = job.wholeValue.trim();
  fractionLayer.text.text = job.fractionValue.trim();

  let validityApplied = '';
  if (job.validityText) {
    let validityLayer = resolveLayerByPath(psd, job.validityLayerId);
    if (!validityLayer || !validityLayer.text) {
      validityLayer = findFirstTextLayerMatching(psd, /(oferta\s+v[aá]lida|v[aá]lid[ao]\s+at[eé]|v[aá]lid[ao]\s+de\b)/i);
    }
    if (validityLayer && validityLayer.text) {
      validityLayer.text.text = job.validityText.trim();
      validityApplied = validityLayer.text.text;
    }
  }

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

  if (payload.roles.wholeLayerId) {
    const wholeLayer = resolveLayerByPath(psd, payload.roles.wholeLayerId);
    if (wholeLayer && wholeLayer.text) {
      wholeLayer.text.text = payload.whole.trim();
    }
  }

  if (payload.roles.fractionLayerId) {
    const fractionLayer = resolveLayerByPath(psd, payload.roles.fractionLayerId);
    if (fractionLayer && fractionLayer.text) {
      fractionLayer.text.text = payload.fraction.trim();
    }
  }

  if (payload.category && payload.roles.categoryLayerId) {
    const catLayer = resolveLayerByPath(psd, payload.roles.categoryLayerId);
    if (catLayer && catLayer.text) {
      catLayer.text.text = payload.category.trim();
    }
  }

  if (payload.title && payload.roles.titleLayerId) {
    const titleLayer = resolveLayerByPath(psd, payload.roles.titleLayerId);
    if (titleLayer && titleLayer.text) {
      titleLayer.text.text = payload.title.trim();
    }
  }

  if (payload.complement && payload.roles.complementLayerId) {
    const compLayer = resolveLayerByPath(psd, payload.roles.complementLayerId);
    if (compLayer && compLayer.text) {
      compLayer.text.text = payload.complement.trim();
    }
  }

  if (payload.packaging && payload.roles.packagingLayerId) {
    const packLayer = resolveLayerByPath(psd, payload.roles.packagingLayerId);
    if (packLayer && packLayer.text) {
      packLayer.text.text = payload.packaging.trim();
    }
  }

  if (payload.validityText) {
    let valLayer = resolveLayerByPath(psd, payload.roles.validityLayerId);
    if (!valLayer || !valLayer.text) {
      valLayer = findFirstTextLayerMatching(psd, /(oferta\s+v[aá]lida|v[aá]lid[ao]\s+at[eé]|v[aá]lid[ao]\s+de\b)/i);
    }
    if (valLayer && valLayer.text) {
      valLayer.text.text = payload.validityText.trim();
    }
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
