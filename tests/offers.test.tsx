import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRaw } from 'pako';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDocument, serialize } from '../src/features/cartazes/serialization';
import { indexCartazes } from '../src/features/cartazes/f7';
import type { Entry } from '../src/features/cartazes/types';
import {
  columnLetter,
  detectHeaderRowIndex,
  extractCampaignItemsFromSheet,
  parseExcelPriceToCents,
  parseSpreadsheet,
  parseXlsx,
  suggestColumnMapping,
} from '../src/features/ofertas/excel';
import {
  applyExcelToCampaign,
  archiveCampaign,
  buildCampaignMatchViews,
  buildCampaignPsdSuggestions,
  buildInitialPsdPairingSelections,
  buildPsdBatchConfirmationSummary,
  buildScheduledDocument,
  buildScheduledPoster,
  confirmBatchPrinted,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  executePsdBatchLinking,
  extractMeaningfulDescriptionTokens,
  inspectScheduledPriceApplication,
  linkSavedPosterToCampaignItem,
  listCampaigns,
  matchesExactF7InFilename,
  renameCampaign,
  saveCampaign,
  suggestFromExcelDescription,
  syncCampaignWithLibrary,
  updatePosterSelection,
  updateScheduledPrice,
} from '../src/features/ofertas/service';
import type { OfferCampaign, PsdImportOfferContext } from '../src/features/ofertas/types';
import type { ScannedPsdEntry } from '../src/features/scantech/types';
import { OfferFolders } from '../src/components/ofertas/OfferFolders';
import { PsdImport } from '../src/components/library/PsdImport';
import { formatCentsBr, splitCentsToParts } from '../src/features/cartazes/presentation';
import { hasInvertedPsdPriceParts, normalizePsdPriceParts, repairInvertedPsdArtwork } from '../src/components/editor/importedRenderer';
import type { ImportedArtwork } from '../src/features/cartazes/types';

function buildZip(files: Record<string, string>): ArrayBuffer {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let localOffset = 0;
  const names = Object.keys(files);

  for (const name of names) {
    const nameBytes = encoder.encode(name);
    const uncompressed = encoder.encode(files[name]);
    const compressed = deflateRaw(uncompressed);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lView = new DataView(localHeader.buffer);
    lView.setUint32(0, 0x04034b50, true);
    lView.setUint16(4, 20, true);
    lView.setUint16(8, 8, true);
    lView.setUint32(18, compressed.byteLength, true);
    lView.setUint32(22, uncompressed.byteLength, true);
    lView.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);

    const cdHeader = new Uint8Array(46 + nameBytes.length);
    const cView = new DataView(cdHeader.buffer);
    cView.setUint32(0, 0x02014b50, true);
    cView.setUint16(4, 20, true);
    cView.setUint16(6, 20, true);
    cView.setUint16(10, 8, true);
    cView.setUint32(20, compressed.byteLength, true);
    cView.setUint32(24, uncompressed.byteLength, true);
    cView.setUint16(28, nameBytes.length, true);
    cView.setUint32(42, localOffset, true);
    cdHeader.set(nameBytes, 46);

    localParts.push(localHeader, compressed);
    cdParts.push(cdHeader);
    localOffset += localHeader.byteLength + compressed.byteLength;
  }

  const cdSize = cdParts.reduce((sum, p) => sum + p.byteLength, 0);
  const eocd = new Uint8Array(22);
  const eView = new DataView(eocd.buffer);
  eView.setUint32(0, 0x06054b50, true);
  eView.setUint16(8, names.length, true);
  eView.setUint16(10, names.length, true);
  eView.setUint32(12, cdSize, true);
  eView.setUint32(16, localOffset, true);

  const totalSize = localOffset + cdSize + eocd.byteLength;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of [...localParts, ...cdParts, eocd]) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out.buffer;
}

export function buildSampleXlsx(): ArrayBuffer {
  const sharedStrings = [
    'RELATÓRIO DE CAMPANHA FUTURA',
    'CÓDIGO F7',
    'DESCRIÇÃO DO PRODUTO',
    'PREÇO OFERTA AMANHÃ',
    '001245',
    'REPOLHO VERDE KG',
    '000089',
    'BANANA PRATA KG',
    '999999',
    'PRODUTO SEM CARTAZ',
    '005500',
    'ITEM CONFLITO A',
    'ITEM CONFLITO B',
  ];
  const sstXml = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map(s => `<si><t>${s}</t></si>`).join('')}
</sst>`;

  const sheet1Xml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>1</v></c>
      <c r="B2" t="s"><v>2</v></c>
      <c r="C2" t="s"><v>3</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>4</v></c>
      <c r="B3" t="s"><v>5</v></c>
      <c r="C3"><v>3.49</v></c>
    </row>
    <row r="4">
      <c r="A4" t="s"><v>6</v></c>
      <c r="B4" t="s"><v>7</v></c>
      <c r="C4" t="inlineStr"><is><t>R$ 5,99</t></is></c>
    </row>
    <row r="5">
      <c r="A5" t="s"><v>8</v></c>
      <c r="B5" t="s"><v>9</v></c>
      <c r="C5"><v>12.50</v></c>
    </row>
    <row r="6">
      <c r="A6" t="s"><v>10</v></c>
      <c r="B6" t="s"><v>11</v></c>
      <c r="C6"><v>8.90</v></c>
    </row>
    <row r="7">
      <c r="A7" t="s"><v>10</v></c>
      <c r="B7" t="s"><v>12</v></c>
      <c r="C7"><v>9.49</v></c>
    </row>
    <row r="8">
      <c r="A8" t="inlineStr"><is><t></t></is></c>
      <c r="B8" t="inlineStr"><is><t>LINHA COM F7 VAZIO</t></is></c>
      <c r="C8" t="inlineStr"><is><t>invalido</t></is></c>
    </row>
  </sheetData>
</worksheet>`;

  const sheet2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>SKU</t></is></c>
      <c r="B1" t="inlineStr"><is><t>MERCADORIA</t></is></c>
      <c r="C1" t="inlineStr"><is><t>VALOR PROMOCIONAL</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>001245</t></is></c>
      <c r="B2" t="inlineStr"><is><t>REPOLHO VERDE KG</t></is></c>
      <c r="C2"><v>2.79</v></c>
    </row>
  </sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Ofertas Amanhã" sheetId="1" r:id="rId1"/>
    <sheet name="Hortifruti" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`;

  return buildZip({
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': relsXml,
    'xl/sharedStrings.xml': sstXml,
    'xl/worksheets/sheet1.xml': sheet1Xml,
    'xl/worksheets/sheet2.xml': sheet2Xml,
  });
}

test('Excel (.xlsx): leitura de múltiplas abas, linha de cabeçalho, sugestão de colunas, F7 com zeros à esquerda e conflitos', () => {
  const buffer = buildSampleXlsx();
  const originalSnapshot = new Uint8Array(buffer.slice(0));
  const wb = parseXlsx(buffer, 'ofertas-amanha.xlsx');

  // Garante que o buffer original nunca foi mutado
  assert.deepEqual(new Uint8Array(buffer), originalSnapshot);
  assert.equal(wb.fileName, 'ofertas-amanha.xlsx');
  assert.equal(wb.sheets.length, 2);
  assert.equal(wb.sheets[0].name, 'Ofertas Amanhã');
  assert.equal(wb.sheets[1].name, 'Hortifruti');

  // Linha 2 (índice 1) contém o cabeçalho na aba 1
  const headerRowIndex = 1;
  const headers = wb.sheets[0].rows[headerRowIndex];
  const suggested = suggestColumnMapping(headers);
  assert.deepEqual(suggested, { f7Col: 0, descriptionCol: 1, priceCol: 2 });
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(2), 'C');
  assert.equal(columnLetter(26), 'AA');

  const extraction = extractCampaignItemsFromSheet(wb.sheets[0], headerRowIndex, suggested);
  assert.equal(extraction.validCount, 3);
  assert.equal(extraction.invalidCount, 3); // 2 linhas conflitantes (005500) + 1 linha inválida
  assert.deepEqual(extraction.duplicateF7s, ['005500']);
  assert.deepEqual(extraction.conflictingF7s, ['005500']);

  const repolho = extraction.items.find(i => i.f7 === '001245');
  assert.ok(repolho);
  assert.equal(repolho.f7, '001245'); // preserva zeros à esquerda como string
  assert.equal(repolho.priceCents, 349);
  assert.equal(repolho.issues.length, 0);

  const banana = extraction.items.find(i => i.f7 === '000089');
  assert.ok(banana);
  assert.equal(banana.f7, '000089');
  assert.equal(banana.priceCents, 599);

  // Conversão exata de preços para centavos inteiros
  assert.equal(parseExcelPriceToCents('R$ 1.234,56'), 123456);
  assert.equal(parseExcelPriceToCents('2,99'), 299);
  assert.equal(parseExcelPriceToCents('12.90'), 1290);
  assert.throws(() => parseExcelPriceToCents(''), /vazio/);
  assert.throws(() => parseExcelPriceToCents('-2,99'), /negativo/);
});

test('Planilhas .xls e relatórios de ofertas: suporte a OpenXML .xls, texto CSV (.xls), HTML table (.xls) e detecção de cabeçalho do supermercado', () => {
  // 1. Arquivo .xls baseado em OpenXML/ZIP (exatamente o formato real emitido pelo ERP do supermercado)
  const zipBuffer = buildSampleXlsx();
  const wbXls = parseSpreadsheet(zipBuffer, 'quarta.quinta.verde.xls');
  assert.equal(wbXls.fileName, 'quarta.quinta.verde.xls');
  assert.equal(wbXls.sheets.length, 2);

  // 2. Arquivo .xls baseado em texto CSV delimitado por ponto-e-vírgula com cabeçalho de supermercado
  const csvText = [
    'SUPERMERCADO SOL EMITIDO EM: 10/11/2026',
    'RELACAO DE PRODUTOS DA PROMOCAO 1349',
    'FILIAIS: 01 02 03',
    'DIVULGACAO: 4',
    'COD.;DESCRICAO DO PRODUTO;PROMOCAO',
    '30001;ACUCAR CRISTAL BARRALCOOL 2KG;6,39',
    '7829;AMAC.ALPES 1,8L AZ INTENSO;7.59',
    '11403;AMAC.SOFT PLUS CONC.500ML ELEG;8.390000000000001',
    '005676;AMAC.VIDA 5L TRADICIONAL;12.99',
  ].join('\r\n');
  const encoder = new TextEncoder();
  const csvBuffer = encoder.encode(csvText).buffer;

  const wbCsv = parseXlsx(csvBuffer, 'relatorio_supermercado.xls');
  assert.equal(wbCsv.fileName, 'relatorio_supermercado.xls');
  assert.equal(wbCsv.sheets.length, 1);
  const rows = wbCsv.sheets[0].rows;
  assert.equal(rows.length, 9);

  // Detecção inteligente de cabeçalho varre até a linha 5 (índice 4)
  const headerIdx = detectHeaderRowIndex(rows);
  assert.equal(headerIdx, 4);
  assert.deepEqual(rows[headerIdx], ['COD.', 'DESCRICAO DO PRODUTO', 'PROMOCAO']);

  const mapping = suggestColumnMapping(rows[headerIdx]);
  assert.deepEqual(mapping, { f7Col: 0, descriptionCol: 1, priceCol: 2 });

  const extraction = extractCampaignItemsFromSheet(wbCsv.sheets[0], headerIdx, mapping);
  assert.equal(extraction.validCount, 4);
  assert.equal(extraction.invalidCount, 0);

  // Verificação de conversão e ponto flutuante IEEE-754 (8.390000000000001 -> 839 centavos = R$ 8,39)
  const itemFloat = extraction.items.find(i => i.f7 === '11403');
  assert.ok(itemFloat);
  assert.equal(itemFloat.priceCents, 839);
  assert.equal(itemFloat.description, 'AMAC.SOFT PLUS CONC.500ML ELEG');

  // Preservação de zeros à esquerda em códigos de produto F7
  const itemZero = extraction.items.find(i => i.f7 === '005676');
  assert.ok(itemZero);
  assert.equal(itemZero.f7, '005676');
  assert.equal(itemZero.priceCents, 1299);

  // 3. Arquivo .xls baseado em tabela HTML (<tr> e <td>)
  const htmlText = `<html><body><table>
    <tr><th>COD.</th><th>PRODUTO</th><th>PRECO</th></tr>
    <tr><td>1234</td><td>CAFE TORRADO 500G</td><td>14,90</td></tr>
  </table></body></html>`;
  const htmlBuffer = encoder.encode(htmlText).buffer;
  const wbHtml = parseXlsx(htmlBuffer, 'export_web.xls');
  assert.equal(wbHtml.sheets.length, 1);
  assert.equal(wbHtml.sheets[0].rows.length, 2);
  assert.deepEqual(wbHtml.sheets[0].rows[0], ['COD.', 'PRODUTO', 'PRECO']);
  assert.deepEqual(wbHtml.sheets[0].rows[1], ['1234', 'CAFE TORRADO 500G', '14,90']);

  // 4. Arquivo binário OLE2 legado (Excel 97-2003 puro) gera erro claro e explicativo
  const ole2Buffer = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]).buffer;
  assert.throws(
    () => parseXlsx(ole2Buffer, 'legado.xls'),
    /formato binário legado \(Excel 97-2003\)/
  );
});

test('Pastas de Ofertas: exibe edição no editor normal sem ação de variação', () => {
  const campaign = createCampaign('Ofertas da semana', '2026-11-17');
  const document = createDocument();
  document.product.productCode = '00123';
  const cartazPath = 'C:\\Cartazes\\origem.skcartaz';
  campaign.items.push({
    id: 'item-origem',
    rowNumber: 1,
    f7: '00123',
    description: 'MARCA ORIGINAL',
    scheduledPriceCents: 899,
    conflicting: false,
    issues: [],
    posters: [{
      cartazId: document.id,
      cartazPath,
      selected: true,
      copies: 1,
      status: 'preparado',
    }],
  });

  const html = renderToStaticMarkup(
    <OfferFolders
      libraryData={{
        root: 'C:\\Cartazes',
        entries: [{ name: 'origem.skcartaz', path: cartazPath, folder: false, content: serialize(document) }],
      }}
      run={() => {}}
      onPrintBatch={() => {}}
      onEditPoster={async () => {}}
      initialCampaigns={[campaign]}
      initialActiveId={campaign.id}
    />
  );
  assert.ok(html.includes('Editar cartaz'));
  assert.ok(!html.includes('Usar arte em outro produto'));
});

test('Pastas de Ofertas: oculta cópias idênticas de um cartaz em caminhos diferentes', () => {
  const campaign = createCampaign('Ofertas da semana', '2026-11-17');
  const original = createDocument();
  original.product.productCode = '30001';
  const copy = structuredClone(original);
  copy.id = crypto.randomUUID();
  copy.metadata.createdAt = '2026-11-01T00:00:00.000Z';
  copy.metadata.updatedAt = '2026-11-02T00:00:00.000Z';
  campaign.items.push({
    id: 'item-acucar',
    rowNumber: 1,
    f7: '30001',
    description: 'ACUCAR CRISTAL',
    scheduledPriceCents: 629,
    conflicting: false,
    issues: [],
    posters: [
      { cartazId: original.id, cartazPath: 'C:\\Cartazes\\original.skcartaz', selected: true, copies: 1, status: 'preparado' },
      { cartazId: copy.id, cartazPath: 'C:\\Cartazes\\copia.skcartaz', selected: true, copies: 1, status: 'preparado' },
    ],
  });
  const library = indexCartazes([
    { name: 'original.skcartaz', path: 'C:\\Cartazes\\original.skcartaz', folder: false, content: serialize(original) },
    { name: 'copia.skcartaz', path: 'C:\\Cartazes\\copia.skcartaz', folder: false, content: serialize(copy) },
  ]);

  const [view] = buildCampaignMatchViews(campaign, library);
  assert.equal(view.matchedPosters.length, 1);
  assert.equal(view.unlinkedLibraryPosters.length, 0);
});

test('Pastas de Ofertas: mostra cartaz exato da biblioteca ainda não vinculado à oferta', () => {
  const campaign = createCampaign('Ofertas da semana', '2026-11-17');
  const document = createDocument();
  document.product.name = 'ACUCAR MASCAVO ZAELI';
  document.product.complement = '500G';
  document.product.productCode = '15864';
  const cartazPath = 'C:\\Cartazes\\acucar-mascavo.skcartaz';
  campaign.items.push({
    id: 'item-acucar-mascavo',
    rowNumber: 10,
    f7: '15864',
    description: 'ACUCAR MASCAVO ZAELI 500G',
    scheduledPriceCents: 879,
    conflicting: false,
    issues: [],
    posters: [],
  });

  const html = renderToStaticMarkup(
    <OfferFolders
      libraryData={{
        root: 'C:\\Cartazes',
        entries: [{ name: 'acucar-mascavo.skcartaz', path: cartazPath, folder: false, content: serialize(document) }],
      }}
      run={() => {}}
      onPrintBatch={() => {}}
      initialCampaigns={[campaign]}
      initialActiveId={campaign.id}
    />
  );
  assert.ok(html.includes('Encontrado na biblioteca: ACUCAR MASCAVO ZAELI 500G'));
  assert.ok(html.includes('Vincular cartaz'));
});

test('Pastas de Ofertas: remove cartazes repetidos pelo mesmo caminho sem juntar arquivos distintos', () => {
  const campaign = createCampaign('Ofertas da semana', '2026-11-17');
  const document = createDocument();
  document.product.productCode = '30001';
  const path = 'C:\\Cartazes\\30001.skcartaz';
  campaign.items.push({
    id: 'item-duplicado',
    rowNumber: 8,
    f7: '30001',
    description: 'ACUCAR CRISTAL BARRALCOOL 2KG',
    scheduledPriceCents: 629,
    conflicting: false,
    issues: [],
    posters: [
      { cartazId: document.id, cartazPath: path, selected: true, copies: 1, status: 'impresso' },
      { cartazId: document.id, cartazPath: path.toLowerCase().replace(/\\/g, '/'), selected: true, copies: 1, status: 'preparado' },
    ],
  });
  const library = indexCartazes([{
    name: '30001.skcartaz',
    path,
    folder: false,
    content: serialize(document),
  }]);

  const view = buildCampaignMatchViews(campaign, library)[0];
  assert.equal(view.matchedPosters.length, 1);
  const synced = syncCampaignWithLibrary(campaign, library);
  assert.equal(synced.items[0].posters.length, 1);
  assert.equal(synced.items[0].posters[0].status, 'impresso');
});

test('Pastas de Ofertas: criação, associação por F7 (múltiplos cartazes e sem cartaz), preço futuro isolado e impressão parcial', () => {
  // Biblioteca simulada com 2 cartazes para o mesmo F7 001245 (clássico + PSD) e 1 para 000089
  const docClassic = createDocument();
  docClassic.id = '11111111-1111-4111-8111-111111111111';
  docClassic.product.name = 'REPOLHO VERDE';
  docClassic.product.complement = 'OFERTA KG';
  docClassic.product.productCode = '001245';
  docClassic.product.priceCents = 289; // Preço vigente na biblioteca: R$ 2,89

  const docPsd = createDocument();
  docPsd.id = '22222222-2222-4222-8222-222222222222';
  docPsd.product.name = 'REPOLHO VERDE ESPECIAL';
  docPsd.product.complement = 'ARTE PSD';
  docPsd.product.productCode = '001245';
  docPsd.product.priceCents = 299; // Preço vigente na biblioteca: R$ 2,99

  const docBanana = createDocument();
  docBanana.id = '33333333-3333-4333-8333-333333333333';
  docBanana.product.name = 'BANANA PRATA';
  docBanana.product.complement = 'KG';
  docBanana.product.productCode = '000089';
  docBanana.product.priceCents = 499; // Preço vigente na biblioteca: R$ 4,99

  const entries: Entry[] = [
    { name: 'repolho-classico.skcartaz', path: 'C:\\Cartazes\\repolho-classico.skcartaz', folder: false, content: serialize(docClassic) },
    { name: 'repolho-psd.skcartaz', path: 'C:\\Cartazes\\repolho-psd.skcartaz', folder: false, content: serialize(docPsd) },
    { name: 'banana.skcartaz', path: 'C:\\Cartazes\\banana.skcartaz', folder: false, content: serialize(docBanana) },
  ];
  const libIndex = indexCartazes(entries);

  // 1. Criar pasta de ofertas
  let campaign = createCampaign('Ofertas de Amanhã', '2026-10-27');
  assert.equal(campaign.name, 'Ofertas de Amanhã');
  assert.equal(campaign.campaignDate, '2026-10-27');
  assert.equal(campaign.archived, false);

  // 2. Importar Excel na pasta
  const wb = parseXlsx(buildSampleXlsx(), 'ofertas-amanha.xlsx');
  const extraction = extractCampaignItemsFromSheet(wb.sheets[0], 1, { f7Col: 0, descriptionCol: 1, priceCol: 2 });
  campaign = applyExcelToCampaign(campaign, extraction, libIndex, {
    fileName: wb.fileName,
    sheetName: wb.sheets[0].name,
    headerRowIndex: 1,
    mapping: { f7Col: 0, descriptionCol: 1, priceCol: 2 },
  });

  assert.equal(campaign.items.length, 3); // 001245, 000089, 999999
  const views = buildCampaignMatchViews(campaign, libIndex);

  // Verifica que F7 001245 vinculou 2 cartazes da biblioteca
  const repolhoView = views.find(v => v.item.f7 === '001245')!;
  assert.equal(repolhoView.matchedPosters.length, 2);
  assert.equal(repolhoView.missingPoster, false);
  assert.equal(repolhoView.item.scheduledPriceCents, 349);

  // Verifica que o preço futuro é projetado na prévia SEM alterar os documentos da biblioteca
  const scheduledDoc = buildScheduledDocument(docClassic, repolhoView.item.scheduledPriceCents);
  const scheduledPoster = buildScheduledPoster(docClassic, repolhoView.item.scheduledPriceCents);
  assert.equal(scheduledDoc.product.priceCents, 349);
  assert.equal(scheduledPoster.price, '3,49');
  assert.equal(docClassic.product.priceCents, 289); // Biblioteca permanece intacta!
  assert.equal(docPsd.product.priceCents, 299); // Biblioteca permanece intacta!

  // Verifica produto sem cartaz (999999)
  const missingView = views.find(v => v.item.f7 === '999999')!;
  assert.equal(missingView.missingPoster, true);
  assert.equal(missingView.matchedPosters.length, 0);

  // 3. Editar preço futuro manualmente
  campaign = updateScheduledPrice(campaign, repolhoView.item.id, 379);
  assert.equal(campaign.items.find(i => i.f7 === '001245')!.scheduledPriceCents, 379);
  assert.equal(docClassic.product.priceCents, 289); // Biblioteca segue intacta

  // 4. Selecionar cópias e confirmar impressão em partes
  campaign = updatePosterSelection(campaign, repolhoView.item.id, 'C:\\Cartazes\\repolho-classico.skcartaz', {
    copies: 3,
    selected: true,
  });
  const updatedRepolho = campaign.items.find(i => i.f7 === '001245')!;
  assert.equal(updatedRepolho.posters[0].copies, 3);
  assert.equal(updatedRepolho.posters[0].status, 'preparado');

  // Imprime Parte 1 (somente o primeiro cartaz do repolho)
  const part1Key = `${updatedRepolho.id}::c:\\cartazes\\repolho-classico.skcartaz`;
  campaign = confirmBatchPrinted(campaign, new Set([part1Key]));
  assert.equal(campaign.items.find(i => i.f7 === '001245')!.posters[0].status, 'impresso');
  assert.ok(campaign.items.find(i => i.f7 === '001245')!.posters[0].printedAt);
  // O segundo cartaz continua preparado para a Parte 2
  assert.equal(campaign.items.find(i => i.f7 === '001245')!.posters[1].status, 'preparado');

  // 5. Renomear, duplicar e arquivar pasta
  const renamed = renameCampaign(campaign, 'Ofertas Quarta-Feira', '2026-10-28');
  assert.equal(renamed.name, 'Ofertas Quarta-Feira');
  assert.equal(renamed.campaignDate, '2026-10-28');

  const duplicated = duplicateCampaign(renamed, 'Ofertas Quinta-Feira');
  assert.notEqual(duplicated.id, renamed.id);
  assert.equal(duplicated.name, 'Ofertas Quinta-Feira');
  // Na pasta duplicada, o status de impressão volta para preparado para nova campanha
  assert.equal(duplicated.items.find(i => i.f7 === '001245')!.posters[0].status, 'preparado');
  // Na pasta original, permanece impresso (pastas independentes)
  assert.equal(renamed.items.find(i => i.f7 === '001245')!.posters[0].status, 'impresso');

  const archived = archiveCampaign(renamed, true);
  assert.equal(archived.archived, true);

  // 6. Sincronizar novo cartaz adicionado posteriormente à biblioteca
  const docNovo = createDocument();
  docNovo.id = '44444444-4444-4444-8444-444444444444';
  docNovo.product.name = 'PRODUTO AGORA COM CARTAZ';
  docNovo.product.productCode = '999999';
  const syncedIndex = indexCartazes([
    ...entries,
    { name: 'novo.skcartaz', path: 'C:\\Cartazes\\novo.skcartaz', folder: false, content: serialize(docNovo) },
  ]);
  const synced = syncCampaignWithLibrary(archived, syncedIndex);
  assert.equal(synced.items.find(i => i.f7 === '999999')!.posters.length, 1);
});

test('Persistência IPC de Pastas de Ofertas e renderização da aba Pastas de Ofertas', async () => {
  const descriptors = ['window', 'isTauri'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { crypto: globalThis.crypto } });
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
  const store = new Map<string, OfferCampaign>();
  mockIPC((cmd, args: any) => {
    if (cmd === 'offer_campaigns') {
      const req = args.request;
      if (req.action === 'list') {
        return { campaigns: [...store.values()], errors: [] };
      }
      if (req.action === 'save') {
        const parsed = JSON.parse(req.content) as OfferCampaign;
        store.set(parsed.id, parsed);
        return parsed;
      }
      if (req.action === 'delete') {
        return store.delete(req.id);
      }
    }
    return null;
  });

  try {
    const c1 = createCampaign('Especial Fim de Semana', '2026-10-31');
    const saved = await saveCampaign(c1);
    assert.equal(saved.id, c1.id);

    const listed = await listCampaigns();
    assert.equal(listed.campaigns.length, 1);
    assert.equal(listed.campaigns[0].name, 'Especial Fim de Semana');

    const deleted = await deleteCampaign(c1.id);
    assert.equal(deleted, true);
    assert.equal((await listCampaigns()).campaigns.length, 0);

    const html = renderToStaticMarkup(
      <OfferFolders libraryData={null} run={() => {}} onPrintBatch={() => {}} />
    );
    assert.ok(html.includes('Pastas de Ofertas'));
    assert.ok(html.includes('Criar Pasta de Ofertas'));
  } finally {
    clearMocks();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('Sprint 06.1: Importação PSD diretamente na Pasta de Ofertas (exemplo F7 25037 — FLV.ABÓBORA KG CABOTIÁ — R$ 2,89)', () => {
  // 1. Sugestão de metadados a partir da descrição do Excel sem sobrescrever camadas reais do PSD
  const suggestion = suggestFromExcelDescription('FLV.ABÓBORA KG CABOTIÁ');
  assert.deepEqual(suggestion, { name: 'ABÓBORA', complement: 'CABOTIÁ', unit: 'KG' });

  // 2. Criar campanha e importar planilha contendo o item de exemplo 25037 (e um item com zeros à esquerda 0025037)
  let campaign = createCampaign('Ofertas Hortifruti', '2026-10-27');
  const sheet = {
    name: 'FLV',
    rows: [
      ['F7', 'DESCRIÇÃO', 'PREÇO OFERTA'],
      ['25037', 'FLV.ABÓBORA KG CABOTIÁ', '2,89'],
      ['0025037', 'PRODUTO COM ZEROS À ESQUERDA KG', '4,59'],
    ],
  };
  const extraction = extractCampaignItemsFromSheet(sheet, 0, { f7Col: 0, descriptionCol: 1, priceCol: 2 });
  assert.equal(extraction.validCount, 2);

  // Biblioteca inicialmente vazia -> ambos os produtos ficam "Sem cartaz"
  let libraryEntries: Entry[] = [];
  campaign = applyExcelToCampaign(campaign, extraction, indexCartazes(libraryEntries), {
    fileName: 'flv.xlsx',
    sheetName: 'FLV',
    headerRowIndex: 0,
    mapping: { f7Col: 0, descriptionCol: 1, priceCol: 2 },
  });

  let views = buildCampaignMatchViews(campaign, indexCartazes(libraryEntries));
  const aboboraBefore = views.find(v => v.item.f7 === '25037')!;
  const zeroBefore = views.find(v => v.item.f7 === '0025037')!;
  assert.equal(aboboraBefore.missingPoster, true);
  assert.equal(zeroBefore.missingPoster, true);
  assert.equal(aboboraBefore.item.scheduledPriceCents, 289);

  // 3. Contexto transmitido ao abrir o importador PSD a partir da linha "Sem cartaz"
  const offerContext: PsdImportOfferContext = {
    folderId: campaign.id,
    offerItemId: aboboraBefore.item.id,
    productCode: aboboraBefore.item.f7,
    description: aboboraBefore.item.description,
    futurePriceCents: aboboraBefore.item.scheduledPriceCents,
  };
  const modalHtml = renderToStaticMarkup(
    <PsdImport offerContext={offerContext} close={() => {}} saved={async () => {}} />
  );
  assert.ok(modalHtml.includes('Importar arte PSD para Pasta de Ofertas'));
  assert.ok(modalHtml.includes('25037'));
  assert.ok(modalHtml.includes('FLV.ABÓBORA KG CABOTIÁ'));
  assert.ok(modalHtml.includes('R$ 2,89'));

  // Importação normal pela biblioteca continua funcionando sem offerContext
  const normalModalHtml = renderToStaticMarkup(
    <PsdImport close={() => {}} saved={async () => {}} />
  );
  assert.ok(normalModalHtml.includes('Importar arte PSD'));
  assert.ok(!normalModalHtml.includes('Vinculando ao item da oferta'));

  // 4. Cancelar importação mantém a linha como "Sem cartaz" e dados intactos
  assert.equal(campaign.items.find(i => i.f7 === '25037')!.posters.length, 0);

  // 5. Simular salvamento de arte PSD com preço base 3,99 no PSD e F7 25037
  const savedPsdDoc = createDocument();
  savedPsdDoc.id = '77777777-7777-4777-8777-777777777777';
  savedPsdDoc.product.name = 'ABÓBORA';
  savedPsdDoc.product.complement = 'CABOTIÁ';
  savedPsdDoc.product.unit = 'KG';
  savedPsdDoc.product.productCode = '25037';
  savedPsdDoc.product.priceCents = 399; // Preço base salvo na biblioteca (extraído da arte PSD)
  const savedPath = 'C:\\Cartazes\\Hortifruti\\abobora-cabotia.skcartaz';

  libraryEntries = [
    ...libraryEntries,
    { name: 'abobora-cabotia.skcartaz', path: savedPath, folder: false, content: serialize(savedPsdDoc) },
  ];

  // Vincular à pasta de ofertas
  campaign = linkSavedPosterToCampaignItem(campaign, aboboraBefore.item.id, savedPath, savedPsdDoc);
  // Cliques repetidos não criam registros duplicados
  campaign = linkSavedPosterToCampaignItem(campaign, aboboraBefore.item.id, savedPath, savedPsdDoc);
  assert.equal(campaign.items.find(i => i.f7 === '25037')!.posters.length, 1);

  // 6. Verificar estado atualizado da Pasta de Ofertas e separação entre Preço da Biblioteca (3,99) e Preço Futuro (2,89)
  views = buildCampaignMatchViews(campaign, indexCartazes(libraryEntries));
  const aboboraAfter = views.find(v => v.item.f7 === '25037')!;
  assert.equal(aboboraAfter.missingPoster, false);
  assert.equal(aboboraAfter.matchedPosters.length, 1);
  assert.equal(aboboraAfter.matchedPosters[0].state.status, 'preparado');
  assert.equal(aboboraAfter.matchedPosters[0].state.selected, true);
  assert.equal(aboboraAfter.matchedPosters[0].state.copies, 1);
  assert.equal(aboboraAfter.matchedPosters[0].currentPriceCents, 399); // Preço base na biblioteca: R$ 3,99
  assert.equal(aboboraAfter.item.scheduledPriceCents, 289); // Preço futuro na oferta: R$ 2,89
  assert.equal(aboboraAfter.matchedPosters[0].scheduledDocument?.product.priceCents, 289); // Prévia/impressão usa R$ 2,89!
  assert.equal(savedPsdDoc.product.priceCents, 399); // Documento da biblioteca permanece intacto!

  // 7. Testar também preservação de F7 com zeros à esquerda ("0025037")
  const savedZeroDoc = createDocument();
  savedZeroDoc.id = '88888888-8888-4888-8888-888888888888';
  savedZeroDoc.product.productCode = '0025037';
  savedZeroDoc.product.priceCents = 499;
  const zeroPath = 'C:\\Cartazes\\Hortifruti\\zero-left.skcartaz';
  libraryEntries.push({ name: 'zero-left.skcartaz', path: zeroPath, folder: false, content: serialize(savedZeroDoc) });
  campaign = linkSavedPosterToCampaignItem(campaign, zeroBefore.item.id, zeroPath, savedZeroDoc);

  const zeroAfter = buildCampaignMatchViews(campaign, indexCartazes(libraryEntries)).find(v => v.item.f7 === '0025037')!;
  assert.equal(zeroAfter.missingPoster, false);
  assert.equal(zeroAfter.matchedPosters[0].libraryCartaz?.document.product.productCode, '0025037');
});

test('Correção de preços decimais e camadas PSD: R$ 19,89 vs R$ 89,19 (F7 38340 — ARROZ RAMPINELLI 5KG), R$ 8,99, R$ 10,90 e R$ 0,99', () => {
  // 1. Validar todos os casos exigidos de conversão de preços para centavos inteiros e formatação
  const testCases: { inputs: string[]; expectedCents: number; expectedBr: string; expectedParts: { whole: string; fraction: string } }[] = [
    {
      inputs: ['19,89', 'R$ 19,89', '19.89', '19.890000000000001'],
      expectedCents: 1989,
      expectedBr: '19,89',
      expectedParts: { whole: '19', fraction: '89' },
    },
    {
      inputs: ['89,19', 'R$ 89,19', '89.19', '89.189999999999998'],
      expectedCents: 8919,
      expectedBr: '89,19',
      expectedParts: { whole: '89', fraction: '19' },
    },
    {
      inputs: ['8,99', 'R$ 8,99', '8.99', '8.9900000000000002'],
      expectedCents: 899,
      expectedBr: '8,99',
      expectedParts: { whole: '8', fraction: '99' },
    },
    {
      inputs: ['10,90', 'R$ 10,90', '10.9', '10.90'],
      expectedCents: 1090,
      expectedBr: '10,90',
      expectedParts: { whole: '10', fraction: '90' },
    },
    {
      inputs: ['0,99', 'R$ 0,99', '0.99', '0.98999999999999999'],
      expectedCents: 99,
      expectedBr: '0,99',
      expectedParts: { whole: '0', fraction: '99' },
    },
  ];

  for (const tc of testCases) {
    for (const raw of tc.inputs) {
      assert.equal(parseExcelPriceToCents(raw), tc.expectedCents, `Falha ao converter "${raw}"`);
    }
    assert.equal(formatCentsBr(tc.expectedCents), tc.expectedBr);
    assert.deepEqual(splitCentsToParts(tc.expectedCents), tc.expectedParts);
  }

  // 2. Reproduzir exatamente o caso do F7 38340 (ARROZ RAMPINELLI 5KG) onde no PSD a camada "89" (centavos, direita, left=654)
  // aparece na árvore antes da camada "19" (reais, esquerda, left=46)
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const invertedArrozArtwork: ImportedArtwork = {
    kind: 'imported-psd',
    compatibility: 'ready',
    source: { fileName: 'arroz rampinelli 5kg tipo1.psd', sha256: 'a'.repeat(64) },
    canvas: { width: 1180, height: 1767, resolutionPpi: 150, fit: 'contain' },
    staticBackground: pixel,
    originalPreview: pixel,
    priceParts: [
      // Mapeamento invertido antigo: role='whole' na camada da direita (left: 654, originalText: '89')
      { role: 'whole', layerId: '9', bounds: { left: 654, top: 853, right: 1120, bottom: 1388 }, fontFamily: 'Zullia', originalText: '89', color: '#c84724' },
      // Mapeamento invertido antigo: role='fraction' na camada da esquerda (left: 46, originalText: '19')
      { role: 'fraction', layerId: '10', bounds: { left: 46, top: 820, right: 631, bottom: 1701 }, fontFamily: 'Zullia', originalText: '19', color: '#c84724' },
      { role: 'decimal', layerId: '8', bounds: { left: 657, top: 1448, right: 719, bottom: 1584 }, fontFamily: 'Zullia', originalText: ',', color: '#c84724' },
      { role: 'fractionRule', layerId: '7', bounds: { left: 663, top: 1407, right: 1071, bottom: 1435 }, color: '#c84724' },
    ],
    layers: [
      { id: '9', name: '89', type: 'text', visible: true, depth: 0, text: '89', font: 'Zullia', bounds: { left: 654, top: 853, right: 1120, bottom: 1388 } },
      { id: '10', name: '19', type: 'text', visible: true, depth: 0, text: '19', font: 'Zullia', bounds: { left: 46, top: 820, right: 631, bottom: 1701 } },
    ],
    warnings: [],
  };

  // Detecta inversão geométrica entre Reais e Centavos
  assert.equal(hasInvertedPsdPriceParts(invertedArrozArtwork), true);

  // Documento com mapeamento invertido salvo anteriormente
  const docArrozInvertido = createDocument();
  docArrozInvertido.product.name = 'ARROZ';
  docArrozInvertido.product.complement = 'RAMPINELLI';
  docArrozInvertido.product.productCode = '38340';
  docArrozInvertido.product.priceCents = 8919;
  docArrozInvertido.layout = { template: 'imported-psd', paper: 'A5', orientation: 'portrait', artwork: invertedArrozArtwork };

  // Validação antes de imprimir detecta divergência (19,89 -> 89,19) e sinaliza o produto
  const inspectionBefore = inspectScheduledPriceApplication(docArrozInvertido, 1989);
  assert.equal(inspectionBefore.hasInvertedLayers, true);
  assert.equal(inspectionBefore.appliedPriceCents, 8919);
  assert.ok(inspectionBefore.priceMismatchReason?.includes('Reais e Centavos estão invertidos'));
  assert.ok(inspectionBefore.priceMismatchReason?.includes('19,89'));
  assert.ok(inspectionBefore.priceMismatchReason?.includes('89,19'));

  // Normalização e reparo corrigem os papéis (layer 10 à esquerda vira 'whole', layer 9 à direita vira 'fraction') e restauram 1989 centavos (R$ 19,89)
  const normalizedParts = normalizePsdPriceParts(invertedArrozArtwork);
  assert.equal(normalizedParts.find(p => p.role === 'whole')?.layerId, '10');
  assert.equal(normalizedParts.find(p => p.role === 'fraction')?.layerId, '9');

  const repaired = repairInvertedPsdArtwork(invertedArrozArtwork);
  assert.equal(repaired.correctedPriceCents, 1989);
  assert.equal(hasInvertedPsdPriceParts(repaired.artwork), false);

  const docArrozCorrigido = structuredClone(docArrozInvertido);
  docArrozCorrigido.product.priceCents = repaired.correctedPriceCents!;
  docArrozCorrigido.layout = { template: 'imported-psd', paper: 'A5', orientation: 'portrait', artwork: repaired.artwork };

  // Após a correção, todos os preços (R$ 19,89, R$ 89,19, R$ 8,99, R$ 10,90 e R$ 0,99) passam sem divergência
  for (const tc of testCases) {
    const check = inspectScheduledPriceApplication(docArrozCorrigido, tc.expectedCents);
    assert.equal(check.hasInvertedLayers, false);
    assert.equal(check.priceMismatchReason, null, `Erro inesperado para ${tc.expectedBr}: ${check.priceMismatchReason}`);
    assert.equal(check.appliedPriceCents, tc.expectedCents);
  }
});

test('Pareamento de artes PSD na Pasta de Ofertas: F7 exato, descrição parecida (normalização de acentos e stopwords), ausência e ambiguidade de candidatos', () => {
  // 1. Teste de detecção de F7 exato no nome do arquivo PSD e distinção de zeros à esquerda
  assert.equal(matchesExactF7InFilename('25037', '25037 - abobora cabotia.psd'), true);
  assert.equal(matchesExactF7InFilename('001245', 'F7_001245_repolho_verde.psd'), true);
  assert.equal(matchesExactF7InFilename('001245', '1245_repolho_verde.psd'), false);
  assert.equal(matchesExactF7InFilename('25037', '0025037_abobora.psd'), false);
  assert.equal(matchesExactF7InFilename('5', 'arroz rampinelli 5kg [A5].psd'), false);

  // 2. Teste de normalização de acentos e remoção de palavras comuns / unidades
  assert.deepEqual(
    extractMeaningfulDescriptionTokens('FLV.ABÓBORA DE CABOTIÁ KG PARA OFERTA'),
    ['abobora', 'cabotia']
  );
  assert.deepEqual(
    extractMeaningfulDescriptionTokens('AÇÚCAR CRISTAL BARRÁLCOOL 2KG COM DESCONTO'),
    ['acucar', 'cristal', 'barralcool', 'desconto']
  );

  // 3. Montar campanha com 5 produtos cobrindo todos os cenários:
  // - Item 1 (F7 38340): F7 exato único -> confiável
  // - Item 2 (F7 25037): Sem F7 no arquivo, mas descrição parecida com acentos -> requer revisão
  // - Item 3 (F7 001245): Múltiplos candidatos com mesmo F7 -> ambíguo
  // - Item 4 (F7 77889): Múltiplos candidatos por descrição parecida -> ambíguo
  // - Item 5 (F7 999999): Sem nenhum PSD candidato -> sem sugestão
  let campaign = createCampaign('Campanha Fim de Semana', '2026-11-20');
  const sheet = {
    name: 'Ofertas',
    rows: [
      ['F7', 'DESCRIÇÃO', 'PREÇO OFERTA'],
      ['38340', 'ARROZ RAMPINELLI TIPO 1 5KG', '19,89'],
      ['25037', 'FLV.ABÓBORA KG CABOTIÁ', '2,89'],
      ['001245', 'REPOLHO VERDE KG', '3,49'],
      ['77889', 'CERVEJA CORONA EXTRA 350ML', '4,99'],
      ['999999', 'DETERGENTE NEUTRO INEXISTENTE 500ML', '1,99'],
    ],
  };
  const extraction = extractCampaignItemsFromSheet(sheet, 0, { f7Col: 0, descriptionCol: 1, priceCol: 2 });
  campaign = applyExcelToCampaign(campaign, extraction, [], {
    fileName: 'campanha.xlsx',
    sheetName: 'Ofertas',
    headerRowIndex: 0,
    mapping: { f7Col: 0, descriptionCol: 1, priceCol: 2 },
  });

  const scannedPsds: ScannedPsdEntry[] = [
    { name: 'F7 38340 - arroz outro nome.psd', path: 'C:\\PSDs\\38340.psd', size: 1024 * 1024 },
    { name: 'arroz rampinelli 5kg sem f7.psd', path: 'C:\\PSDs\\arroz_desc.psd', size: 1024 * 1024 },
    { name: 'abobora cabotia oferta.psd', path: 'C:\\PSDs\\abobora.psd', size: 1024 * 1024 },
    { name: '001245 - repolho verde a5.psd', path: 'C:\\PSDs\\repolho_a5.psd', size: 1024 * 1024 },
    { name: '001245 - repolho verde a6.psd', path: 'C:\\PSDs\\repolho_a6.psd', size: 1024 * 1024 },
    { name: 'cerveja corona extra lata.psd', path: 'C:\\PSDs\\corona_lata.psd', size: 1024 * 1024 },
    { name: 'cerveja corona extra long neck.psd', path: 'C:\\PSDs\\corona_ln.psd', size: 1024 * 1024 },
  ];

  const suggestions = buildCampaignPsdSuggestions(campaign, scannedPsds);
  assert.equal(suggestions.length, 5);

  // Item 1 (38340): Prioriza F7 exato sobre arquivo com descrição parecida
  const sugArroz = suggestions.find(s => s.item.f7 === '38340')!;
  assert.equal(sugArroz.reason, 'f7-exact');
  assert.equal(sugArroz.reasonLabel, 'F7 exato');
  assert.equal(sugArroz.ambiguous, false);
  assert.equal(sugArroz.candidates.length, 1);
  assert.equal(sugArroz.recommendedPsd?.path, 'C:\\PSDs\\38340.psd');
  assert.equal(sugArroz.autoSelectForBatch, true);

  // Item 2 (25037): Sugestão por descrição parecida (normalizando acentos de ABÓBORA CABOTIÁ e ignorando FLV/KG)
  const sugAbobora = suggestions.find(s => s.item.f7 === '25037')!;
  assert.equal(sugAbobora.reason, 'description-similar');
  assert.equal(sugAbobora.reasonLabel, 'Descrição parecida');
  assert.equal(sugAbobora.ambiguous, false);
  assert.equal(sugAbobora.recommendedPsd?.path, 'C:\\PSDs\\abobora.psd');
  assert.deepEqual(sugAbobora.candidates[0].matchedTerms, ['abobora', 'cabotia']);
  // Não deve ser marcado automaticamente para lote sem revisão explícita!
  assert.equal(sugAbobora.autoSelectForBatch, false);

  // Item 3 (001245): Múltiplos candidatos com o mesmo F7 -> ambíguo
  const sugRepolho = suggestions.find(s => s.item.f7 === '001245')!;
  assert.equal(sugRepolho.reason, 'f7-exact');
  assert.equal(sugRepolho.reasonLabel, 'F7 exato');
  assert.equal(sugRepolho.ambiguous, true);
  assert.equal(sugRepolho.candidates.length, 2);
  assert.equal(sugRepolho.recommendedPsd, null);
  assert.equal(sugRepolho.autoSelectForBatch, false);
  assert.ok(sugRepolho.ambiguityReason?.includes('Mais de um arquivo PSD (2)'));

  // Item 4 (77889): Múltiplos candidatos por descrição parecida -> ambíguo
  const sugCorona = suggestions.find(s => s.item.f7 === '77889')!;
  assert.equal(sugCorona.reason, 'description-similar');
  assert.equal(sugCorona.reasonLabel, 'Descrição parecida');
  assert.equal(sugCorona.ambiguous, true);
  assert.equal(sugCorona.candidates.length, 2);
  assert.equal(sugCorona.recommendedPsd, null);
  assert.equal(sugCorona.autoSelectForBatch, false);

  // Item 5 (999999): Sem sugestão
  const sugInexistente = suggestions.find(s => s.item.f7 === '999999')!;
  assert.equal(sugInexistente.reason, 'no-suggestion');
  assert.equal(sugInexistente.reasonLabel, 'Sem sugestão');
  assert.equal(sugInexistente.ambiguous, false);
  assert.equal(sugInexistente.candidates.length, 0);
  assert.equal(sugInexistente.recommendedPsd, null);
  assert.equal(sugInexistente.autoSelectForBatch, false);
});

test('Pareamento PSD: revisão, confirmação em lote, separação de preços (biblioteca vs oferta) e relato claro de erros parciais', async () => {
  let campaign = createCampaign('Ofertas Quarta', '2026-11-21');
  const sheet = {
    name: 'Ofertas',
    rows: [
      ['F7', 'DESCRIÇÃO', 'PREÇO OFERTA'],
      ['38340', 'ARROZ RAMPINELLI 5KG', '19,89'],
      ['25037', 'FLV.ABÓBORA KG CABOTIÁ', '2,89'],
      ['001245', 'REPOLHO VERDE KG', '3,49'],
      ['999999', 'PRODUTO SEM SUGESTÃO', '9,99'],
    ],
  };
  const extraction = extractCampaignItemsFromSheet(sheet, 0, { f7Col: 0, descriptionCol: 1, priceCol: 2 });
  campaign = applyExcelToCampaign(campaign, extraction, [], {
    fileName: 'quarta.xlsx',
    sheetName: 'Ofertas',
    headerRowIndex: 0,
    mapping: { f7Col: 0, descriptionCol: 1, priceCol: 2 },
  });

  const scannedPsds: ScannedPsdEntry[] = [
    { name: '38340 - arroz rampinelli.psd', path: 'C:\\PSDs\\38340.psd', size: 2048 },
    { name: 'abobora cabotia.psd', path: 'C:\\PSDs\\abobora.psd', size: 2048 },
    { name: '001245 - repolho a5.psd', path: 'C:\\PSDs\\repolho_a5.psd', size: 2048 },
    { name: '001245 - repolho a6.psd', path: 'C:\\PSDs\\repolho_a6.psd', size: 2048 },
  ];

  const suggestions = buildCampaignPsdSuggestions(campaign, scannedPsds);
  const selections = buildInitialPsdPairingSelections(suggestions);

  // 1. Antes da revisão manual: o resumo de confirmação em lote inclui APENAS o F7 exato não ambíguo (38340)
  // Sugestão apenas por descrição (25037) e ambígua com 2 candidatos (001245) NÃO entram silenciosamente!
  const summaryDefault = buildPsdBatchConfirmationSummary(suggestions, selections, scannedPsds);
  assert.equal(summaryDefault.toLink.length, 1);
  assert.equal(summaryDefault.toLink[0].item.f7, '38340');
  assert.equal(summaryDefault.exactF7Count, 1);
  assert.equal(summaryDefault.reviewedManualOrDescriptionCount, 0);
  assert.equal(summaryDefault.skippedAmbiguousOrUnreviewedCount, 2); // 25037 (descrição) + 001245 (ambíguo)
  assert.equal(summaryDefault.skippedNoSuggestionCount, 1); // 999999

  // Mesmo que alguém tente forçar includedInBatch=true sem reviewedByUser=true em item de descrição, o guard bloqueia
  const aboboraItem = campaign.items.find(i => i.f7 === '25037')!;
  const unreviewedAttempt = {
    ...selections,
    [aboboraItem.id]: {
      psdPath: 'C:\\PSDs\\abobora.psd',
      includedInBatch: true,
      reviewedByUser: false,
    },
  };
  assert.equal(buildPsdBatchConfirmationSummary(suggestions, unreviewedAttempt, scannedPsds).toLink.length, 1);

  // 2. Usuário revisa explicitamente a sugestão por descrição (25037) e escolhe manualmente um candidato para o ambíguo (001245)
  const repolhoItem = campaign.items.find(i => i.f7 === '001245')!;
  const reviewedSelections = {
    ...selections,
    [aboboraItem.id]: {
      psdPath: 'C:\\PSDs\\abobora.psd',
      includedInBatch: true,
      reviewedByUser: true,
    },
    [repolhoItem.id]: {
      psdPath: 'C:\\PSDs\\repolho_a6.psd',
      includedInBatch: true,
      reviewedByUser: true,
    },
  };

  const summaryReviewed = buildPsdBatchConfirmationSummary(suggestions, reviewedSelections, scannedPsds);
  assert.equal(summaryReviewed.toLink.length, 3);
  assert.equal(summaryReviewed.exactF7Count, 1);
  assert.equal(summaryReviewed.reviewedManualOrDescriptionCount, 2);
  assert.equal(summaryReviewed.skippedAmbiguousOrUnreviewedCount, 0);
  assert.equal(summaryReviewed.skippedNoSuggestionCount, 1);

  // 3. Renderização da interface de Pareamento PSD e da etapa de Confirmação em Lote
  const modalMarkup = renderToStaticMarkup(
    <OfferFolders
      libraryData={null}
      run={() => {}}
      onPrintBatch={() => {}}
      initialCampaigns={[campaign]}
      initialActiveId={campaign.id}
      initialPsdFolder="C:\\PSDs"
      initialScannedPsds={scannedPsds}
      initialShowPsdModal={true}
      initialShowBatchConfirmStep={true}
      initialPsdPairingSelections={reviewedSelections}
    />
  );
  assert.ok(modalMarkup.includes('Pareamento de Artes PSD com Produtos da Campanha'));
  assert.ok(modalMarkup.includes('Selecionar uma pasta serve apenas para procurar arquivos PSD de referência'));
  assert.ok(modalMarkup.includes('F7 exato'));
  assert.ok(modalMarkup.includes('Descrição parecida'));
  assert.ok(modalMarkup.includes('Sem sugestão'));
  assert.ok(modalMarkup.includes('Mais de um arquivo PSD (2) encontrado para o F7 001245'));
  assert.ok(modalMarkup.includes('Confirmar aplicação de vínculos em lote (3 produto(s)'));

  // 4. Executar lote preservando integridade do PSD original e separação entre preço base da biblioteca e preço futuro da oferta
  const originalPsdBytes = new Uint8Array([0x38, 0x42, 0x50, 0x53, 1, 2, 3, 4]);
  const savedDocs = new Map<string, ReturnType<typeof createDocument>>();

  const batchSuccess = await executePsdBatchLinking(
    campaign,
    summaryReviewed.toLink.map(e => ({ item: e.item, psd: e.psd })),
    'A6',
    'C:\\Biblioteca',
    {
      readPsd: async psdPath => ({
        name: psdPath.split('\\').pop()!,
        path: psdPath,
        buffer: originalPsdBytes.buffer.slice(0),
      }),
      buildCartazFromPsd: async (_psdData, item, paperSize) => {
        const doc = createDocument();
        doc.product.name = item.description;
        doc.product.productCode = item.f7;
        // Simula preço base original extraído da arte PSD (R$ 24,90 para arroz, R$ 3,99 para demais)
        doc.product.priceCents = item.f7 === '38340' ? 2490 : 399;
        doc.layout.paper = paperSize;
        return doc;
      },
      saveCartazDocument: async (targetPath, doc) => {
        savedDocs.set(targetPath, doc);
      },
      persistCampaign: async updated => updated,
    }
  );

  assert.equal(batchSuccess.success, true);
  assert.equal(batchSuccess.linkedCount, 3);
  assert.equal(batchSuccess.errors.length, 0);
  assert.ok(batchSuccess.message.includes('Vinculação concluída com sucesso'));
  // Buffer original permanece intacto
  assert.deepEqual(originalPsdBytes, new Uint8Array([0x38, 0x42, 0x53 === 0 ? 0 : 0x50, 0x53, 1, 2, 3, 4]));

  // Verifica que na biblioteca o preço base do PSD (2490 = R$ 24,90) foi salvo, enquanto na campanha o preço futuro permanece 1989 (R$ 19,89)
  const libEntries: Entry[] = [...savedDocs.entries()].map(([path, doc]) => ({
    name: path.split('\\').pop()!,
    path,
    folder: false,
    content: serialize(doc),
  }));
  const viewsAfter = buildCampaignMatchViews(batchSuccess.campaign, indexCartazes(libEntries));
  const arrozView = viewsAfter.find(v => v.item.f7 === '38340')!;
  assert.equal(arrozView.missingPoster, false);
  assert.equal(arrozView.matchedPosters[0].currentPriceCents, 2490); // Preço base na biblioteca intacto
  assert.equal(arrozView.item.scheduledPriceCents, 1989); // Preço futuro da oferta intacto
  assert.equal(arrozView.matchedPosters[0].scheduledDocument?.product.priceCents, 1989);

  // 5. Falha parcial durante vinculação: não deve informar sucesso se parte da operação falhou
  const batchPartialFailure = await executePsdBatchLinking(
    campaign,
    summaryReviewed.toLink.map(e => ({ item: e.item, psd: e.psd })),
    'A6',
    'C:\\Biblioteca',
    {
      readPsd: async psdPath => {
        if (psdPath.includes('abobora')) {
          throw new Error('Arquivo PSD corrompido ou inacessível.');
        }
        return { name: psdPath, path: psdPath, buffer: new ArrayBuffer(8) };
      },
      buildCartazFromPsd: async (_psdData, item) => {
        if (item.f7 === '001245') {
          throw new Error('Camadas de preço Reais/Centavos não encontradas no PSD.');
        }
        const doc = createDocument();
        doc.product.productCode = item.f7;
        return doc;
      },
      saveCartazDocument: async () => {},
      persistCampaign: async updated => updated,
    }
  );

  assert.equal(batchPartialFailure.success, false);
  assert.equal(batchPartialFailure.linkedCount, 1);
  assert.equal(batchPartialFailure.errors.length, 2);
  assert.ok(!batchPartialFailure.message.includes('Vinculação concluída com sucesso'));
  assert.ok(batchPartialFailure.message.includes('Atenção: operação concluída com falhas'));
  assert.ok(batchPartialFailure.errors.some(e => e.f7 === '25037' && e.error.includes('Arquivo PSD corrompido')));
  assert.ok(batchPartialFailure.errors.some(e => e.f7 === '001245' && e.error.includes('Camadas de preço')));

  const errorMarkup = renderToStaticMarkup(
    <OfferFolders
      libraryData={null}
      run={() => {}}
      onPrintBatch={() => {}}
      initialCampaigns={[batchPartialFailure.campaign]}
      initialActiveId={batchPartialFailure.campaign.id}
      initialPsdFolder="C:\\PSDs"
      initialScannedPsds={scannedPsds}
      initialShowPsdModal={true}
      initialBatchLinkResult={batchPartialFailure}
    />
  );
  assert.ok(errorMarkup.includes('Atenção: operação concluída com falhas'));
  assert.ok(errorMarkup.includes('Arquivo PSD corrompido ou inacessível.'));
  assert.ok(errorMarkup.includes('Camadas de preço Reais/Centavos não encontradas no PSD.'));
});
