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
  listCampaigns,
  renameCampaign,
  saveCampaign,
  syncCampaignWithLibrary,
  updatePosterSelection,
  updateScheduledPrice,
} from '../src/features/ofertas/service';
import type { OfferCampaign } from '../src/features/ofertas/types';
import { OfferFolders } from '../src/components/ofertas/OfferFolders';

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
  assert.equal(scheduledPoster.price, '3.49');
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
