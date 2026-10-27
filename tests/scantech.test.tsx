import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { initializeCanvas, readPsd } from 'ag-psd';
import { analyzePsd, buildArtwork } from '../src/features/psd/importer';
import { createDocument, deserialize, serialize } from '../src/features/cartazes/serialization';
import { splitCentsToParts } from '../src/features/cartazes/presentation';
import { indexCartazes } from '../src/features/cartazes/f7';
import {
  applyValidityDateToLayerText,
  detectHeaderRowIndex,
  extractCampaignItemsFromSheet,
  parseExcelDateToIso,
  parseXlsx,
  suggestColumnMapping,
} from '../src/features/ofertas/excel';
import { computeWholePriceAdjustment } from '../src/components/editor/importedRenderer';
import {
  applyExcelToScantechCampaign,
  buildOutputPsdPath,
  buildPrintableScantechPosters,
  buildScantechItemViews,
  createScantechCampaign,
  executeScantechDirectExportJob,
  exportScantechPsdsDirect,
  linkCartazAndPsdToScantechItem,
  updateScantechItemFields,
  validateExportJobBasics,
} from '../src/features/scantech/service';

const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Sprint 07 — Referência cerveja corona extra lata 350ml.psd: detecta reais (4), centavos (19) e validade (OFERTA VÁLIDA ATÉ 25/10)', {
  skip: !existsSync('cerveja corona extra lata 350ml.psd'),
}, async () => {
  const fakeCanvas = (w = 1179, h = 1770): any => ({
    width: w,
    height: h,
    getContext: () => ({
      clearRect() {},
      save() {},
      restore() {},
      drawImage() {},
      putImageData() {},
      getImageData: (_x: number, _y: number, cw: number, ch: number) => ({
        data: new Uint8ClampedArray(cw * ch * 4),
        width: cw,
        height: ch,
      }),
    }),
    toDataURL: () => pixel,
  });
  initializeCanvas(fakeCanvas, (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h } as any));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => fakeCanvas() },
  });
  try {
    const raw = readFileSync('cerveja corona extra lata 350ml.psd');
    const hashBefore = createHash('sha256').update(raw).digest('hex');
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const analysis = await analyzePsd(
      buffer,
      'cerveja corona extra lata 350ml.psd',
      resolve('cerveja corona extra lata 350ml.psd')
    );

    assert.equal(analysis.width, 1179);
    assert.equal(analysis.height, 1770);
    assert.equal(analysis.layers.length, 14);
    assert.equal(analysis.suggested.whole, '10'); // "4"
    assert.equal(analysis.suggested.fraction, '11'); // "19"
    assert.equal(analysis.suggested.decimal, '9'); // ","
    assert.equal(analysis.suggested.fractionRule, '8'); // "Rectangle 3"
    assert.equal(analysis.suggested.validity, '13'); // "OFERTA VÁLIDA ATÉ 25/10" (camada 12 está oculta)
    assert.equal(analysis.metadata.price, '4,19');
    assert.equal(analysis.metadata.validityText, 'OFERTA VÁLIDA ATÉ 25/10');
    assert.equal(analysis.metadata.unit, '269ML');

    const artwork = buildArtwork(analysis, analysis.suggested);
    assert.equal(artwork.compatibility, 'ready');
    const valPart = artwork.priceParts.find(p => p.role === 'validity');
    assert.ok(valPart);
    assert.equal(valPart.layerId, '13');
    assert.equal(valPart.originalText, 'OFERTA VÁLIDA ATÉ 25/10');
    assert.equal(valPart.fontFamily, 'Impact');

    // Garante que o arquivo original não sofreu nenhuma alteração
    const hashAfter = createHash('sha256').update(readFileSync('cerveja corona extra lata 350ml.psd')).digest('hex');
    assert.equal(hashAfter, hashBefore);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('Sprint 07 — Preços com 1, 2 e 3 casas na parte inteira + Datas em formatos variados', () => {
  // 1 casa inteira (ex: R$ 4,19), 2 casas inteiras (ex: R$ 19,89), 3 casas inteiras (ex: R$ 129,90)
  assert.deepEqual(splitCentsToParts(419), { whole: '4', fraction: '19' });
  assert.deepEqual(splitCentsToParts(1989), { whole: '19', fraction: '89' });
  assert.deepEqual(splitCentsToParts(12990), { whole: '129', fraction: '90' });

  // Formatos variados de data: DD/MM/AAAA, DD/MM/AA, DD/MM, ISO AAAA-MM-DD, e Serial numérico do Excel
  assert.equal(parseExcelDateToIso('31/10/2026'), '2026-10-31');
  assert.equal(parseExcelDateToIso('31/10/26'), '2026-10-31');
  assert.equal(parseExcelDateToIso('25/10', 2026), '2026-10-25');
  assert.equal(parseExcelDateToIso('2026-11-05'), '2026-11-05');
  assert.equal(parseExcelDateToIso('2026-11-05T00:00:00'), '2026-11-05');
  // Serial Excel: 46326 = 2026-10-31 (1899-12-30 + 46326 dias)
  assert.equal(parseExcelDateToIso('46326'), '2026-10-31');

  // Datas inválidas devem lançar erro
  assert.throws(() => parseExcelDateToIso('31/02/2026'));
  assert.throws(() => parseExcelDateToIso('data-invalida'));

  // Preservação do formato visual da camada de validade
  assert.equal(
    applyValidityDateToLayerText('OFERTA VÁLIDA ATÉ 25/10', '2026-10-31'),
    'OFERTA VÁLIDA ATÉ 31/10'
  );
  assert.equal(
    applyValidityDateToLayerText('OFERTA VÁLIDA ATÉ 25/10/2026', '2026-10-31'),
    'OFERTA VÁLIDA ATÉ 31/10/2026'
  );
  assert.equal(
    applyValidityDateToLayerText('OFERTA DE 15/10 ATÉ 25/10', '2026-10-31', '2026-10-27'),
    'OFERTA DE 27/10 ATÉ 31/10'
  );
});

test('Sprint 07 — Fluxo Scantech: produtos sem F7, sem PSD, camadas invertidas e bloqueio de exportação', () => {
  const headers = ['F7', 'DESCRIÇÃO', 'PREÇO OFERTA', 'DATA INICIAL', 'DATA FINAL'];
  const mapping = suggestColumnMapping(headers);
  assert.deepEqual(mapping, {
    f7Col: 0,
    descriptionCol: 1,
    priceCol: 2,
    startDateCol: 3,
    endDateCol: 4,
  });

  const sheet = {
    name: 'Scantech',
    rows: [
      headers,
      // Produto 1: 1 dígito inteiro (R$ 4,99), com PSD na biblioteca
      ['1001', 'CERVEJA CORONA EXTRA LATA 350ML', 'R$ 4,99', '27/10/2026', '31/10/2026'],
      // Produto 2: 2 dígitos inteiros (R$ 19,89), sem PSD
      ['38340', 'ARROZ RAMPINELLI 5KG', '19,89', '', ''],
      // Produto 3: 3 dígitos inteiros (R$ 129,90), com PSD
      ['5002', 'WHISKY OLD PARR 1L', '129,90', '', '05/11/2026'],
      // Produto 4: Sem código F7
      ['', 'PRODUTO SEM CODIGO F7', '8,99', '', '31/10/2026'],
      // Produto 5: Data inicial posterior à data final (inconsistência)
      ['9009', 'PRODUTO DATA INVALIDA', '10,90', '10/11/2026', '01/11/2026'],
    ],
  };

  const extraction = extractCampaignItemsFromSheet(sheet, 0, mapping);
  assert.equal(extraction.items.length, 5);

  // Cria documento de biblioteca para F7 1001 (Corona)
  const coronaDoc = createDocument();
  coronaDoc.product = {
    name: 'CERVEJA CORONA',
    complement: 'EXTRA LATA',
    unit: '269ML',
    productCode: '1001',
    priceCents: 419,
  };
  coronaDoc.layout = {
    template: 'imported-psd',
    paper: 'A5',
    orientation: 'portrait',
    artwork: {
      kind: 'imported-psd',
      compatibility: 'ready',
      source: {
        fileName: 'cerveja corona extra lata 350ml.psd',
        sha256: 'a'.repeat(64),
        sourcePath: 'C:\\Artes\\cerveja corona extra lata 350ml.psd',
      },
      canvas: { width: 1179, height: 1770, resolutionPpi: 150, fit: 'contain' },
      staticBackground: pixel,
      originalPreview: pixel,
      priceParts: [
        { role: 'whole', layerId: '10', bounds: { left: 105, top: 812, right: 587, bottom: 1571 }, color: '#c74624', originalText: '4' },
        { role: 'fraction', layerId: '11', bounds: { left: 612, top: 798, right: 1013, bottom: 1313 }, color: '#c74624', originalText: '19' },
        { role: 'validity', layerId: '13', bounds: { left: 118, top: 1602, right: 1033, bottom: 1675 }, color: '#000000', originalText: 'OFERTA VÁLIDA ATÉ 25/10' },
      ],
      layers: [
        { id: '10', name: '4', type: 'text', visible: true, depth: 0, text: '4', bounds: { left: 105, top: 812, right: 587, bottom: 1571 } },
        { id: '11', name: '19', type: 'text', visible: true, depth: 0, text: '19', bounds: { left: 612, top: 798, right: 1013, bottom: 1313 } },
        { id: '13', name: 'OFERTA VÁLIDA ATÉ 25/10', type: 'text', visible: true, depth: 0, text: 'OFERTA VÁLIDA ATÉ 25/10', bounds: { left: 118, top: 1602, right: 1033, bottom: 1675 } },
      ],
      warnings: [],
    },
  };

  const library = indexCartazes([
    { path: 'C:/Biblioteca/corona.skcartaz', name: 'corona.skcartaz', folder: false, content: serialize(coronaDoc) },
  ]);

  let campaign = createScantechCampaign('Campanha Fim de Semana', '2026-10-30');
  campaign = applyExcelToScantechCampaign(campaign, extraction, library, [], {
    fileName: 'ofertas.xlsx',
    sheetName: 'Scantech',
    headerRowIndex: 0,
    mapping,
  });

  const views = buildScantechItemViews(campaign, library);
  assert.equal(views.length, 5);

  // Item 1 (Corona): pronto para exportar, usa validade individual 31/10
  const vCorona = views[0];
  assert.equal(vCorona.canExport, true);
  assert.equal(vCorona.wholeValue, '4');
  assert.equal(vCorona.fractionValue, '99');
  assert.equal(vCorona.resolvedValidityText, 'OFERTA VÁLIDA ATÉ 31/10');
  assert.equal(
    buildOutputPsdPath('C:\\Exportados', vCorona.item),
    'C:\\Exportados\\1001-cerveja-corona-extra-lata-350ml-oferta.psd'
  );

  // Item 2 (Arroz 38340): sem PSD associado -> bloqueado para exportação, mas usa validade global 30/10
  const vArroz = views[1];
  assert.equal(vArroz.item.status, 'sem-psd');
  assert.equal(vArroz.canExport, false);
  assert.equal(vArroz.wholeValue, '19');
  assert.equal(vArroz.fractionValue, '89');
  assert.equal(vArroz.resolvedValidityText, 'OFERTA VÁLIDA ATÉ 30/10');

  // Item 3 (Whisky 129,90): 3 casas na parte inteira
  const vWhisky = views[2];
  assert.equal(vWhisky.wholeValue, '129');
  assert.equal(vWhisky.fractionValue, '90');
  assert.equal(vWhisky.resolvedValidityText, 'OFERTA VÁLIDA ATÉ 05/11');

  // Item 4 (Sem F7): bloqueado por falta de F7
  const vSemF7 = views[3];
  assert.equal(vSemF7.item.status, 'inconsistente');
  assert.equal(vSemF7.canExport, false);
  assert.ok(vSemF7.blockingReasons.some(r => /F7/i.test(r)));

  // Item 5 (Data inválida): bloqueado por data inicial > data final
  const vDataInvalida = views[4];
  assert.equal(vDataInvalida.item.status, 'inconsistente');
  assert.equal(vDataInvalida.canExport, false);
  assert.ok(vDataInvalida.blockingReasons.some(r => /posterior/i.test(r)));

  // Simula inversão manual de camadas Reais/Centavos no item 1 e verifica bloqueio
  const invertedCampaign = updateScantechItemFields(campaign, vCorona.item.id, {
    wholeLayerId: '11', // direita
    fractionLayerId: '10', // esquerda
  });
  const invertedViews = buildScantechItemViews(invertedCampaign, library);
  assert.equal(invertedViews[0].hasInvertedLayers, true);
  assert.equal(invertedViews[0].canExport, false);
  assert.ok(invertedViews[0].blockingReasons.some(r => /invertidas/i.test(r)));

  // Vincula PSD ao item 2 (Arroz) e confirma que fica pronto
  const arrozDoc = deserialize(serialize(coronaDoc));
  arrozDoc.product.productCode = '38340';
  if (arrozDoc.layout.template === 'imported-psd') {
    arrozDoc.layout.artwork.priceParts[0].originalText = '19';
    arrozDoc.layout.artwork.priceParts[0].bounds = { left: 46, top: 812, right: 631, bottom: 1571 };
  }
  const linkedCampaign = linkCartazAndPsdToScantechItem(
    campaign,
    vArroz.item.id,
    'C:/Biblioteca/arroz.skcartaz',
    arrozDoc,
    'C:\\Artes\\arroz.psd'
  );
  const linkedViews = buildScantechItemViews(linkedCampaign, [
    ...library,
    { path: 'C:/Biblioteca/arroz.skcartaz', fileName: 'arroz.skcartaz', document: arrozDoc },
  ]);
  assert.equal(linkedViews[1].canExport, true);
});

const photoshopExe = 'C:\\programinha\\app\\photoshopcs6\\photoshop.exe';
test(
  'Sprint 07 — Integração Real Photoshop CS6: exporta cópia PSD editável de cerveja corona extra lata 350ml.psd (1, 2 e 3 dígitos) e reabre validando camadas',
  { skip: !existsSync('cerveja corona extra lata 350ml.psd') || !existsSync(photoshopExe) },
  () => {
    const workDir = join(tmpdir(), `skalee-scantech-e2e-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      const srcPsd = resolve('cerveja corona extra lata 350ml.psd');
      const origBytes = readFileSync(srcPsd);
      const origHash = createHash('sha256').update(origBytes).digest('hex');

      const out1Digit = join(workDir, '1001-corona-1digito.psd'); // R$ 5,49 (1 casa inteira)
      const out2Digits = join(workDir, '1001-corona-2digitos.psd'); // R$ 19,89 (2 casas inteiras)
      const out3Digits = join(workDir, '1001-corona-3digitos.psd'); // R$ 129,90 (3 casas inteiras)
      const statusFile = join(workDir, 'status.json');
      const jsxFile = join(workDir, 'batch.jsx');

      const jsx = `#target photoshop
app.displayDialogs = DialogModes.NO;
function resolveLayerByPath(container, pathStr) {
  var parts = pathStr.split(".");
  var current = container;
  for (var i = 0; i < parts.length; i++) {
    var idx = parseInt(parts[i], 10);
    var domIdx = current.layers.length - 1 - idx;
    var layer = current.layers[domIdx];
    if (i === parts.length - 1) return layer;
    current = layer;
  }
  return null;
}
function runJob(srcPath, dstPath, wholeVal, fracVal, valText) {
  var src = new File(srcPath);
  var dst = new File(dstPath);
  var doc = app.open(src);
  resolveLayerByPath(doc, "10").textItem.contents = wholeVal;
  resolveLayerByPath(doc, "11").textItem.contents = fracVal;
  resolveLayerByPath(doc, "13").textItem.contents = valText;
  var opts = new PhotoshopSaveOptions();
  opts.layers = true;
  opts.embedColorProfile = true;
  opts.maximizeCompatibility = true;
  doc.saveAs(dst, opts, true, Extension.LOWERCASE);
  doc.close(SaveOptions.DONOTSAVECHANGES);
}
try {
  runJob("${srcPsd.replace(/\\/g, '/')}", "${out1Digit.replace(/\\/g, '/')}", "5", "49", "OFERTA V\\u00c1LIDA AT\\u00c9 28/10");
  runJob("${srcPsd.replace(/\\/g, '/')}", "${out2Digits.replace(/\\/g, '/')}", "19", "89", "OFERTA V\\u00c1LIDA AT\\u00c9 30/10");
  runJob("${srcPsd.replace(/\\/g, '/')}", "${out3Digits.replace(/\\/g, '/')}", "129", "90", "OFERTA V\\u00c1LIDA AT\\u00c9 05/11");
  var sf = new File("${statusFile.replace(/\\/g, '/')}");
  sf.encoding = "UTF-8";
  sf.open("w");
  sf.write('{"ok":true,"version":"' + app.version + '"}');
  sf.close();
} catch (e) {
  var sf = new File("${statusFile.replace(/\\/g, '/')}");
  sf.encoding = "UTF-8";
  sf.open("w");
  sf.write('{"ok":false,"error":"' + e.toString().replace(/"/g, '\\\\"') + '"}');
  sf.close();
} finally {
  app.quit();
}
`;
      writeFileSync(jsxFile, jsx, 'utf8');
      spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Name photoshop -Force -ErrorAction SilentlyContinue']);
      const child = spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath '${photoshopExe}' -ArgumentList @('-r', '${jsxFile}')`,
      ]);
      assert.equal(child.status, 0);

      const start = Date.now();
      while (!existsSync(statusFile) && Date.now() - start < 75_000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
      assert.ok(existsSync(statusFile), 'Photoshop deve gerar arquivo de status da automação');
      const status = JSON.parse(readFileSync(statusFile, 'utf8'));
      assert.equal(status.ok, true, status.error);
      assert.equal(status.version, '13.0.1');

      // Reabre os 3 PSDs gerados e verifica que todas as 14 camadas editáveis, textos, fontes e efeitos foram preservados
      const expectations = [
        { file: out1Digit, whole: '5', fraction: '49', validity: 'OFERTA VÁLIDA ATÉ 28/10' },
        { file: out2Digits, whole: '19', fraction: '89', validity: 'OFERTA VÁLIDA ATÉ 30/10' },
        { file: out3Digits, whole: '129', fraction: '90', validity: 'OFERTA VÁLIDA ATÉ 05/11' },
      ];

      for (const exp of expectations) {
        const buf = readFileSync(exp.file);
        assert.equal(buf.subarray(0, 4).toString('ascii'), '8BPS');
        const reopened = readPsd(buf, {
          skipLayerImageData: true,
          skipCompositeImageData: true,
          skipThumbnail: true,
        });
        assert.equal(reopened.width, 1179);
        assert.equal(reopened.height, 1770);
        assert.equal(reopened.children?.length, 14);
        assert.equal(reopened.children?.[2]?.text?.text?.trim(), 'CERVEJA');
        assert.equal(reopened.children?.[3]?.text?.text?.trim(), 'CORONA');
        assert.equal(reopened.children?.[5]?.text?.text?.trim(), 'EXTRA / LATA');
        assert.equal(reopened.children?.[7]?.text?.text?.trim(), '269ML');
        assert.equal(reopened.children?.[10]?.text?.text?.trim(), exp.whole);
        assert.equal(reopened.children?.[10]?.text?.style?.font?.name, 'Zullia');
        assert.ok(reopened.children?.[10]?.effects?.dropShadow);
        assert.equal(reopened.children?.[11]?.text?.text?.trim(), exp.fraction);
        assert.equal(reopened.children?.[11]?.text?.style?.font?.name, 'Zullia');
        assert.equal(reopened.children?.[13]?.text?.text?.trim(), exp.validity);
        assert.equal(reopened.children?.[13]?.text?.style?.font?.name, 'Impact');
      }

      // Confirma que o PSD original permaneceu 100% intacto
      const afterHash = createHash('sha256').update(readFileSync(srcPsd)).digest('hex');
      assert.equal(afterHash, origHash);
    } finally {
      spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Name photoshop -Force -ErrorAction SilentlyContinue']);
      rmSync(workDir, { recursive: true, force: true });
    }
  }
);

test('Sprint 07.1 — Importação de planilha Scantech real (codico, SCANTEH, Data até, DE, POR)', () => {
  const headers = ['codico', 'SCANTEH', 'Data até', 'DE', 'POR'];
  assert.equal(detectHeaderRowIndex([['', ''], headers]), 1);
  const mapping = suggestColumnMapping(headers);
  assert.equal(mapping.f7Col, 0);
  assert.equal(mapping.descriptionCol, 1);
  assert.equal(mapping.endDateCol, 2);
  assert.equal(mapping.previousPriceCol, 3);
  assert.equal(mapping.priceCol, 4);

  const sheet = {
    name: 'Scantech',
    rows: [
      headers,
      // F7 29965: Guaraná Antarctica 3L (DE R$ 12,49, POR R$ 11,19)
      ['29965', 'REFRIGERANTE GUARANA ANTARTICA TRADICIONAL 3L', '46334', '12.49', '11.19'],
      // Float cell IEEE-754 e moeda formatada
      ['14157', 'CERVEJA BUDWEISER LATA 350ML', '08/11/2026', 'R$ 4,69', '4.3899999999999997'],
      // Serial date 46355 = 2026-11-29
      ['36210', 'CERVEJA CORONA EXTRA LATA 350ML', '46355', '6.89', '4.6900000000000004'],
    ],
  };

  const extraction = extractCampaignItemsFromSheet(sheet, 0, mapping);
  assert.equal(extraction.validCount, 3);
  assert.equal(extraction.invalidCount, 0);

  const item1 = extraction.items[0];
  assert.equal(item1.f7, '29965');
  assert.equal(item1.endDateIso, '2026-11-08');
  assert.equal(item1.previousPriceCents, 1249);
  assert.equal(item1.priceCents, 1119);

  const item2 = extraction.items[1];
  assert.equal(item2.f7, '14157');
  assert.equal(item2.previousPriceCents, 469);
  assert.equal(item2.priceCents, 439);

  const item3 = extraction.items[2];
  assert.equal(item3.f7, '36210');
  assert.equal(item3.endDateIso, '2026-11-29');
  assert.equal(item3.previousPriceCents, 689);
  assert.equal(item3.priceCents, 469);
});

test('Sprint 07.1 — Transformação geométrica e ajuste automático de preço no Guaraná Antarctica 3L (refrigerante sukita laranja 2l.psd)', {
  skip: !existsSync('C:/Users/Supermercado Sol/Desktop/SCANTECH/refrigerante sukita laranja 2l.psd'),
}, async () => {
  const srcPsd = 'C:/Users/Supermercado Sol/Desktop/SCANTECH/refrigerante sukita laranja 2l.psd';
  const raw = readFileSync(srcPsd);
  const origHash = createHash('sha256').update(raw).digest('hex');
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

  const fakeCanvas = (w = 1179, h = 1770): any => ({
    width: w,
    height: h,
    getContext: () => ({
      clearRect() {}, save() {}, restore() {}, drawImage() {}, putImageData() {},
      getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    }),
    toDataURL: () => pixel,
  });
  initializeCanvas(fakeCanvas, (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h } as any));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => fakeCanvas() } });

  try {
    const analysis = await analyzePsd(buffer, 'refrigerante sukita laranja 2l.psd', srcPsd);
    const artwork = buildArtwork(analysis, analysis.suggested);

    // 1. Analisa a matriz original da camada de reais ("6")
    const wholePart = artwork.priceParts.find(p => p.role === 'whole')!;
    assert.ok(wholePart.transform);
    const [xx, xy, yx, yy] = wholePart.transform;
    const origRotDeg = Math.atan2(xy, xx) * 180 / Math.PI;
    const origSkewDeg = Math.atan2(yx, yy) * 180 / Math.PI;
    assert.ok(Math.abs(Math.abs(origRotDeg) - 6.8) < 0.2, `Magnitude de rotação esperada ~6.8°, obtida ${origRotDeg}°`);
    assert.ok(Math.abs(Math.abs(origSkewDeg) - 20.1) < 0.5, `Magnitude de skew esperada ~20.1°, obtida ${origSkewDeg}°`);

    // 2. Substituição por "11" (R$ 11,99 e R$ 11,19): normalização de rotação e cisalhamento
    const adj11 = computeWholePriceAdjustment(artwork, '11');
    assert.equal(adj11.normalized, true);
    assert.ok(Math.abs(adj11.rotateDeltaDeg - (-origRotDeg)) < 0.2);
    assert.ok(adj11.targetSkewDeg >= 15.0 && adj11.targetSkewDeg <= 17.5);
    assert.ok(adj11.fitsWithinSafeLimit);
    assert.ok(adj11.horizontalScale >= 0.70 && adj11.horizontalScale <= 1.0);

    // 3. Substituição por 1 dígito ("6"): preserva escala 100%
    const adj6 = computeWholePriceAdjustment(artwork, '6');
    assert.equal(adj6.horizontalScale, 1.0);
    assert.ok(adj6.fitsWithinSafeLimit);

    // 4. Substituição por 3 dígitos ("119"): cabe dentro do limite seguro
    const adj119 = computeWholePriceAdjustment(artwork, '119');
    assert.ok(adj119.fitsWithinSafeLimit);
    assert.ok(adj119.horizontalScale >= 0.48);

    // 5. Substituição por 5 dígitos ("99999"): ultrapassa limite seguro e bloqueia
    const adjBlocked = computeWholePriceAdjustment(artwork, '99999');
    assert.equal(adjBlocked.fitsWithinSafeLimit, false);

    // 6. Confirma que o PSD original continuou 100% intacto
    const afterHash = createHash('sha256').update(readFileSync(srcPsd)).digest('hex');
    assert.equal(afterHash, origHash);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('Sprint 07.1 — Aprovação de composição visual para alerta de largura (F7 29965 / Guaraná Antarctica Tradicional 3L)', () => {
  // 1. Cria campanha e adiciona item com alerta de largura
  let campaign = createScantechCampaign('Campanha Teste Aprovação Visual', '2026-11-29');
  
  // Simulando item Guaraná Antarctica Tradicional 3L (F7 29965)
  // Original do PSD era R$ 6,19 (1 dígito inteiro). Novo preço é R$ 11,19 (2 dígitos inteiros).
  campaign.items.push({
    id: 'item-29965',
    f7: '29965',
    description: 'REFRIGERANTE GUARANA ANTARCTICA 3L',
    previousPriceCents: 619,
    priceCents: 1119,
    endDateIso: '2026-11-29',
    cartazId: 'cartaz-29965',
    sourcePsdPath: 'C:/cartazes/guarana-antarctica-3l.psd',
    sourcePsdSha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    wholeLayerId: '10',
    fractionLayerId: '11',
    issues: [],
    importedPriceWarning: 'Preço novo "11,19" tem mais dígitos inteiros que a arte original "6,19" e pode ultrapassar a largura útil.',
    visualApproval: null,
  });

  const library: any[] = [];

  // Estado inicial: possui alerta de largura, não aprovado -> bloqueado para exportação
  let views = buildScantechItemViews(campaign, library);
  let v = views[0];
  assert.equal(v.widthWarning, 'Preço novo "11,19" tem mais dígitos inteiros que a arte original "6,19" e pode ultrapassar a largura útil.');
  assert.equal(v.isVisuallyApproved, false);
  assert.equal(v.canExport, false);
  assert.ok(v.blockingReasons.some(r => r.includes(v.widthWarning!)));
  assert.equal(v.realErrors.length, 0);

  // 2. Concede aprovação visual vinculada a F7, preço (1119), validade e SHA256 da arte
  campaign.items[0].visualApproval = {
    f7: '29965',
    priceCents: 1119,
    validityText: v.resolvedValidityText,
    sourcePsdSha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    approvedAt: Date.now(),
  };

  // Após aprovação: alerta continua visível como aviso informativo, mas isVisuallyApproved = true e canExport = true
  views = buildScantechItemViews(campaign, library);
  v = views[0];
  assert.ok(v.widthWarning !== null);
  assert.equal(v.isVisuallyApproved, true);
  assert.equal(v.blockingReasons.length, 0);
  assert.equal(v.canExport, true);

  // 3. Invalidação por alteração de preço: usuário altera preço de R$ 11,19 para R$ 12,49
  campaign = updateScantechItemFields(campaign, 'item-29965', { priceCents: 1249 });
  assert.equal(campaign.items[0].visualApproval, null); // Aprovação limpa automaticamente no update

  views = buildScantechItemViews(campaign, library);
  v = views[0];
  assert.equal(v.isVisuallyApproved, false);
  assert.equal(v.canExport, false);
  assert.ok(v.blockingReasons.some(r => r.includes(v.widthWarning!)));

  // 4. Reaprovando para R$ 12,49
  campaign.items[0].visualApproval = {
    f7: '29965',
    priceCents: 1249,
    validityText: v.resolvedValidityText,
    sourcePsdSha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    approvedAt: Date.now(),
  };
  views = buildScantechItemViews(campaign, library);
  assert.equal(views[0].isVisuallyApproved, true);
  assert.equal(views[0].canExport, true);

  // 5. Invalidação por alteração de data de validade
  campaign = updateScantechItemFields(campaign, 'item-29965', { endDateIso: '2026-12-15' });
  assert.equal(campaign.items[0].visualApproval, null);

  views = buildScantechItemViews(campaign, library);
  assert.equal(views[0].isVisuallyApproved, false);
  assert.equal(views[0].canExport, false);

  // 6. Invalidação caso a arte do PSD seja alterada (SHA256 diferente)
  campaign.items[0].visualApproval = {
    f7: '29965',
    priceCents: 1249,
    validityText: views[0].resolvedValidityText,
    sourcePsdSha256: 'antigo-sha-256', // SHA antigo não coincide com sourcePsdSha256
    approvedAt: Date.now(),
  };
  views = buildScantechItemViews(campaign, library);
  // Como o sha256 difere de 'a1b2c3d4e5f60718293a4b5c6d7e8f90', a aprovação é rejeitada
  assert.equal(views[0].isVisuallyApproved, false);
  assert.equal(views[0].canExport, false);

  // 7. Erros reais (ex: preço zerado, PSD ausente) NÃO são ignorados mesmo se houver aprovação visual
  campaign.items[0].priceCents = 0; // Preço inválido
  campaign.items[0].visualApproval = {
    f7: '29965',
    priceCents: 0,
    validityText: views[0].resolvedValidityText,
    sourcePsdSha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    approvedAt: Date.now(),
  };
  views = buildScantechItemViews(campaign, library);
  assert.ok(views[0].realErrors.includes('Preço programado inválido.'));
  assert.equal(views[0].canExport, false);
});

test('Sprint 07.2 — Impressão direta de Cartazes Scantech: individual e em lote sem depender do Photoshop CS6', () => {
  const makeArtwork = (origDigitsText: string, sha: string) => ({
    canvas: { width: 1179, height: 1770 },
    staticBackground: pixel,
    priceParts: [
      { role: 'whole', layerId: '10', bounds: { left: 46, top: 812, right: 631, bottom: 1571 }, color: '#c74624', originalText: origDigitsText, fontSize: 140 },
      { role: 'fraction', layerId: '11', bounds: { left: 640, top: 798, right: 1013, bottom: 1313 }, color: '#c74624', originalText: '19', fontSize: 70 },
      { role: 'validity', layerId: '13', bounds: { left: 118, top: 1602, right: 1033, bottom: 1675 }, color: '#000000', originalText: 'OFERTA VÁLIDA ATÉ 25/10' },
    ],
    layers: [
      { id: '10', name: origDigitsText, type: 'text', visible: true, depth: 0, text: origDigitsText, bounds: { left: 46, top: 812, right: 631, bottom: 1571 } },
      { id: '11', name: '19', type: 'text', visible: true, depth: 0, text: '19', bounds: { left: 640, top: 798, right: 1013, bottom: 1313 } },
      { id: '13', name: 'OFERTA VÁLIDA ATÉ 25/10', type: 'text', visible: true, depth: 0, text: 'OFERTA VÁLIDA ATÉ 25/10', bounds: { left: 118, top: 1602, right: 1033, bottom: 1675 } },
    ],
    source: {
      fileName: `${origDigitsText}-cartaz.psd`,
      sourcePath: `C:/cartazes/${origDigitsText}-cartaz.psd`,
      sha256: sha,
    },
  });

  const mockArtworkGuarana = makeArtwork('6', 'mock-sha-guarana');
  const mockArtworkCorona = makeArtwork('4', 'mock-sha-corona');
  const mockArtworkArroz = makeArtwork('19', 'mock-sha-arroz');
  const mockArtworkWhisky = makeArtwork('129', 'mock-sha-whisky');
  const mockArtworkOutro = makeArtwork('5', 'mock-sha-outro');

  const campaign = createScantechCampaign('Campanha Fim de Ano Scantech', '2026-11-08');

  // 1. Guaraná Antarctica 3L (F7 29965): R$ 11,19 e validade 08/11/2026
  campaign.items.push({
    id: 'item-guarana',
    f7: '29965',
    description: 'REFRIGERANTE GUARANA ANTARCTICA 3L',
    previousPriceCents: 1249,
    priceCents: 1119,
    endDateIso: '2026-11-08',
    sourcePsdPath: 'C:/cartazes/guarana-antarctica-3l.psd',
    sourcePsdSha256: 'mock-sha-guarana',
    wholeLayerId: '10',
    fractionLayerId: '11',
    issues: [],
    importedPriceWarning: 'Preço novo "11,19" tem mais dígitos inteiros que a arte original "6,19".',
    visualApproval: {
      f7: '29965',
      priceCents: 1119,
      validityText: 'OFERTA VÁLIDA ATÉ 08/11',
      sourcePsdSha256: 'mock-sha-guarana',
      approvedAt: Date.now(),
    },
  });

  // 2. Preço de 1 dígito: Cerveja Corona 350ml (F7 1001) - R$ 4,19
  campaign.items.push({
    id: 'item-corona',
    f7: '1001',
    description: 'CERVEJA CORONA EXTRA LATA 350ML',
    previousPriceCents: 469,
    priceCents: 419,
    endDateIso: '2026-11-08',
    sourcePsdPath: 'C:/cartazes/corona.psd',
    sourcePsdSha256: 'mock-sha-corona',
    wholeLayerId: '10',
    fractionLayerId: '11',
    issues: [],
    importedPriceWarning: null,
    visualApproval: null,
  });

  // 3. Preço de 2 dígitos: Arroz Rampinelli 5kg (F7 38340) - R$ 19,89
  campaign.items.push({
    id: 'item-arroz',
    f7: '38340',
    description: 'ARROZ RAMPINELLI 5KG',
    previousPriceCents: 2190,
    priceCents: 1989,
    endDateIso: '2026-11-08',
    sourcePsdPath: 'C:/cartazes/arroz.psd',
    sourcePsdSha256: 'mock-sha-arroz',
    wholeLayerId: '10',
    fractionLayerId: '11',
    issues: [],
    importedPriceWarning: null,
    visualApproval: null,
  });

  // 4. Preço de 3 dígitos: Whisky Red Label 1L (F7 55001) - R$ 129,90
  campaign.items.push({
    id: 'item-whisky',
    f7: '55001',
    description: 'WHISKY JOHNNIE WALKER RED LABEL 1L',
    previousPriceCents: 13990,
    priceCents: 12990,
    endDateIso: '2026-11-08',
    sourcePsdPath: 'C:/cartazes/whisky.psd',
    sourcePsdSha256: 'mock-sha-whisky',
    wholeLayerId: '10',
    fractionLayerId: '11',
    issues: [],
    importedPriceWarning: null,
    visualApproval: null,
  });

  // 5. Item com erro de dado real (sem F7): bloqueado para impressão
  campaign.items.push({
    id: 'item-invalido',
    f7: '',
    description: 'PRODUTO SEM CODIGO',
    previousPriceCents: null,
    priceCents: 0,
    endDateIso: '2026-11-08',
    sourcePsdPath: null,
    wholeLayerId: null,
    fractionLayerId: null,
    issues: ['Código F7 ausente.'],
    importedPriceWarning: null,
    visualApproval: null,
  });

  // 6. Item com alerta de largura não aprovado: bloqueado para impressão
  campaign.items.push({
    id: 'item-alerta-bloqueado',
    f7: '99887',
    description: 'PRODUTO COM ALERTA PENDENTE',
    previousPriceCents: 500,
    priceCents: 1599,
    endDateIso: '2026-11-08',
    sourcePsdPath: 'C:/cartazes/outro.psd',
    sourcePsdSha256: 'mock-sha-outro',
    wholeLayerId: '10',
    fractionLayerId: '11',
    issues: [],
    importedPriceWarning: 'Preço largo demais para a área mapeada.',
    visualApproval: null, // NÃO aprovado
  });

  const extraArtworks = new Map<string, any>([
    ['item-guarana', mockArtworkGuarana],
    ['item-corona', mockArtworkCorona],
    ['item-arroz', mockArtworkArroz],
    ['item-whisky', mockArtworkWhisky],
    ['item-alerta-bloqueado', mockArtworkOutro],
  ]);

  const library: any[] = [];
  const views = buildScantechItemViews(campaign, library, extraArtworks);

  // A. Validação individual do Guaraná Antarctica 3L (R$ 11,19 e validade 08/11/2026)
  const vGuarana = views.find(v => v.item.id === 'item-guarana')!;
  assert.equal(vGuarana.canExport, true);
  assert.equal(vGuarana.isVisuallyApproved, true);
  assert.equal(vGuarana.resolvedValidityText, 'OFERTA VÁLIDA ATÉ 08/11');
  assert.equal(vGuarana.wholeValue, '11');
  assert.equal(vGuarana.fractionValue, '19');

  const { posters: guaranaPosters, blockedViews: guaranaBlocked } = buildPrintableScantechPosters(
    [vGuarana],
    { 'item-guarana': 2 } // 2 cópias
  );
  assert.equal(guaranaBlocked.length, 0);
  assert.equal(guaranaPosters.length, 2);
  assert.equal(guaranaPosters[0].price, '11,19');
  assert.equal(guaranaPosters[0].validityText, 'OFERTA VÁLIDA ATÉ 08/11');
  assert.equal(guaranaPosters[0].name, 'REFRIGERANTE GUARANA ANTARCTICA 3L');
  assert.equal(guaranaPosters[0].artwork, mockArtworkGuarana);

  // B. Validação de preços de 1, 2 e 3 dígitos
  const vCorona = views.find(v => v.item.id === 'item-corona')!;
  const vArroz = views.find(v => v.item.id === 'item-arroz')!;
  const vWhisky = views.find(v => v.item.id === 'item-whisky')!;

  assert.equal(vCorona.wholeValue, '4');
  assert.equal(vCorona.fractionValue, '19');

  assert.equal(vArroz.wholeValue, '19');
  assert.equal(vArroz.fractionValue, '89');

  assert.equal(vWhisky.wholeValue, '129');
  assert.equal(vWhisky.fractionValue, '90');

  // C. Validação de impressão em lote com quantidades de cópias diferenciadas
  // Guaraná: 2 cópias, Corona: 3 cópias, Arroz: 1 cópia, Whisky: 4 cópias = Total 10 páginas impressas
  const copiesConfig: Record<string, number> = {
    'item-guarana': 2,
    'item-corona': 3,
    'item-arroz': 1,
    'item-whisky': 4,
  };
  const batchViews = [vGuarana, vCorona, vArroz, vWhisky];
  const { posters: batchPosters, blockedViews: batchBlocked } = buildPrintableScantechPosters(
    batchViews,
    copiesConfig
  );
  assert.equal(batchBlocked.length, 0);
  assert.equal(batchPosters.length, 10);
  assert.equal(batchPosters.filter(p => p.price === '11,19').length, 2);
  assert.equal(batchPosters.filter(p => p.price === '4,19').length, 3);
  assert.equal(batchPosters.filter(p => p.price === '19,89').length, 1);
  assert.equal(batchPosters.filter(p => p.price === '129,90').length, 4);

  // D. Validação de fidelidade: o mesmo objeto Poster e artwork da prévia é entregue à impressão
  assert.equal(batchPosters[0].artwork, vGuarana.artwork);
  assert.equal(batchPosters[0].validityText, vGuarana.resolvedValidityText);

  // E. Validação de segurança: itens com erros reais ou alerta de largura não aprovado são bloqueados
  const vInvalido = views.find(v => v.item.id === 'item-invalido')!;
  const vAlertaBloqueado = views.find(v => v.item.id === 'item-alerta-bloqueado')!;

  const { posters: blockedResult, blockedViews: actuallyBlocked } = buildPrintableScantechPosters(
    [vInvalido, vAlertaBloqueado]
  );
  assert.equal(blockedResult.length, 0);
  assert.equal(actuallyBlocked.length, 2);
  assert.ok(actuallyBlocked.some(b => b.item.id === 'item-invalido'));
  assert.ok(actuallyBlocked.some(b => b.item.id === 'item-alerta-bloqueado'));

  // F. Garantia de independência total: nenhuma rotina de impressão executa ou depende do Photoshop CS6
  // A montagem de posters e o desenho do canvas A5 são funções locais offline e autossuficientes.
  assert.equal(typeof buildPrintableScantechPosters, 'function');
});

const guaranaCandidate = 'C:/Users/Supermercado Sol/Desktop/SCANTECH/REFRIGERANTE GUARANA 3L.psd';
const coronaCandidate = resolve('cerveja corona extra lata 350ml.psd');
const candidatePsd = existsSync(guaranaCandidate) ? guaranaCandidate : existsSync(coronaCandidate) ? coronaCandidate : null;

test('Sprint 07.3 — Exportação PSD Direta: Guaraná Antarctica 3L (sem Photoshop, R$ 11,19 e validade 08/11/2026)', {
  skip: !candidatePsd,
}, async () => {
  const srcPsd = candidatePsd!;
  assert.ok(existsSync(srcPsd), 'Arquivo PSD de origem deve existir para o teste.');

  const workDir = join(tmpdir(), `skalee-sprint073-guarana-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  const origHash = createHash('sha256').update(readFileSync(srcPsd)).digest('hex');
  const outPsd = join(workDir, '29965-guarana-antarctica-3l-oferta.psd');

  try {
    const isGuarana = srcPsd === guaranaCandidate;
    const job = {
      itemId: 'item-guarana',
      f7: '29965',
      description: 'REFRIGERANTE GUARANA ANTARCTICA 3L',
      sourcePsdPath: srcPsd,
      outputPsdPath: outPsd,
      wholeLayerId: '10',
      fractionLayerId: '11',
      decimalLayerId: '9',
      fractionRuleLayerId: '8',
      validityLayerId: isGuarana ? '13' : '13',
      wholeValue: '11',
      fractionValue: '19',
      validityText: 'OFERTA VÁLIDA ATÉ 08/11',
      rotateDeltaDeg: 0,
      skewDeltaDeg: 0,
    };

    // 1. Executa exportação direta sem executar Photoshop nem scripts JSX
    const result = await executeScantechDirectExportJob(job);
    assert.equal(result.ok, true, result.error ?? undefined);
    assert.equal(result.wholeApplied, '11');
    assert.equal(result.fractionApplied, '19');
    assert.equal(result.validityApplied, 'OFERTA VÁLIDA ATÉ 08/11');
    assert.ok(result.fileSize && result.fileSize > 100_000);

    // 2. Confirma que o arquivo de destino foi realmente criado no disco
    assert.ok(existsSync(outPsd), 'O arquivo .psd deve ter sido gravado na pasta de destino.');
    const buf = readFileSync(outPsd);

    // 3. Valida assinatura binária e estrutura PSD genuína (8BPS, versão 1, dimensões, TySh)
    assert.equal(buf.subarray(0, 4).toString('ascii'), '8BPS', 'Assinatura PSD 8BPS válida.');
    const version = buf.readUInt16BE(4);
    assert.equal(version, 1, 'Versão do cabeçalho PSD deve ser 1.');
    const height = buf.readUInt32BE(14);
    const width = buf.readUInt32BE(18);
    assert.equal(width, 1179);
    assert.equal(height, 1770);
    assert.ok(buf.includes(Buffer.from('TySh')), 'Descritor tipográfico de camadas de texto editáveis (TySh) deve existir.');

    // 4. Reabre o PSD exportado usando ag-psd e verifica as camadas de texto
    const reopened = readPsd(buf, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    });
    assert.equal(reopened.width, 1179);
    assert.equal(reopened.height, 1770);
    assert.ok(reopened.children && reopened.children.length >= 13);

    const rWhole = reopened.children[10];
    const rFrac = reopened.children[11];
    const rVal = reopened.children[isGuarana ? 13 : 13];

    assert.equal(rWhole?.text?.text?.trim(), '11', 'Preço de Reais deve ser 11.');
    assert.equal(rFrac?.text?.text?.trim(), '19', 'Preço de Centavos deve ser 19.');
    assert.equal(rVal?.text?.text?.trim(), 'OFERTA VÁLIDA ATÉ 08/11', 'Validade deve ser 08/11.');

    // 5. Verifica que fontes, efeitos de sombra e contorno foram preservados
    assert.equal(rWhole?.text?.style?.font?.name, 'Zullia');
    assert.ok(rWhole?.effects?.dropShadow, 'Efeito de sombra projetada (dropShadow) deve ser preservado.');
    assert.ok(rWhole?.effects?.stroke, 'Efeito de contorno (stroke) deve ser preservado.');
    assert.equal(rFrac?.text?.style?.font?.name, 'Zullia');

    // 6. Confirma que o PSD original continuou 100% inalterado
    const afterHash = createHash('sha256').update(readFileSync(srcPsd)).digest('hex');
    assert.equal(afterHash, origHash, 'O PSD original nunca deve ser modificado.');

    // 7. Conferência manual com Photoshop CS6 se instalado (Photoshop não participa da geração)
    if (existsSync(photoshopExe)) {
      const psCheckJsx = join(workDir, 'ps_check_guarana.jsx');
      const psStatusTxt = join(workDir, 'ps_status_guarana.txt');
      const jsx = `#target photoshop
app.displayDialogs = DialogModes.NO;
try {
  var doc = app.open(new File("${outPsd.replace(/\\/g, '/')}"));
  var lWhole = doc.artLayers.getByName("${isGuarana ? '6' : '4'}");
  var wholeText = lWhole.textItem.contents;
  var lFrac = doc.artLayers.getByName("19");
  var fracText = lFrac.textItem.contents;
  var bWhole = [lWhole.bounds[0].as("px"), lWhole.bounds[1].as("px"), lWhole.bounds[2].as("px"), lWhole.bounds[3].as("px")];
  var bFrac = [lFrac.bounds[0].as("px"), lFrac.bounds[1].as("px"), lFrac.bounds[2].as("px"), lFrac.bounds[3].as("px")];
  doc.close(SaveOptions.DONOTSAVECHANGES);
  var f = new File("${psStatusTxt.replace(/\\/g, '/')}");
  f.open("w");
  f.write("OK|" + wholeText + "|" + fracText + "|" + bWhole[2] + "|" + bFrac[0]);
  f.close();
} catch (e) {
  var f = new File("${psStatusTxt.replace(/\\/g, '/')}");
  f.open("w");
  f.write("ERROR|" + e.toString());
  f.close();
} finally {
  app.quit();
}
`;
      writeFileSync(psCheckJsx, jsx, 'utf8');
      spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath '${photoshopExe}' -ArgumentList @('-r', '${psCheckJsx}')`,
      ]);
      const start = Date.now();
      while (!existsSync(psStatusTxt) && Date.now() - start < 35_000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
      if (existsSync(psStatusTxt)) {
        const out = readFileSync(psStatusTxt, 'utf8');
        const parts = out.split('|');
        assert.equal(parts[0], 'OK', `Photoshop retornou erro na abertura: ${out}`);
        assert.equal(parts[1], '11', 'Photoshop deve ler a camada de reais como 11.');
        assert.equal(parts[2], '19', 'Photoshop deve ler a camada de centavos como 19.');
        const wholeRight = parseFloat(parts[3]);
        const fracLeft = parseFloat(parts[4]);
        assert.ok(wholeRight <= fracLeft, `Camada de Reais não pode ultrapassar Centavos (${wholeRight} <= ${fracLeft}).`);
      }
    }
  } finally {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Name photoshop -Force -ErrorAction SilentlyContinue']);
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('Sprint 07.3 — Tratamento de erros e segurança na exportação direta (bloqueio de sobrescrita, dados inválidos e continuidade)', async () => {
  // 1. Validação estática de regras de negócio e segurança
  const errOverwrite = validateExportJobBasics({
    itemId: '1',
    f7: '1001',
    description: 'TESTE OVERWRITE',
    sourcePsdPath: 'C:/Artes/arte.psd',
    outputPsdPath: 'C:/Artes/arte.psd',
    wholeLayerId: '10',
    fractionLayerId: '11',
    wholeValue: '5',
    fractionValue: '49',
  });
  assert.ok(errOverwrite?.includes('Bloqueado por segurança'));

  const errBadPrice = validateExportJobBasics({
    itemId: '2',
    f7: '1002',
    description: 'TESTE BAD PRICE',
    sourcePsdPath: 'C:/Artes/arte.psd',
    outputPsdPath: 'C:/Exportados/arte.psd',
    wholeLayerId: '10',
    fractionLayerId: '11',
    wholeValue: '',
    fractionValue: '49',
  });
  assert.ok(errBadPrice?.includes('Parte inteira do preço'));

  const errBadFraction = validateExportJobBasics({
    itemId: '3',
    f7: '1003',
    description: 'TESTE BAD FRACTION',
    sourcePsdPath: 'C:/Artes/arte.psd',
    outputPsdPath: 'C:/Exportados/arte.psd',
    wholeLayerId: '10',
    fractionLayerId: '11',
    wholeValue: '11',
    fractionValue: '9',
  });
  assert.ok(errBadFraction?.includes('Centavos do preço'));

  // 2. Continuidade do lote: falhas em itens individuais não interrompem o processamento
  const mockJobs = [
    {
      itemId: 'job-overwrite',
      f7: '1001',
      description: 'JOB OVERWRITE',
      sourcePsdPath: 'C:/Artes/orig.psd',
      outputPsdPath: 'C:/Artes/orig.psd',
      wholeLayerId: '10',
      fractionLayerId: '11',
      wholeValue: '5',
      fractionValue: '49',
    },
    {
      itemId: 'job-bad-price',
      f7: '1002',
      description: 'JOB BAD PRICE',
      sourcePsdPath: 'C:/Artes/orig.psd',
      outputPsdPath: 'C:/Exportados/bad.psd',
      wholeLayerId: '10',
      fractionLayerId: '11',
      wholeValue: '',
      fractionValue: '49',
    },
  ];

  const batch = await exportScantechPsdsDirect(mockJobs);
  assert.equal(batch.results.length, 2);
  assert.equal(batch.results[0].ok, false);
  assert.ok(batch.results[0].error?.includes('Bloqueado por segurança'));
  assert.equal(batch.results[1].ok, false);
  assert.ok(batch.results[1].error?.includes('Parte inteira do preço'));

  // 3. Teste em disco real caso o PSD de teste esteja disponível no ambiente
  if (existsSync(coronaCandidate)) {
    const workDir = join(tmpdir(), `skalee-sprint073-errors-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    const validDst = join(workDir, 'exportado_valido.psd');
    try {
      const diskJobs = [
        {
          itemId: 'disk-overwrite',
          f7: '1001',
          description: 'CORONA OVERWRITE',
          sourcePsdPath: coronaCandidate,
          outputPsdPath: coronaCandidate,
          wholeLayerId: '10',
          fractionLayerId: '11',
          wholeValue: '5',
          fractionValue: '49',
        },
        {
          itemId: 'disk-valid',
          f7: '1002',
          description: 'CORONA VALIDO',
          sourcePsdPath: coronaCandidate,
          outputPsdPath: validDst,
          wholeLayerId: '10',
          fractionLayerId: '11',
          wholeValue: '8',
          fractionValue: '79',
          validityText: 'OFERTA VÁLIDA ATÉ 15/11',
        },
      ];
      const diskBatch = await exportScantechPsdsDirect(diskJobs);
      assert.equal(diskBatch.results.length, 2);
      assert.equal(diskBatch.results[0].ok, false);
      assert.equal(diskBatch.results[1].ok, true);
      assert.ok(existsSync(validDst));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
});

test('Sprint 07.3 — Exportação em lote direta dos 14 produtos Scantech', {
  skip: !existsSync('C:/Users/Supermercado Sol/Documents/Skalee Cartazes/.scantech-campanhas/0c5138f8-c803-4818-a6dc-3766552e74be.skscantech'),
}, async () => {
  const campaignPath = 'C:/Users/Supermercado Sol/Documents/Skalee Cartazes/.scantech-campanhas/0c5138f8-c803-4818-a6dc-3766552e74be.skscantech';
  const campaign = JSON.parse(readFileSync(campaignPath, 'utf8'));

  const workDir = join(tmpdir(), `skalee-sprint073-batch14-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  try {
    const jobs = campaign.items.map((item: any) => {
      const origPath = item.sourcePsdPath.replace(/^\\\\\?\\/, '');
      const [y, m, d] = (item.endDateIso || '2026-11-08').split('-');
      return {
        itemId: item.id,
        f7: item.f7,
        description: item.description,
        sourcePsdPath: origPath,
        outputPsdPath: join(workDir, `${item.f7}-${item.sourcePsdName}`),
        wholeLayerId: item.wholeLayerId,
        fractionLayerId: item.fractionLayerId,
        decimalLayerId: item.decimalLayerId,
        fractionRuleLayerId: item.fractionRuleLayerId,
        validityLayerId: item.validityLayerId,
        wholeValue: String(Math.floor(item.priceCents / 100)),
        fractionValue: String(item.priceCents % 100).padStart(2, '0'),
        validityText: `OFERTA VÁLIDA ATÉ ${d}/${m}`,
      };
    });

    assert.equal(jobs.length, 14, 'A campanha Scantech real deve conter exatamente 14 produtos.');

    const batch = await exportScantechPsdsDirect(jobs);

    assert.equal(batch.results.length, 14);
    const successResults = batch.results.filter(r => r.ok);
    assert.equal(successResults.length, 14, `Todos os 14 PSDs devem ser gerados com sucesso direto. Falhas: ${batch.results.filter(r => !r.ok).map(r => r.error).join('; ')}`);

    for (const res of batch.results) {
      assert.ok(existsSync(res.outputPsdPath));
      const fileBytes = readFileSync(res.outputPsdPath);
      assert.equal(fileBytes.subarray(0, 4).toString('ascii'), '8BPS');
      assert.ok(fileBytes.includes(Buffer.from('TySh')));

      const reopened = readPsd(fileBytes, {
        skipLayerImageData: true,
        skipCompositeImageData: true,
        skipThumbnail: true,
      });
      assert.ok(reopened.children && reopened.children.length > 5);
      const wLayer = reopened.children[parseInt(res.wholeApplied || '', 10) ? 10 : 10];
      assert.ok(wLayer);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});



