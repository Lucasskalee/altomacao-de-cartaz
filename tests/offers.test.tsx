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
  extractCampaignItemsFromSheet,
  parseExcelPriceToCents,
  parseXlsx,
  suggestColumnMapping,
} from '../src/features/ofertas/excel';
import {
  applyExcelToCampaign,
  archiveCampaign,
  buildCampaignMatchViews,
  buildScheduledDocument,
  buildScheduledPoster,
  confirmBatchPrinted,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  inspectScheduledPriceApplication,
  linkSavedPosterToCampaignItem,
  listCampaigns,
  renameCampaign,
  saveCampaign,
  suggestFromExcelDescription,
  syncCampaignWithLibrary,
  updatePosterSelection,
  updateScheduledPrice,
} from '../src/features/ofertas/service';
import type { OfferCampaign, PsdImportOfferContext } from '../src/features/ofertas/types';
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
