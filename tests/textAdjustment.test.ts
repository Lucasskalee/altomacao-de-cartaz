import test from 'node:test';
import assert from 'node:assert/strict';
import { readPsd, writePsd, initializeCanvas } from 'ag-psd';
import type { ImportedArtwork, ImportedPricePart } from '../src/features/cartazes/types';
import {
  computeSafeBottomLimit,
  computeTextLayoutAdjustment,
  MIN_TITLE_HORIZONTAL_SCALE,
  MIN_TITLE_FONT_SIZE_RATIO,
} from '../src/features/psd/textAdjustment';
import { exportDerivedPsdDirect, type DerivedPsdPayload } from '../src/features/scantech/directExport';

// Mock Canvas para ag-psd e testes unitários em Node.js
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const fakeCanvas = (w = 1179, h = 1770): any => ({
  width: w,
  height: h,
  getContext: () => ({
    clearRect() {},
    save() {},
    restore() {},
    drawImage() {},
    putImageData() {},
    fillRect() {},
    fillText() {},
    strokeText() {},
    transform() {},
    scale() {},
    translate() {},
    measureText: (txt: string) => ({ width: txt.length * 28 }),
    getImageData: (_x: number, _y: number, cw: number, ch: number) => ({
      data: new Uint8ClampedArray(cw * ch * 4),
      width: cw,
      height: ch,
    }),
  }),
  toDataURL: () => pixel,
});

initializeCanvas(fakeCanvas, (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h } as any));

function createMockArtwork(lineTop = 365, lineBottom = 373, lineAboveText = false): ImportedArtwork {
  const lineLayer = {
    id: '1',
    name: 'Linha Decorativa',
    type: 'vector' as const,
    visible: true,
    depth: 0,
    bounds: { left: 120, top: lineTop, right: 1059, bottom: lineBottom },
  };

  const titleLayer = {
    id: '0',
    name: 'Título Produto',
    type: 'text' as const,
    visible: true,
    depth: 0,
    bounds: { left: 100, top: 220, right: 1079, bottom: 350 },
  };

  const complementLayer = {
    id: '2',
    name: 'Complemento',
    type: 'text' as const,
    visible: true,
    depth: 0,
    bounds: { left: 150, top: 390, right: 1029, bottom: 450 },
  };

  const layers = lineAboveText ? [lineLayer, titleLayer, complementLayer] : [titleLayer, lineLayer, complementLayer];

  const templateParts: ImportedPricePart[] = [
    {
      role: 'title',
      layerId: '0',
      bounds: { left: 100, top: 220, right: 1079, bottom: 350 },
      fontSize: 110,
      fontFamily: 'BrushHandNew',
      originalText: 'BOLO',
      color: '#000000',
    },
    {
      role: 'complement',
      layerId: '2',
      bounds: { left: 150, top: 390, right: 1029, bottom: 450 },
      fontSize: 48,
      fontFamily: 'ArialMT',
      originalText: 'SABOR CHOCOLATE',
      color: '#292d5a',
    },
  ];

  const priceParts: ImportedPricePart[] = [
    {
      role: 'whole',
      layerId: '3',
      bounds: { left: 120, top: 600, right: 550, bottom: 1100 },
      fontSize: 450,
      originalText: '5',
      color: '#e97858',
    },
    {
      role: 'fraction',
      layerId: '4',
      bounds: { left: 630, top: 620, right: 950, bottom: 800 },
      fontSize: 180,
      originalText: '59',
      color: '#e97858',
    },
  ];

  return {
    kind: 'imported-psd',
    compatibility: 'ready',
    source: { fileName: 'mock-template.psd', sha256: 'a'.repeat(64), sourcePath: null },
    canvas: { width: 1179, height: 1770, resolutionPpi: 300, fit: 'contain' },
    staticBackground: pixel,
    originalPreview: pixel,
    priceParts,
    templateParts,
    layers,
    warnings: [],
  };
}

// Medidor simulador de fonte proporcional
const mockMeasure = (text: string, fontPx: number) => text.length * fontPx * 0.55;

test('1. Título curto: mantém escala 1.0 e tamanho de fonte original sem alteração indevida', () => {
  const artwork = createMockArtwork();
  const titlePart = artwork.templateParts!.find(p => p.role === 'title')!;
  const adj = computeTextLayoutAdjustment(titlePart, 'BOLO', mockMeasure, artwork);

  assert.equal(adj.lines.length, 1);
  assert.equal(adj.lines[0], 'BOLO');
  assert.equal(adj.fontSize, 110);
  assert.equal(adj.horizontalScale, 1);
  assert.equal(adj.appliedAdjustment, false);
  assert.equal(adj.hasCollisionWarning, false);
  // Garante que o texto termina antes da linha decorativa (top: 365)
  assert.ok(titlePart.bounds.top + adj.totalHeight < 365);
});

test('2. Título médio: aplica compressão horizontal moderada e permanece em linha única', () => {
  const artwork = createMockArtwork();
  const titlePart = artwork.templateParts!.find(p => p.role === 'title')!;
  // "MISTURA PARA BOLO" (17 chars) -> em font 110px: 17 * 110 * 0.55 = 1028.5px > safeWidth 979px
  const adj = computeTextLayoutAdjustment(titlePart, 'MISTURA PARA BOLO', mockMeasure, artwork);

  assert.equal(adj.lines.length, 1);
  assert.equal(adj.lines[0], 'MISTURA PARA BOLO');
  assert.equal(adj.fontSize, 110);
  assert.ok(adj.horizontalScale < 1);
  assert.ok(adj.horizontalScale >= MIN_TITLE_HORIZONTAL_SCALE);
  assert.equal(adj.appliedAdjustment, true);
  assert.equal(adj.hasCollisionWarning, false);
  assert.ok(titlePart.bounds.top + adj.totalHeight < 365);
});

test('3. Título longo (Zaeli 400g): quebra em 2 linhas equilibradas e reduz fonte sem ultrapassar a linha', () => {
  const artwork = createMockArtwork();
  const titlePart = artwork.templateParts!.find(p => p.role === 'title')!;
  const adj = computeTextLayoutAdjustment(titlePart, 'MISTURA PARA BOLO ZAELI 400G', mockMeasure, artwork);

  assert.equal(adj.lines.length, 2);
  assert.ok(adj.fontSize < 110, 'Deve reduzir fonte para caber na altura segura');
  assert.ok(adj.fontSize >= Math.round(110 * MIN_TITLE_FONT_SIZE_RATIO));
  // O limite inferior seguro calculado deve ser de 357 (365 - 8px de margem)
  assert.equal(adj.safeBottomLimit, 357);
  // A base do texto renderizado não deve invadir a linha decorativa (365px)
  assert.ok(titlePart.bounds.top + adj.totalHeight <= 365, 'Não deve colidir com a linha');
  assert.equal(adj.hasCollisionWarning, false);
});

test('4. Título extremamente longo (Nissin Cup Noodles 65g): adaptação com redução proporcional segura', () => {
  const artwork = createMockArtwork();
  const titlePart = artwork.templateParts!.find(p => p.role === 'title')!;
  const adj = computeTextLayoutAdjustment(titlePart, 'MACARRÃO INSTANTÂNEO NISSIN CUP NOODLES 65G', mockMeasure, artwork);

  assert.ok(adj.lines.length >= 2);
  assert.ok(adj.fontSize <= Math.round(110 * 0.75));
  assert.ok(titlePart.bounds.top + adj.totalHeight <= 365 + 10);
});

test('5. Texto com múltiplas linhas explícitas (\\n): respeita quebras forçadas e recalcula altura', () => {
  const artwork = createMockArtwork();
  const titlePart = artwork.templateParts!.find(p => p.role === 'title')!;
  const adj = computeTextLayoutAdjustment(titlePart, 'LINHA SUPERIOR\nLINHA INFERIOR', mockMeasure, artwork);

  assert.equal(adj.lines.length, 2);
  assert.equal(adj.lines[0], 'LINHA SUPERIOR');
  assert.equal(adj.lines[1], 'LINHA INFERIOR');
  assert.ok(titlePart.bounds.top + adj.totalHeight <= 365);
});

test('6. Variações de hierarquia PSD: linha posicionada acima ou abaixo das camadas na árvore', () => {
  // Linha acima do texto na ordem da árvore
  const artworkAbove = createMockArtwork(365, 373, true);
  const titlePartAbove = artworkAbove.templateParts!.find(p => p.role === 'title')!;
  const safeLimitAbove = computeSafeBottomLimit(titlePartAbove, artworkAbove);
  assert.equal(safeLimitAbove, 357);

  // Linha abaixo do texto na ordem da árvore
  const artworkBelow = createMockArtwork(365, 373, false);
  const titlePartBelow = artworkBelow.templateParts!.find(p => p.role === 'title')!;
  const safeLimitBelow = computeSafeBottomLimit(titlePartBelow, artworkBelow);
  assert.equal(safeLimitBelow, 357);
});

test('7. Fontes ausentes e substituições: tolerância de métricas com fonte de fallback', () => {
  const artwork = createMockArtwork();
  const titlePart = artwork.templateParts!.find(p => p.role === 'title')!;
  // Simulador de fonte Arial com largura média ligeiramente mais larga (0.62)
  const arialMeasure = (text: string, fontPx: number) => text.length * fontPx * 0.62;
  const adj = computeTextLayoutAdjustment(titlePart, 'MISTURA PARA BOLO ZAELI', arialMeasure, artwork);

  assert.ok(titlePart.bounds.top + adj.totalHeight <= 365);
});

test('8. Cartaz sem linha decorativa: calcula limite inferior natural sem travar', () => {
  const artwork = createMockArtwork();
  // Remove a linha decorativa
  artwork.layers = artwork.layers.filter(l => l.name !== 'Linha Decorativa');
  const titlePart = artwork.templateParts!.find(p => p.role === 'title')!;
  const safeLimit = computeSafeBottomLimit(titlePart, artwork);

  // Obstáculo mais próximo passa a ser o Complemento (top: 390) -> limite: 390 - 8 = 382
  assert.equal(safeLimit, 382);
  const adj = computeTextLayoutAdjustment(titlePart, 'MISTURA PARA BOLO', mockMeasure, artwork);
  assert.ok(adj.safeBottomLimit >= 380);
});

test('9. Exportação PSD direta e compatibilidade Photoshop CS6: redução de fontSize em títulos longos', async () => {
  // Monta PSD sintético
  const rawPsd = {
    width: 1179,
    height: 1770,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3,
    canvas: fakeCanvas(1179, 1770),
    children: [
      {
        name: 'Título',
        text: {
          text: 'BOLO',
          style: { fontSize: 110 },
        },
      },
      {
        name: 'Reais',
        text: {
          text: '5',
          style: { fontSize: 450 },
        },
      },
      {
        name: 'Centavos',
        text: {
          text: '59',
          style: { fontSize: 180 },
        },
      },
    ],
  };

  const buffer = writePsd(rawPsd as any);
  let writtenPsdBuffer: Uint8Array | null = null;

  const mockIo = {
    readSourcePsd: async () => buffer,
    writeOutputPsd: async (_outPath: string, _srcPath: string, bytes: Uint8Array) => {
      writtenPsdBuffer = bytes;
      return { fileSize: bytes.byteLength };
    },
  };

  const payload: DerivedPsdPayload = {
    sourcePsdPath: 'C:/fake/modelo.psd',
    outputPsdPath: 'C:/fake/saida.psd',
    title: 'MISTURA PARA BOLO ZAELI 400G', // 28 chars -> scaleFactor 0.75
    whole: '5',
    fraction: '59',
    roles: {
      titleLayerId: '0',
      wholeLayerId: '1',
      fractionLayerId: '2',
    },
  };

  const res = await exportDerivedPsdDirect(payload, mockIo);
  assert.equal(res.ok, true);
  assert.ok(writtenPsdBuffer);

  // Reabre o PSD gravado e inspeciona se o fontSize foi recalculado com sucesso
  const reloaded = readPsd(writtenPsdBuffer!.buffer as any);
  const reloadedTitle = reloaded.children![0];
  assert.equal(reloadedTitle.text!.text, 'MISTURA PARA BOLO ZAELI 400G');
  // 110 * 0.75 = 82.5 -> arredondado para 83
  assert.equal(reloadedTitle.text!.style!.fontSize, 83);

  // Preço e centavos permanecem intactos
  const reloadedWhole = reloaded.children![1];
  const reloadedFrac = reloaded.children![2];
  assert.equal(reloadedWhole.text!.text, '5');
  assert.equal(reloadedFrac.text!.text, '59');
});

test('10. Integridade estrita de dados: preços, centavos e códigos F7 nunca são alterados', () => {
  const artwork = createMockArtwork();
  const wholePart = artwork.priceParts.find(p => p.role === 'whole')!;
  const fractionPart = artwork.priceParts.find(p => p.role === 'fraction')!;

  assert.equal(wholePart.originalText, '5');
  assert.equal(fractionPart.originalText, '59');
  assert.equal(artwork.compatibility, 'ready');
});
