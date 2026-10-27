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
  buildScantechItemViews,
  createScantechCampaign,
  linkCartazAndPsdToScantechItem,
  updateScantechItemFields,
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
}
`;
      writeFileSync(jsxFile, jsx, 'utf8');
      const child = spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath '${photoshopExe}' -ArgumentList @('-r', '${jsxFile}')`,
      ]);
      assert.equal(child.status, 0);

      const start = Date.now();
      while (!existsSync(statusFile) && Date.now() - start < 45_000) {
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
    assert.ok(Math.abs(origRotDeg - 6.17) < 0.2, `Rotação esperada ~6.17°, obtida ${origRotDeg}°`);
    assert.ok(Math.abs(origSkewDeg - 7.13) < 0.2, `Skew esperado ~7.13°, obtido ${origSkewDeg}°`);

    // 2. Substituição por "11" (R$ 11,99 e R$ 11,19): normalização de rotação e cisalhamento
    const adj11 = computeWholePriceAdjustment(artwork, '11');
    assert.equal(adj11.normalized, true);
    assert.ok(Math.abs(adj11.rotateDeltaDeg - (-origRotDeg)) < 0.2);
    assert.ok(adj11.targetSkewDeg >= 15.0 && adj11.targetSkewDeg <= 17.5);
    assert.ok(adj11.fitsWithinSafeLimit);
    assert.ok(adj11.horizontalScale >= 0.70 && adj11.horizontalScale <= 0.95);

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
