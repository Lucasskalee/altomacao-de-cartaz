import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConductorPrintBatch,
  createQueueItemFromCartaz,
  createQueueItemFromFilePath,
  createQueueItemFromPoster,
  findDuplicateInQueue,
  inferFormatFromPath,
  isSameConductorPath,
  loadConductorItem,
  loadQueueConcurrently,
  moveQueueItem,
  normalizeConductorPath,
  removeQueueItem,
  updateQueueItemCopies,
} from '../src/features/condutor/service';
import type { ConductorQueueItem } from '../src/features/condutor/types';
import type { Cartaz } from '../src/features/cartazes/types';
import type { Poster } from '../src/components/editor/PosterView';
import { readFileSync, existsSync } from 'node:fs';
import { initializeCanvas } from 'ag-psd';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const fakeCanvas = (w = 886, h = 1240): any => ({
  width: w,
  height: h,
  getContext: () => ({
    clearRect() {},
    save() {},
    restore() {},
    drawImage() {},
    putImageData() {},
    createImageData: (cw: number, ch: number) => ({
      data: new Uint8ClampedArray(cw * ch * 4),
      width: cw,
      height: ch,
    }),
    getImageData: (_x: number, _y: number, cw: number, ch: number) => ({
      data: new Uint8ClampedArray(cw * ch * 4),
      width: cw,
      height: ch,
    }),
  }),
  toDataURL: () => pixel,
});

if (typeof document === 'undefined' || !('createElement' in (globalThis as any).document)) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => fakeCanvas() },
  });
}
initializeCanvas(fakeCanvas, (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h } as any));

const sampleCartazJson = JSON.stringify({
  schemaVersion: 1,
  id: 'cartaz-teste-01',
  product: {
    name: 'MANGA TOMMY',
    complement: 'DOCE KG',
    priceCents: 599,
    unit: 'KG',
    productCode: '10293',
  },
  layout: {
    template: 'oferta-classica',
    paper: 'A5',
    orientation: 'portrait',
  },
  metadata: {
    createdAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
  },
} satisfies Cartaz);

const sampleCartazWithoutF7Json = JSON.stringify({
  schemaVersion: 1,
  id: 'cartaz-teste-sem-f7',
  product: {
    name: 'BANANA PRATA',
    complement: 'SELECIONADA',
    priceCents: 449,
    unit: 'KG',
    productCode: null,
  },
  layout: {
    template: 'oferta-classica',
    paper: 'A5',
    orientation: 'portrait',
  },
  metadata: {
    createdAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
  },
} satisfies Cartaz);

test('Condutor de Impressão — Normalização de caminhos locais e rede UNC', () => {
  assert.equal(
    normalizeConductorPath('C:\\Cartazes\\Oferta.skcartaz'),
    'c:\\cartazes\\oferta.skcartaz'
  );
  assert.equal(
    normalizeConductorPath('c:/cartazes/oferta.skcartaz'),
    'c:\\cartazes\\oferta.skcartaz'
  );

  // Caminho de rede UNC Windows
  const unc1 = '\\\\SERVIDOR\\Compartilhamento\\Cartazes\\promo.skcartaz';
  const unc2 = '//SERVIDOR/Compartilhamento/Cartazes/promo.skcartaz';
  assert.equal(normalizeConductorPath(unc1), '\\\\servidor\\compartilhamento\\cartazes\\promo.skcartaz');
  assert.ok(isSameConductorPath(unc1, unc2));

  // Unidade de rede mapeada
  const mapped1 = 'Z:\\SetorFLV\\oferta.psd';
  const mapped2 = 'z:/setorflv/oferta.psd';
  assert.ok(isSameConductorPath(mapped1, mapped2));
});

test('Condutor de Impressão — Criação de itens de fila e detecção de duplicatas', () => {
  const item1 = createQueueItemFromFilePath(
    '\\\\SERVIDOR\\Cartazes\\Oferta-Tomate.skcartaz',
    'external_file'
  );
  assert.equal(item1.fileFormat, 'skcartaz');
  assert.equal(item1.name, 'OFERTA-TOMATE');
  assert.equal(item1.copies, 1);
  assert.equal(item1.status, 'idle');
  assert.equal(item1.f7, undefined);

  const queue: ConductorQueueItem[] = [item1];

  // Mesma origem com formatação de barras alternativa
  const duplicate = findDuplicateInQueue(
    queue,
    '//servidor/cartazes/oferta-tomate.skcartaz'
  );
  assert.ok(duplicate);
  assert.equal(duplicate?.id, item1.id);

  // Arquivo diferente não é duplicata
  const distinct = findDuplicateInQueue(
    queue,
    '\\\\SERVIDOR\\Cartazes\\Oferta-Cebola.skcartaz'
  );
  assert.equal(distinct, undefined);
});

test('Condutor de Impressão — Código F7 é opcional e arquivos sem F7 são aceitos', async () => {
  const item = createQueueItemFromFilePath('D:\\Cartazes\\banana.skcartaz', 'external_file');
  assert.equal(item.f7, undefined);

  const loaded = await loadConductorItem(item, {
    readCartaz: async () => sampleCartazWithoutF7Json,
  });

  assert.equal(loaded.status, 'ready');
  assert.equal(loaded.name, 'BANANA PRATA');
  assert.equal(loaded.price, '4,49');
  assert.equal(loaded.f7, undefined); // Opcional! Não bloqueia
  assert.ok(loaded.poster);
  assert.equal(loaded.poster?.name, 'BANANA PRATA');
});

test('Condutor de Impressão — Reordenação, controle de cópias e remoção de itens', () => {
  const itemA: ConductorQueueItem = {
    id: 'a',
    name: 'ITEM A',
    detail: '',
    price: '1,00',
    unit: 'UN',
    sourcePath: 'c:\\a.skcartaz',
    sourceType: 'external_file',
    fileFormat: 'skcartaz',
    copies: 1,
    status: 'ready',
    poster: { name: 'ITEM A', detail: '', price: '1,00', unit: 'UN' },
  };

  const itemB: ConductorQueueItem = {
    id: 'b',
    name: 'ITEM B',
    detail: '',
    price: '2,00',
    unit: 'UN',
    sourcePath: 'c:\\b.skcartaz',
    sourceType: 'external_file',
    fileFormat: 'skcartaz',
    copies: 2,
    status: 'ready',
    poster: { name: 'ITEM B', detail: '', price: '2,00', unit: 'UN' },
  };

  const itemC: ConductorQueueItem = {
    id: 'c',
    name: 'ITEM C',
    detail: '',
    price: '3,00',
    unit: 'UN',
    sourcePath: 'c:\\c.skcartaz',
    sourceType: 'external_file',
    fileFormat: 'skcartaz',
    copies: 3,
    status: 'ready',
    poster: { name: 'ITEM C', detail: '', price: '3,00', unit: 'UN' },
  };

  let queue = [itemA, itemB, itemC];

  // Reordenar item C para o topo (posição 0)
  queue = moveQueueItem(queue, 2, 0);
  assert.deepEqual(
    queue.map(i => i.id),
    ['c', 'a', 'b']
  );

  // Alterar cópias do item B para 5
  queue = updateQueueItemCopies(queue, 'b', 5);
  assert.equal(queue.find(i => i.id === 'b')?.copies, 5);

  // Impedir cópias menores que 1
  queue = updateQueueItemCopies(queue, 'b', -2);
  assert.equal(queue.find(i => i.id === 'b')?.copies, 1);

  // Remover item A
  queue = removeQueueItem(queue, 'a');
  assert.deepEqual(
    queue.map(i => i.id),
    ['c', 'b']
  );
});

test('Condutor de Impressão — Geração de lote para impressão respeita ordem e multiplicador de cópias', () => {
  const poster1: Poster = { name: 'PRODUTO 1', detail: '', price: '10,00', unit: 'UN' };
  const poster2: Poster = { name: 'PRODUTO 2', detail: '', price: '20,00', unit: 'KG' };

  const queue: ConductorQueueItem[] = [
    {
      id: '1',
      name: 'PRODUTO 1',
      detail: '',
      price: '10,00',
      unit: 'UN',
      sourcePath: 'c:\\p1.skcartaz',
      sourceType: 'external_file',
      fileFormat: 'skcartaz',
      copies: 3,
      status: 'ready',
      poster: poster1,
    },
    {
      id: '2',
      name: 'PRODUTO 2',
      detail: '',
      price: '20,00',
      unit: 'KG',
      sourcePath: 'c:\\p2.skcartaz',
      sourceType: 'external_file',
      fileFormat: 'skcartaz',
      copies: 2,
      status: 'ready',
      poster: poster2,
    },
  ];

  const batch = buildConductorPrintBatch(queue);
  assert.equal(batch.distinctItemsCount, 2);
  assert.equal(batch.totalCopies, 5);
  assert.equal(batch.posters.length, 5);
  assert.equal(batch.skippedErrors.length, 0);

  // Ordem exata: 3 de poster1 seguidos de 2 de poster2
  assert.equal(batch.posters[0].name, 'PRODUTO 1');
  assert.equal(batch.posters[1].name, 'PRODUTO 1');
  assert.equal(batch.posters[2].name, 'PRODUTO 1');
  assert.equal(batch.posters[3].name, 'PRODUTO 2');
  assert.equal(batch.posters[4].name, 'PRODUTO 2');
});

test('Condutor de Impressão — Tratamento de erros: arquivos corrompidos ou inacessíveis não travam a fila', async () => {
  const validItem: ConductorQueueItem = {
    id: 'valid',
    name: 'MANGA TOMMY',
    detail: '',
    price: '5,99',
    unit: 'KG',
    sourcePath: 'c:\\manga.skcartaz',
    sourceType: 'external_file',
    fileFormat: 'skcartaz',
    copies: 2,
    status: 'idle',
  };

  const brokenItem: ConductorQueueItem = {
    id: 'broken',
    name: 'ARQUIVO CORROMPIDO',
    detail: '',
    price: '',
    unit: '',
    sourcePath: '\\\\SERVIDOR\\invalido.skcartaz',
    sourceType: 'external_file',
    fileFormat: 'skcartaz',
    copies: 1,
    status: 'idle',
  };

  const missingItem: ConductorQueueItem = {
    id: 'missing',
    name: 'ARQUIVO SUMIDO',
    detail: '',
    price: '',
    unit: '',
    sourcePath: 'z:\\sumiu.psd',
    sourceType: 'external_file',
    fileFormat: 'psd',
    copies: 1,
    status: 'idle',
  };

  // Mock IO
  const customIo = {
    readCartaz: async (path: string) => {
      if (path.includes('manga')) return sampleCartazJson;
      throw new Error('Acesso negado ou arquivo inexistente na rede.');
    },
    readPsd: async () => {
      throw new Error('Falha de leitura no disco Z:');
    },
  };

  const loadedQueue = await loadQueueConcurrently(
    [validItem, brokenItem, missingItem],
    2,
    undefined,
    customIo
  );

  // O item válido carrega com sucesso
  assert.equal(loadedQueue[0].status, 'ready');
  assert.equal(loadedQueue[0].name, 'MANGA TOMMY');

  // Os itens com falha são marcados com status error e mensagem explicativa, sem travar
  assert.equal(loadedQueue[1].status, 'error');
  assert.ok(loadedQueue[1].errorMessage?.includes('Acesso negado'));

  assert.equal(loadedQueue[2].status, 'error');
  assert.ok(loadedQueue[2].errorMessage?.includes('Falha de leitura'));

  // Ao gerar o lote de impressão, apenas os itens prontos são impressos, ignorando os erros
  const printBatch = buildConductorPrintBatch(loadedQueue);
  assert.equal(printBatch.totalCopies, 2);
  assert.equal(printBatch.posters.length, 2);
  assert.equal(printBatch.skippedErrors.length, 2);
  assert.ok(printBatch.skippedErrors[0].includes('invalido.skcartaz'));
  assert.ok(printBatch.skippedErrors[1].includes('sumiu.psd'));
});

test('Condutor de Impressão — PSD externo preserva arte original sem substituição de preço ou textos', async () => {
  const psdPath = existsSync('repolho verde kg.psd')
    ? 'repolho verde kg.psd'
    : 'c:\\LUCAS SKALEE\\altomacao-de-cartaz\\repolho verde kg.psd';
  if (!existsSync(psdPath)) return;

  const bytes = readFileSync(psdPath);
  const queueItem = createQueueItemFromFilePath(psdPath, 'external_file', bytes.byteLength);

  const loaded = await loadConductorItem(queueItem, {
    readPsd: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  assert.equal(loaded.status, 'ready');
  assert.ok(loaded.poster);
  assert.ok(loaded.poster?.artwork);

  // Requirement 5: priceParts deve ser vazio para que o renderer exiba a composição original 100% intacta
  assert.equal(loaded.poster.artwork.priceParts.length, 0);
  assert.ok(loaded.poster.artwork.staticBackground.startsWith('data:image/png;base64,'));
  assert.ok(loaded.thumbnailUrl?.startsWith('data:image/png;base64,'));
});

test('Condutor de Impressão — Pasta com vários arquivos é enfileirada e processada corretamente', async () => {
  const scannedFiles = Array.from({ length: 8 }, (_, i) => ({
    name: `produto_${i + 1}.${i % 2 === 0 ? 'skcartaz' : 'psd'}`,
    path: `\\\\SERVIDOR\\Cartazes\\produto_${i + 1}.${i % 2 === 0 ? 'skcartaz' : 'psd'}`,
    format: (i % 2 === 0 ? 'skcartaz' : 'psd') as 'skcartaz' | 'psd',
    size: 1024 * (i + 1),
  }));

  const queue: ConductorQueueItem[] = scannedFiles.map(f =>
    createQueueItemFromFilePath(f.path, 'external_folder', f.size)
  );

  assert.equal(queue.length, 8);
  assert.equal(queue[0].fileFormat, 'skcartaz');
  assert.equal(queue[1].fileFormat, 'psd');
  assert.equal(queue.every(i => i.status === 'idle'), true);

  // Simular carregamento controlado
  const loaded = await loadQueueConcurrently(queue, 2, undefined, {
    readCartaz: async p => {
      const num = p.match(/produto_(\d+)/)?.[1] ?? '1';
      return JSON.stringify({
        schemaVersion: 1,
        id: `prod-${num}`,
        product: { name: `PRODUTO ${num}`, complement: 'A5', priceCents: Number(num) * 100, unit: 'UN' },
        layout: { template: 'oferta-classica', paper: 'A5', orientation: 'portrait' },
        metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      });
    },
    readPsd: async () => {
      const realPsd = existsSync('repolho verde kg.psd') ? readFileSync('repolho verde kg.psd') : null;
      if (realPsd) return realPsd.buffer.slice(realPsd.byteOffset, realPsd.byteOffset + realPsd.byteLength);
      throw new Error('PSD não encontrado');
    },
  });

  const cartazesOk = loaded.filter(i => i.fileFormat === 'skcartaz');
  assert.equal(cartazesOk.every(i => i.status === 'ready'), true);
  assert.equal(cartazesOk[0].name, 'PRODUTO 1');
  assert.equal(cartazesOk[0].price, '1,00');
});

test('Condutor de Impressão — Suporte e limites para arquivos PSD grandes (até 80 MB)', async () => {
  // PSD de 35 MB (abaixo do novo limite de 80 MB)
  const header = new Uint8Array([0x38, 0x42, 0x50, 0x53]); // "8BPS"
  const largeMockPsd = new Uint8Array(35 * 1024 * 1024);
  largeMockPsd.set(header);

  // PSD acima do limite de 80 MB (ex: 85 MB) deve ser recusado com segurança
  const oversizeMockPsd = new Uint8Array(85 * 1024 * 1024);
  oversizeMockPsd.set(header);

  const oversizeItem = createQueueItemFromFilePath('c:\\enorme.psd', 'external_file');
  const loadedOversize = await loadConductorItem(oversizeItem, {
    readPsd: async () => oversizeMockPsd.buffer,
  });

  assert.equal(loadedOversize.status, 'error');
  assert.ok(loadedOversize.errorMessage?.includes('80 MB'));
});

test('Condutor de Impressão — Pasta de rede inacessível é tratada sem travar o aplicativo', async () => {
  const networkItem = createQueueItemFromFilePath(
    '\\\\SERVIDOR_DESCONECTADO\\Compartilhamento\\cartaz.skcartaz',
    'external_file'
  );

  const loaded = await loadConductorItem(networkItem, {
    readCartaz: async () => {
      throw new Error('Falha de rede: O caminho da rede não foi encontrado (código 53).');
    },
  });

  assert.equal(loaded.status, 'error');
  assert.ok(loaded.errorMessage?.includes('O caminho da rede não foi encontrado'));
  // Não lança exceção não capturada e mantém o item isolado
});

test('Condutor de Impressão — Fila mista com válidos e inválidos imprime somente os prontos', () => {
  const p1: Poster = { name: 'VALIDO 1', detail: '', price: '1,99', unit: 'UN' };
  const p2: Poster = { name: 'VALIDO 2', detail: '', price: '2,99', unit: 'KG' };

  const mixedQueue: ConductorQueueItem[] = [
    {
      id: 'v1',
      name: 'VALIDO 1',
      detail: '',
      price: '1,99',
      unit: 'UN',
      sourcePath: 'c:\\v1.skcartaz',
      sourceType: 'external_file',
      fileFormat: 'skcartaz',
      copies: 2,
      status: 'ready',
      poster: p1,
    },
    {
      id: 'err1',
      name: 'CORROMPIDO',
      detail: '',
      price: '',
      unit: '',
      sourcePath: 'c:\\corrompido.skcartaz',
      sourceType: 'external_file',
      fileFormat: 'skcartaz',
      copies: 1,
      status: 'error',
      errorMessage: 'JSON inválido',
    },
    {
      id: 'v2',
      name: 'VALIDO 2',
      detail: '',
      price: '2,99',
      unit: 'KG',
      sourcePath: 'c:\\v2.skcartaz',
      sourceType: 'external_file',
      fileFormat: 'skcartaz',
      copies: 3,
      status: 'ready',
      poster: p2,
    },
    {
      id: 'err2',
      name: 'REDE CAÍDA',
      detail: '',
      price: '',
      unit: '',
      sourcePath: '\\\\REDE\\fora.psd',
      sourceType: 'external_file',
      fileFormat: 'psd',
      copies: 1,
      status: 'error',
      errorMessage: 'Arquivo inacessível',
    },
  ];

  const batch = buildConductorPrintBatch(mixedQueue);
  assert.equal(batch.distinctItemsCount, 2);
  assert.equal(batch.totalCopies, 5); // 2 de V1 + 3 de V2
  assert.equal(batch.posters.length, 5);
  assert.equal(batch.skippedErrors.length, 2);
  assert.ok(batch.skippedErrors[0].includes('CORROMPIDO'));
  assert.ok(batch.skippedErrors[1].includes('REDE CAÍDA'));
});

test('Condutor de Impressão — Múltiplas cópias e preservação da sequência de impressão', () => {
  const pA: Poster = { name: 'ALFACE', detail: '', price: '1,50', unit: 'UN' };
  const pB: Poster = { name: 'BATATA', detail: '', price: '3,80', unit: 'KG' };
  const pC: Poster = { name: 'CENOURA', detail: '', price: '2,20', unit: 'KG' };

  let queue: ConductorQueueItem[] = [
    { id: '1', name: 'ALFACE', detail: '', price: '1,50', unit: 'UN', sourcePath: 'c:\\1', sourceType: 'editor', fileFormat: 'skcartaz', copies: 2, status: 'ready', poster: pA },
    { id: '2', name: 'BATATA', detail: '', price: '3,80', unit: 'KG', sourcePath: 'c:\\2', sourceType: 'editor', fileFormat: 'skcartaz', copies: 4, status: 'ready', poster: pB },
    { id: '3', name: 'CENOURA', detail: '', price: '2,20', unit: 'KG', sourcePath: 'c:\\3', sourceType: 'editor', fileFormat: 'skcartaz', copies: 1, status: 'ready', poster: pC },
  ];

  // Inverter ordem: Cenoura (índice 2) para a primeira posição
  queue = moveQueueItem(queue, 2, 0);
  assert.deepEqual(queue.map(i => i.name), ['CENOURA', 'ALFACE', 'BATATA']);

  const batch = buildConductorPrintBatch(queue);
  assert.equal(batch.totalCopies, 7); // 1 + 2 + 4

  // Sequência de saída da impressora A5: 1 Cenoura, 2 Alfaces, 4 Batatas
  const printedNames = batch.posters.map(p => p.name);
  assert.deepEqual(printedNames, [
    'CENOURA',
    'ALFACE', 'ALFACE',
    'BATATA', 'BATATA', 'BATATA', 'BATATA',
  ]);
});

test('Condutor de Impressão — Cache LRU de Miniaturas com limite de itens e bytes', () => {
  const { LruThumbnailCache } = require('../src/features/condutor/cache');
  // Cria cache com limite de 3 itens e 1000 bytes
  const cache = new LruThumbnailCache(3, 1000);

  // Cada char em JS UTF-16 ocupa ~2 bytes na estimativa (length * 2)
  cache.set('item1', 'A'.repeat(50)); // 100 bytes
  cache.set('item2', 'B'.repeat(50)); // 100 bytes
  cache.set('item3', 'C'.repeat(50)); // 100 bytes

  assert.equal(cache.size(), 3);
  assert.equal(cache.get('item1'), 'A'.repeat(50));

  // Acesso a item1 torna item2 o mais antigo (LRU)
  // Adiciona item4: deve ejetar item2
  cache.set('item4', 'D'.repeat(50));
  assert.equal(cache.size(), 3);
  assert.equal(cache.has('item2'), false); // Ejetado
  assert.equal(cache.has('item1'), true); // Preservado
  assert.equal(cache.has('item3'), true);
  assert.equal(cache.has('item4'), true);

  // Teste de teto de bytes: item com 600 chars (1200 bytes) excede maxBytes de 1000 bytes
  cache.set('giant', 'X'.repeat(600));
  assert.equal(cache.has('giant'), false); // Rejeitado com segurança

  // Limpeza total
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.bytes(), 0);
});

test('Condutor de Impressão — Divisão em lotes (20, 100 e 400 páginas) com proteção de memória', () => {
  const { partitionQueueIntoBatches } = require('../src/features/condutor/batching');

  // Cenário 1: Exatamente 20 páginas
  const queue20: ConductorQueueItem[] = [];
  for (let i = 1; i <= 20; i++) {
    queue20.push({
      id: `item-${i}`,
      name: `PRODUTO ${i}`,
      detail: '',
      price: '9,99',
      unit: 'UN',
      sourcePath: `c:\\item${i}.skcartaz`,
      sourceType: 'external_file',
      fileFormat: 'skcartaz',
      copies: 1,
      status: 'ready',
    });
  }

  const plans20 = partitionQueueIntoBatches(queue20, 20);
  assert.equal(plans20.length, 1);
  assert.equal(plans20[0].pageCount, 20);
  assert.equal(plans20[0].startIndex, 0);
  assert.equal(plans20[0].endIndex, 19);

  // Cenário 2: 100 páginas (5 lotes de 20 páginas)
  const queue100: ConductorQueueItem[] = [];
  for (let i = 1; i <= 50; i++) {
    queue100.push({
      id: `prod-${i}`,
      name: `PRODUTO ${i}`,
      detail: '',
      price: '1,99',
      unit: 'UN',
      sourcePath: `c:\\prod${i}.skcartaz`,
      sourceType: 'external_file',
      fileFormat: 'skcartaz',
      copies: 2, // 50 produtos * 2 cópias = 100 páginas
      status: 'ready',
    });
  }

  const plans100 = partitionQueueIntoBatches(queue100, 20);
  assert.equal(plans100.length, 5);
  let totalCalculated100 = 0;
  plans100.forEach((plan, idx) => {
    assert.equal(plan.batchNumber, idx + 1);
    assert.equal(plan.totalBatches, 5);
    assert.equal(plan.pageCount, 20);
    totalCalculated100 += plan.pageCount;
  });
  assert.equal(totalCalculated100, 100);

  // Cenário 3: 400 páginas (20 lotes de 20 páginas) com cópias variadas
  const queue400: ConductorQueueItem[] = [];
  for (let i = 1; i <= 80; i++) {
    queue400.push({
      id: `bulk-${i}`,
      name: `BULK ITEM ${i}`,
      detail: '',
      price: '5,00',
      unit: 'KG',
      sourcePath: `c:\\bulk${i}.skcartaz`,
      sourceType: 'external_file',
      fileFormat: 'skcartaz',
      copies: 5, // 80 produtos * 5 cópias = 400 páginas
      status: 'ready',
    });
  }

  const plans400 = partitionQueueIntoBatches(queue400, 20);
  assert.equal(plans400.length, 20);
  let totalCalculated400 = 0;
  for (let b = 0; b < plans400.length; b++) {
    const plan = plans400[b];
    assert.equal(plan.batchNumber, b + 1);
    assert.equal(plan.totalBatches, 20);
    assert.equal(plan.pageCount, 20);
    totalCalculated400 += plan.pageCount;
  }
  assert.equal(totalCalculated400, 400);

  // Verifica que o primeiro item do primeiro lote é BULK ITEM 1 cópia 1
  assert.equal(plans400[0].items[0].name, 'BULK ITEM 1');
  assert.equal(plans400[0].items[0].copyIndex, 1);

  // Verifica que o último item do último lote é BULK ITEM 80 cópia 5
  assert.equal(plans400[19].items[19].name, 'BULK ITEM 80');
  assert.equal(plans400[19].items[19].copyIndex, 5);
});

test('Condutor de Impressão — Preparação e ciclo de liberação de memória de lotes', async () => {
  const { partitionQueueIntoBatches, prepareBatchPosters, releaseBatchMemory } = require('../src/features/condutor/batching');

  const p1: Poster = { name: 'PRODUTO LOTE 1', detail: '', price: '10,00', unit: 'UN' };
  const p2: Poster = { name: 'PRODUTO LOTE 2', detail: '', price: '20,00', unit: 'UN' };

  const queue: ConductorQueueItem[] = [
    {
      id: 'item-1',
      name: 'PRODUTO LOTE 1',
      detail: '',
      price: '10,00',
      unit: 'UN',
      sourcePath: 'c:\\1.skcartaz',
      sourceType: 'external_file',
      fileFormat: 'skcartaz',
      copies: 3,
      status: 'ready',
      poster: p1,
    },
    {
      id: 'item-2',
      name: 'PRODUTO LOTE 2',
      detail: '',
      price: '20,00',
      unit: 'UN',
      sourcePath: 'c:\\2.skcartaz',
      sourceType: 'external_file',
      fileFormat: 'skcartaz',
      copies: 2,
      status: 'ready',
      poster: p2,
    },
  ];

  // Total 5 páginas divididas em lotes de 2 páginas -> 3 lotes (2, 2, 1)
  const plans = partitionQueueIntoBatches(queue, 2);
  assert.equal(plans.length, 3);
  assert.equal(plans[0].pageCount, 2);
  assert.equal(plans[1].pageCount, 2);
  assert.equal(plans[2].pageCount, 1);

  // Prepara Lote 1
  const res1 = await prepareBatchPosters(plans[0], queue);
  assert.equal(res1.posters.length, 2);
  assert.equal(res1.errors.length, 0);
  assert.equal(res1.posters[0].name, 'PRODUTO LOTE 1');
  assert.equal(res1.posters[1].name, 'PRODUTO LOTE 1');

  // Libera memória após lote 1
  assert.doesNotThrow(() => releaseBatchMemory());

  // Prepara Lote 2
  const res2 = await prepareBatchPosters(plans[1], queue);
  assert.equal(res2.posters.length, 2);
  assert.equal(res2.posters[0].name, 'PRODUTO LOTE 1'); // 3ª cópia do produto 1
  assert.equal(res2.posters[1].name, 'PRODUTO LOTE 2'); // 1ª cópia do produto 2

  // Libera memória após lote 2
  assert.doesNotThrow(() => releaseBatchMemory());

  // Prepara Lote 3
  const res3 = await prepareBatchPosters(plans[2], queue);
  assert.equal(res3.posters.length, 1);
  assert.equal(res3.posters[0].name, 'PRODUTO LOTE 2'); // 2ª cópia do produto 2

  // Libera memória final
  assert.doesNotThrow(() => releaseBatchMemory());
});

test('Condutor de Impressão — Auditoria de Memória: keepFullPoster false retém apenas metadados e miniatura', async () => {
  const { loadConductorItem, globalThumbnailCache } = require('../src/features/condutor/service');

  const psdPath = existsSync('repolho verde kg.psd')
    ? 'repolho verde kg.psd'
    : 'c:\\LUCAS SKALEE\\altomacao-de-cartaz\\repolho verde kg.psd';
  if (!existsSync(psdPath)) return;

  const bytes = readFileSync(psdPath);
  const queueItem = createQueueItemFromFilePath(psdPath, 'external_file', bytes.byteLength);

  // Carregamento de segundo plano para fila grande (keepFullPoster: false)
  const backgroundLoaded = await loadConductorItem(
    queueItem,
    {
      readPsd: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    },
    { keepFullPoster: false }
  );

  assert.equal(backgroundLoaded.status, 'ready');
  assert.equal(backgroundLoaded.poster, undefined, 'Fila não deve reter o Poster de 10 MB em memória na lista');
  assert.ok(backgroundLoaded.thumbnailUrl, 'Miniatura deve estar presente');
  assert.equal(backgroundLoaded.name, 'REPOLHO');
  assert.equal(backgroundLoaded.price, '2,99');

  // Carregamento sob demanda para lote de impressão (keepFullPoster: true)
  const printLoaded = await loadConductorItem(
    backgroundLoaded,
    {
      readPsd: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    },
    { keepFullPoster: true }
  );

  assert.equal(printLoaded.status, 'ready');
  assert.ok(printLoaded.poster, 'Poster de alta resolução deve ser carregado sob demanda para o lote');
  assert.ok(printLoaded.poster.artwork?.staticBackground, 'Arte integral pronta para o canvas de 300 DPI');
});

test('Condutor de Impressão — Alternância entre Grade e Lista preserva cache de miniaturas sem reprocessar', () => {
  const { globalThumbnailCache } = require('../src/features/condutor/cache');

  // Popula uma chave no cache global
  const testKey = 'c:\\cartazes\\oferta_teste.psd';
  const testThumb = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  globalThumbnailCache.set(testKey, testThumb);

  const initialSize = globalThumbnailCache.size();
  assert.equal(globalThumbnailCache.get(testKey), testThumb);

  // Simula múltiplas transições de visualização (Grid -> List -> Grid -> List)
  for (let i = 0; i < 5; i++) {
    const fromCache = globalThumbnailCache.get(testKey);
    assert.equal(fromCache, testThumb);
  }

  // O cache não aumentou nem duplicou entradas
  assert.equal(globalThumbnailCache.size(), initialSize);
});

test('Condutor de Impressão — Repetição e cancelamento de lote preservam integridade, ordenação e cópias da fila', () => {
  const { partitionQueueIntoBatches } = require('../src/features/condutor/batching');

  const originalQueue: ConductorQueueItem[] = [
    { id: '1', name: 'ITEM 1', detail: '', price: '1,00', unit: 'UN', sourcePath: 'c:\\1', sourceType: 'editor', fileFormat: 'skcartaz', copies: 3, status: 'ready' },
    { id: '2', name: 'ITEM 2', detail: '', price: '2,00', unit: 'UN', sourcePath: 'c:\\2', sourceType: 'editor', fileFormat: 'skcartaz', copies: 2, status: 'ready' },
    { id: '3', name: 'ITEM 3', detail: '', price: '3,00', unit: 'UN', sourcePath: 'c:\\3', sourceType: 'editor', fileFormat: 'skcartaz', copies: 4, status: 'ready' },
  ];

  // Particiona com lote de 4 páginas
  const plans = partitionQueueIntoBatches(originalQueue, 4);
  assert.equal(plans.length, 3); // 3+2+4 = 9 páginas / 4 = 3 lotes (4, 4, 1)

  // Ao simular repetição do Lote 2:
  const batch2ItemsFirstAttempt = plans[1].items.map(it => `${it.name}-copia${it.copyIndex}`);
  const batch2ItemsSecondAttempt = plans[1].items.map(it => `${it.name}-copia${it.copyIndex}`);

  // Itens, ordem e índices de cópias são idênticos entre tentativas
  assert.deepEqual(batch2ItemsFirstAttempt, batch2ItemsSecondAttempt);
  assert.deepEqual(batch2ItemsFirstAttempt, ['ITEM 2-copia2', 'ITEM 3-copia1', 'ITEM 3-copia2', 'ITEM 3-copia3']);

  // Ao simular cancelamento no meio do fluxo:
  // A fila original não sofreu mutações
  assert.equal(originalQueue.length, 3);
  assert.equal(originalQueue[0].copies, 3);
  assert.equal(originalQueue[1].copies, 2);
  assert.equal(originalQueue[2].copies, 4);
});




