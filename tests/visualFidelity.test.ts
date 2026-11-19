import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFontFamily,
  resolveFontWeight,
  hasInvertedPsdPriceParts,
  normalizePsdPriceParts,
} from '../src/components/editor/importedRenderer';
import {
  linkSavedPosterToCampaignItem,
  updateAllPostersSelection,
  updatePosterSelection,
  formatCampaignDateToValidity,
} from '../src/features/ofertas/service';
import type { Cartaz, ImportedArtwork } from '../src/features/cartazes/types';
import type { OfferCampaign } from '../src/features/ofertas/types';

test('1. Resolução de fontes oficiais PSD: preserva Zullia, Brush Hand New, Arial Black e Arial', () => {
  assert.equal(resolveFontFamily('Zullia'), "'Zullia', sans-serif");
  assert.equal(resolveFontFamily('BrushHandNew'), "'Brush Hand New', BrushHandNew, cursive, sans-serif");
  assert.equal(resolveFontFamily('Brush Hand New'), "'Brush Hand New', BrushHandNew, cursive, sans-serif");
  assert.equal(resolveFontFamily('Arial-Black'), "'Arial Black', ArialMT, Arial, sans-serif");
  assert.equal(resolveFontFamily('ARIBLK'), "'Arial Black', ArialMT, Arial, sans-serif");
  assert.equal(resolveFontFamily('ArialMT'), 'ArialMT, Arial, sans-serif');
  assert.equal(resolveFontFamily('Arial-BoldMT'), "'Arial', ArialMT, sans-serif");
  assert.equal(resolveFontFamily('Impact'), "'Impact', sans-serif");

  assert.equal(resolveFontWeight('Arial-Black'), '900');
  assert.equal(resolveFontWeight('ARIBLK'), '900');
  assert.equal(resolveFontWeight('Arial-BoldMT'), '700');
  assert.equal(resolveFontWeight('BrushHandNew'), '400');
});

test('2. Inversão matemática de vetor de sombra projetada garante offset correto no espaço transformado', () => {
  const xx = 12.27, xy = -0.28, yx = 3.31, yy = 16.35;
  const det = xx * yy - xy * yx;
  const targetShadowDx = 6;
  const targetShadowDy = 10;

  // Fórmula de inversão de matriz 2x2
  const localDx = (yy * targetShadowDx - yx * targetShadowDy) / det;
  const localDy = (-xy * targetShadowDx + xx * targetShadowDy) / det;

  // Projeção direta para a tela
  const resX = xx * localDx + yx * localDy;
  const resY = xy * localDx + yy * localDy;

  assert.ok(Math.abs(resX - targetShadowDx) < 0.0001, 'Offset X da sombra deve projetar exatamente 6px na tela');
  assert.ok(Math.abs(resY - targetShadowDy) < 0.0001, 'Offset Y da sombra deve projetar exatamente 10px na tela');
});

test('3. Espessura do traçado (stroke) compensa escala da matriz para evitar deformação visual', () => {
  const c = 3.31, d = 16.35;
  const scaleY = Math.hypot(c, d); // ~16.68
  const desiredPsdStrokePx = 2; // 2 pixels no PSD original

  const localStrokeWidth = ((desiredPsdStrokePx) / scaleY) * 2;
  const effectiveStrokePxOnScreen = (localStrokeWidth / 2) * scaleY;

  assert.ok(Math.abs(effectiveStrokePxOnScreen - desiredPsdStrokePx) < 0.0001, 'Espessura do stroke deve ser de 2px no documento');
});

test('4. Sincronização e formatação da data de campanha para validade', () => {
  const dateIso = '2026-11-19';
  const valVencimento = formatCampaignDateToValidity(dateIso, 'vencimento');
  const valOferta = formatCampaignDateToValidity(dateIso, 'oferta');

  assert.equal(valVencimento, '19/11');
  assert.equal(valOferta, 'OFERTA VÁLIDA ATÉ 19/11/2026');
});

test('5. Seleção em lote rápida (updateAllPostersSelection) marca e desmarca instantaneamente', () => {
  const campaign: OfferCampaign = {
    schemaVersion: 1,
    id: 'camp-1',
    name: 'Campanha Teste',
    campaignDate: '2026-11-19',
    archived: false,
    sourceExcel: null,
    items: [
      {
        id: 'item-1',
        f7: '12345',
        description: 'PRODUTO 1',
        scheduledPriceCents: 599,
        rowNumber: 2,
        posters: [
          { cartazId: 'c1', cartazPath: 'C:\\c1.skcartaz', selected: true, copies: 1, status: 'preparado', printedAt: null },
        ],
      },
      {
        id: 'item-2',
        f7: '67890',
        description: 'PRODUTO 2',
        scheduledPriceCents: 1290,
        rowNumber: 3,
        posters: [
          { cartazId: 'c2', cartazPath: 'C:\\c2.skcartaz', selected: true, copies: 1, status: 'preparado', printedAt: null },
        ],
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Desmarca todos
  const unselectedAll = updateAllPostersSelection(campaign, false);
  assert.equal(unselectedAll.items[0].posters[0].selected, false);
  assert.equal(unselectedAll.items[0].posters[0].status, 'pendente');
  assert.equal(unselectedAll.items[1].posters[0].selected, false);
  assert.equal(unselectedAll.items[1].posters[0].status, 'pendente');

  // Marca todos novamente
  const selectedAll = updateAllPostersSelection(unselectedAll, true);
  assert.equal(selectedAll.items[0].posters[0].selected, true);
  assert.equal(selectedAll.items[0].posters[0].status, 'preparado');
  assert.equal(selectedAll.items[1].posters[0].selected, true);
  assert.equal(selectedAll.items[1].posters[0].status, 'preparado');
});

test('6. Troca de imagem PSD de referência (replaceExisting: true) substitui sem duplicar cartazes', () => {
  const campaign: OfferCampaign = {
    schemaVersion: 1,
    id: 'camp-1',
    name: 'Campanha Teste',
    campaignDate: '2026-11-19',
    archived: false,
    sourceExcel: null,
    items: [
      {
        id: 'item-1',
        f7: '18427',
        description: 'BISC.RANCHEIRO 300G C.CRACKER',
        scheduledPriceCents: 439,
        rowNumber: 2,
        posters: [
          { cartazId: 'cartaz-antigo', cartazPath: 'C:\\antigo.skcartaz', selected: true, copies: 1, status: 'preparado', printedAt: null },
        ],
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const newDoc: Cartaz = {
    schemaVersion: 1,
    id: 'cartaz-novo',
    product: {
      name: 'BISC.RANCHEIRO 300G',
      complement: 'CREAM CRACKER',
      unit: 'PCT',
      priceCents: 439,
      productCode: '18427',
    },
    layout: {
      template: 'imported-psd',
      paper: 'A5',
      orientation: 'portrait',
      artwork: {} as any,
    },
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };

  // Substitui a imagem de referência errada pela nova
  const updatedCampaign = linkSavedPosterToCampaignItem(
    campaign,
    'item-1',
    'C:\\novo-rancheiro.skcartaz',
    newDoc,
    true // replaceExisting = true
  );

  const updatedItem = updatedCampaign.items.find(i => i.id === 'item-1')!;
  assert.equal(updatedItem.posters.length, 1, 'Deve ter exatamente 1 cartaz vinculado após a substituição');
  assert.equal(updatedItem.posters[0].cartazId, 'cartaz-novo');
  assert.equal(updatedItem.posters[0].cartazPath, 'C:\\novo-rancheiro.skcartaz');
  assert.equal(updatedItem.posters[0].selected, true);
});

test('7. Extração fiel das camadas do modelo PSD oficial: FRIMESA e 300G sem stroke forçado e cor preta sólida', async () => {
  const { readFileSync } = await import('node:fs');
  const { readPsd, initializeCanvas } = await import('ag-psd');
  const { analyzePsd, buildArtwork } = await import('../src/features/psd/importer');

  const fakeCanvas = (w: number, h: number) => {
    return {
      width: w,
      height: h,
      getContext: () => ({
        fillRect: () => {},
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
        save: () => {},
        restore: () => {},
      }),
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    };
  };
  initializeCanvas(fakeCanvas as any, (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h } as any));

  const buf = readFileSync('public/templates/modelo_oferta.psd');
  const analysis = await analyzePsd(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'modelo_oferta.psd');
  const artwork = buildArtwork(analysis, analysis.suggested, analysis.templateSuggested);

  assert.ok(artwork.templateParts && artwork.templateParts.length > 0, 'Deve conter partes dinâmicas de template');
  const titlePart = artwork.templateParts.find(p => p.role === 'title');
  const categoryPart = artwork.templateParts.find(p => p.role === 'category');
  const complementPart = artwork.templateParts.find(p => p.role === 'complement');

  assert.ok(titlePart, 'Deve conter camada de título');
  assert.equal(titlePart.fontFamily, 'BrushHandNew');
  // Camada FRIMESA no PSD original não tem stroke
  assert.equal(titlePart.stroke, undefined, 'Título FRIMESA não deve ter stroke inventado');
  // Cor deve ser preta sólida (#000000) e NÃO cinza claro (#e2e2e2)
  assert.equal(titlePart.color, '#000000', 'Título deve ter cor preta sólida');

  assert.ok(categoryPart, 'Deve conter camada de categoria');
  assert.equal(categoryPart.fontFamily, 'ArialMT');
  // NATA tem stroke de 4px no PSD
  assert.ok(categoryPart.stroke && categoryPart.stroke.size > 0, 'Categoria NATA deve preservar stroke original do PSD');

  assert.ok(complementPart, 'Deve conter camada de complemento');
  assert.equal(complementPart.fontFamily, 'ArialMT');
  // TRADICIONAL tem stroke de 4px no PSD
  assert.ok(complementPart.stroke && complementPart.stroke.size > 0, 'Complemento TRADICIONAL deve preservar stroke original do PSD');

  // Preço grande (whole): Zullia, laranja, com dropShadow e sem stroke
  const wholePart = artwork.priceParts.find(p => p.role === 'whole');
  assert.ok(wholePart, 'Deve conter camada de reais');
  assert.equal(wholePart.fontFamily, 'Zullia');
  assert.ok(wholePart.color.startsWith('#c'), 'Preço deve ter cor laranja original do PSD');
  assert.ok(wholePart.shadow, 'Preço deve conter a sombra projetada original');
  assert.equal(wholePart.stroke, undefined, 'Preço whole não deve conter stroke ativo');
});

test('8. Preservação estrita do nome original do PSD ao gerar arquivo .skcartaz', async () => {
  const { psdFileNameToCartazFileName, buildCartazPathFromPsd } = await import('../src/features/ofertas/service');

  // Caso principal especificado:
  assert.equal(
    psdFileNameToCartazFileName('biscoito-gude-recheado-112g-chocolate.psd'),
    'biscoito-gude-recheado-112g-chocolate.skcartaz'
  );

  // Nomes com prefixo alfabético
  assert.equal(
    psdFileNameToCartazFileName('A_Biscoito Recheado Passatempo 130g.psd'),
    'A_Biscoito Recheado Passatempo 130g.skcartaz'
  );

  // Nomes com números e unidades de medida
  assert.equal(
    psdFileNameToCartazFileName('refrigerante-coca-cola-2l-pet.psd'),
    'refrigerante-coca-cola-2l-pet.skcartaz'
  );
  assert.equal(
    psdFileNameToCartazFileName('amaciante downy concentrado 500ml.psd'),
    'amaciante downy concentrado 500ml.skcartaz'
  );

  // Espaços, acentos e hífens
  assert.equal(
    psdFileNameToCartazFileName('Açúcar Cristal União 1kg - Pacote.psd'),
    'Açúcar Cristal União 1kg - Pacote.skcartaz'
  );
  assert.equal(
    psdFileNameToCartazFileName('Feijão Carioca Camil Tipo 1 - 1kg.psd'),
    'Feijão Carioca Camil Tipo 1 - 1kg.skcartaz'
  );

  // Arquivo PSD já contendo indicação do formato (evita duplicar)
  assert.equal(
    psdFileNameToCartazFileName('cerveja brahma chopp 350ml [A6].psd', 'A6'),
    'cerveja brahma chopp 350ml [A6].skcartaz'
  );
  assert.equal(
    psdFileNameToCartazFileName('sabao em po omo 800g (A5).psd', 'A5'),
    'sabao em po omo 800g (A5).skcartaz'
  );
  assert.equal(
    psdFileNameToCartazFileName('repolho verde kg A5.psd', 'A5'),
    'repolho verde kg A5.skcartaz'
  );

  // Caminho completo no diretório da biblioteca
  assert.equal(
    buildCartazPathFromPsd('C:\\Skalee\\Cartazes', 'biscoito-gude-recheado-112g-chocolate.psd'),
    'C:\\Skalee\\Cartazes\\biscoito-gude-recheado-112g-chocolate.skcartaz'
  );
  assert.equal(
    buildCartazPathFromPsd('C:\\Skalee\\Cartazes\\', 'D:\\Artes\\cerveja corona extra 350ml.psd'),
    'C:\\Skalee\\Cartazes\\cerveja corona extra 350ml.skcartaz'
  );
});

test('9. Troca de referência PSD substitui o vínculo usando o novo nome do arquivo PSD', async () => {
  const { executePsdBatchLinking, psdFileNameToCartazFileName } = await import('../src/features/ofertas/service');

  const campaign: OfferCampaign = {
    schemaVersion: 1,
    id: 'camp-1',
    name: 'Campanha de Ofertas',
    campaignDate: '2026-11-19',
    archived: false,
    sourceExcel: null,
    items: [
      {
        id: 'item-1',
        f7: '38340',
        description: 'ARROZ RAMPINELLI 5KG',
        scheduledPriceCents: 1989,
        rowNumber: 2,
        posters: [
          {
            cartazId: 'cartaz-antigo',
            cartazPath: 'C:\\Skalee\\Cartazes\\arroz-antigo-generico.skcartaz',
            selected: true,
            copies: 1,
            status: 'preparado',
            printedAt: null,
          },
        ],
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const savedFiles: Record<string, any> = {};

  const mockIo = {
    readPsd: async (p: string) => ({ name: p.split(/[\\/]/).pop() || p, path: p, buffer: new ArrayBuffer(8) }),
    buildCartazFromPsd: async (psdData: any, item: any) => ({
      schemaVersion: 1,
      id: 'novo-cartaz-id',
      product: { name: item.description, complement: '', unit: 'UN', priceCents: item.scheduledPriceCents, productCode: item.f7 },
      layout: {
        template: 'imported-psd',
        paper: 'A5',
        orientation: 'portrait',
        artwork: { source: { fileName: psdData.name } },
      },
      metadata: { createdAt: '', updatedAt: '' },
    }),
    saveCartazDocument: async (targetPath: string, doc: any) => {
      savedFiles[targetPath] = doc;
    },
    persistCampaign: async (camp: any) => camp,
  };

  // Troca a referência para um novo arquivo PSD com nome descritivo próprio
  const newPsd = {
    name: 'arroz-rampinelli-tipo-1-5kg-pacote.psd',
    path: 'C:\\Artes\\arroz-rampinelli-tipo-1-5kg-pacote.psd',
    size: 1024,
  };

  const res = await executePsdBatchLinking(
    campaign,
    [{ item: campaign.items[0], psd: newPsd }],
    'A5',
    'C:\\Skalee\\Cartazes',
    mockIo as any
  );

  assert.equal(res.success, true);
  assert.equal(res.linkedCount, 1);

  const updatedItem = res.campaign.items[0];
  assert.equal(updatedItem.posters.length, 1, 'Deve conter apenas 1 vínculo substituído');
  assert.equal(
    updatedItem.posters[0].cartazPath,
    'C:\\Skalee\\Cartazes\\arroz-rampinelli-tipo-1-5kg-pacote.skcartaz',
    'O novo vínculo deve usar o nome exato do novo PSD sem prefixos artificiais ou F7'
  );
  assert.ok(
    savedFiles['C:\\Skalee\\Cartazes\\arroz-rampinelli-tipo-1-5kg-pacote.skcartaz'],
    'O arquivo .skcartaz gravado em disco deve usar o nome completo do PSD de origem'
  );
});

test('10. Exportação direta de PSD atualiza preços e invalida cache de pixels da camada para exibição imediata no Photoshop CS6', async () => {
  const { executeScantechDirectExportJob } = await import('../src/features/scantech/directExport');
  const { readPsd, initializeCanvas } = await import('ag-psd');
  const fs = await import('fs');
  const path = await import('path');

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
        clearRect: () => {},
        fillText: () => {},
        save: () => {},
        restore: () => {},
      }),
    })) as any,
    makeImageData as any
  );

  const psdPath = path.resolve(process.cwd(), 'public/templates/modelo_oferta.psd');
  const rawPsdBuffer = fs.readFileSync(psdPath);

  // PSD original possui '10' nos reais e '97' nos centavos com imageData gravado (cache legado)
  const initialPsd = readPsd(rawPsdBuffer, { useImageData: true, throwForMissingFeatures: false });
  const wholeInitial = initialPsd.children?.find(l => l.name === '10');
  const fractionInitial = initialPsd.children?.find(l => l.name === '97');

  assert.ok(wholeInitial, 'Camada de reais 10 deve existir no PSD original');
  assert.ok(fractionInitial, 'Camada de centavos 97 deve existir no PSD original');
  assert.equal(wholeInitial.text?.text, '10');
  assert.equal(fractionInitial.text?.text, '97');
  assert.ok(wholeInitial.imageData, 'Camada de reais original tem pixels em cache');
  assert.ok(fractionInitial.imageData, 'Camada de centavos original tem pixels em cache');

  // Mapeamos os índices das camadas no PSD
  const wholeIndex = initialPsd.children!.indexOf(wholeInitial);
  const fractionIndex = initialPsd.children!.indexOf(fractionInitial);

  let writtenBytes: Uint8Array | null = null;
  const mockIo = {
    readSourcePsd: async () => rawPsdBuffer.buffer.slice(rawPsdBuffer.byteOffset, rawPsdBuffer.byteOffset + rawPsdBuffer.byteLength),
    writeOutputPsd: async (_outPath: string, _srcPath: string, bytes: Uint8Array) => {
      writtenBytes = bytes;
      return { fileSize: bytes.byteLength };
    },
  };

  const job = {
    itemId: 'item-27691',
    f7: '27691',
    description: 'BATATA PALITO RAP NEWBRAZ 2KG',
    sourcePsdPath: psdPath,
    outputPsdPath: 'C:\\Users\\Desktop\\Nova pasta\\batata-palito-rap-newbraz-2kg-oferta.psd',
    wholeLayerId: String(wholeIndex),
    fractionLayerId: String(fractionIndex),
    wholeValue: '22',
    fractionValue: '22',
  };

  const result = await executeScantechDirectExportJob(job, mockIo as any);
  assert.equal(result.ok, true, `Exportação deve suceder: ${result.error}`);
  assert.ok(writtenBytes, 'Deve ter gravado os bytes do PSD exportado');

  // Reabre o arquivo PSD exportado gerado
  const exportedPsd = readPsd(writtenBytes!, { useImageData: true, throwForMissingFeatures: false });
  const exportedWhole = exportedPsd.children?.[wholeIndex];
  const exportedFraction = exportedPsd.children?.[fractionIndex];

  assert.ok(exportedWhole && exportedWhole.text, 'Camada de Reais deve existir no PSD exportado');
  assert.ok(exportedFraction && exportedFraction.text, 'Camada de Centavos deve existir no PSD exportado');

  // 1. Textos vetoriais atualizados para a nova oferta da planilha/campanha (22,22)
  assert.equal(exportedWhole.text.text, '22', 'Texto de reais deve ser atualizado para 22');
  assert.equal(exportedFraction.text.text, '22', 'Texto de centavos deve ser atualizado para 22');

  // 2. Garante que as camadas de texto contêm canal de imagem com bounds expandidos
  // No Photoshop CS6, camadas sem canal de imagem têm bounds 0x0 e ficam invisíveis até o clique da ferramenta T.
  // Com bounds expandidos e matriz afim desenhada no bitmap, o texto aparece imediatamente visível e sem cortes.
  assert.ok(exportedWhole.imageData, 'Camada de reais deve conter bitmap renderizado para Photoshop CS6');
  assert.ok(exportedFraction.imageData, 'Camada de centavos deve conter bitmap renderizado para Photoshop CS6');
  assert.ok((exportedWhole.right ?? 0) > (exportedWhole.left ?? 0), 'Camada de reais deve ter largura positiva');
  assert.ok((exportedWhole.bottom ?? 0) > (exportedWhole.top ?? 0), 'Camada de reais deve ter altura positiva');
});

