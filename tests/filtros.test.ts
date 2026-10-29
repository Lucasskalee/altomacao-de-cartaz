import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSortConductorQueue, hasActiveFilters } from '../src/features/filtros/service';
import { INITIAL_FILTER_STATE, type PosterFilterState } from '../src/features/filtros/types';
import type { ConductorQueueItem } from '../src/features/condutor/types';

function mockQueueItem(overrides: Partial<ConductorQueueItem>): ConductorQueueItem {
  return {
    id: `item_${Math.random()}`,
    sourcePath: 'C:\\Cartazes\\item.psd',
    name: 'PRODUTO TESTE',
    detail: 'DETALHE',
    price: '9,99',
    f7: '001234',
    copies: 1,
    status: 'ready',
    paperFormat: 'A5',
    orientation: 'portrait',
    createdAt: Date.now(),
    ...overrides,
  };
}

test('Filtros: detecção de filtros ativos e retorno ao estado padrão', () => {
  assert.equal(hasActiveFilters(INITIAL_FILTER_STATE), false);

  assert.equal(hasActiveFilters({ ...INITIAL_FILTER_STATE, f7Query: '123' }), true);
  assert.equal(hasActiveFilters({ ...INITIAL_FILTER_STATE, descQuery: 'repolho' }), true);
  assert.equal(hasActiveFilters({ ...INITIAL_FILTER_STATE, format: 'A4' }), true);
  assert.equal(hasActiveFilters({ ...INITIAL_FILTER_STATE, createdDateFilter: 'today' }), true);
  assert.equal(hasActiveFilters({ ...INITIAL_FILTER_STATE, printedDateFilter: 'never' }), true);
  assert.equal(hasActiveFilters({ ...INITIAL_FILTER_STATE, sort: 'name_asc' }), true);
});

test('Filtros: pesquisa por código F7 e descrição do produto', () => {
  const items: ConductorQueueItem[] = [
    mockQueueItem({ name: 'REPOLHO VERDE', detail: 'KG', f7: '001245' }),
    mockQueueItem({ name: 'CERVEJA CORONA', detail: 'LATA 350ML', f7: '0025037' }),
    mockQueueItem({ name: 'ARROZ RAMPINELLI', detail: '5KG', f7: '0038340' }),
    mockQueueItem({ name: 'MAÇÃ GALA', detail: 'KG', f7: null }),
  ];

  // Busca por F7 exato ou parcial
  const f7Result = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, f7Query: '25037' });
  assert.equal(f7Result.length, 1);
  assert.equal(f7Result[0].name, 'CERVEJA CORONA');

  // Busca por descrição/nome
  const descResult = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, descQuery: 'repolho' });
  assert.equal(descResult.length, 1);
  assert.equal(descResult[0].name, 'REPOLHO VERDE');

  // Busca por detalhe
  const detailResult = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, descQuery: '350ml' });
  assert.equal(detailResult.length, 1);
  assert.equal(detailResult[0].name, 'CERVEJA CORONA');
});

test('Filtros: filtro por formato de papel (A6, A5, A4, A3, Expositor A3 2x2, custom)', () => {
  const items: ConductorQueueItem[] = [
    mockQueueItem({ name: 'CARTAZ A6', paperFormat: 'A6' }),
    mockQueueItem({ name: 'CARTAZ A5', paperFormat: 'A5' }),
    mockQueueItem({ name: 'CARTAZ A4', paperFormat: 'A4' }),
    mockQueueItem({ name: 'CARTAZ A3', paperFormat: 'A3' }),
    mockQueueItem({ name: 'CARTAZ EXPOSITOR', paperFormat: 'expositor-a3-2x2' }),
    mockQueueItem({ name: 'CARTAZ CUSTOM', paperFormat: 'custom' }),
  ];

  const a6s = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, format: 'A6' });
  assert.equal(a6s.length, 1);
  assert.equal(a6s[0].name, 'CARTAZ A6');

  const a5s = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, format: 'A5' });
  assert.equal(a5s.length, 1);
  assert.equal(a5s[0].name, 'CARTAZ A5');

  const a4s = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, format: 'A4' });
  assert.equal(a4s.length, 1);
  assert.equal(a4s[0].name, 'CARTAZ A4');

  const a3s = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, format: 'A3' });
  assert.equal(a3s.length, 1);
  assert.equal(a3s[0].name, 'CARTAZ A3');

  const expositors = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, format: 'expositor-a3-2x2' });
  assert.equal(expositors.length, 1);
  assert.equal(expositors[0].name, 'CARTAZ EXPOSITOR');
});

test('Filtros: desempenho com 500 cartazes no Condutor de Impressão', () => {
  const items: ConductorQueueItem[] = Array.from({ length: 500 }, (_, i) =>
    mockQueueItem({
      name: `PRODUTO ${String(i).padStart(3, '0')}`,
      f7: String(10000 + i),
      createdAt: 1000 + i,
      paperFormat: i % 5 === 0 ? 'expositor-a3-2x2' : i % 4 === 0 ? 'A3' : i % 3 === 0 ? 'A4' : i % 2 === 0 ? 'A6' : 'A5',
    })
  );

  const t0 = performance.now();
  // Filtro simultâneo de texto e formato + ordenação alfabética
  const result = filterAndSortConductorQueue(items, {
    ...INITIAL_FILTER_STATE,
    descQuery: 'PRODUTO 1',
    format: 'A5',
    sort: 'name_desc',
  });
  const elapsed = performance.now() - t0;

  assert.ok(elapsed < 100, `Operação deve ser rápida (< 100ms), levou ${elapsed.toFixed(2)}ms`);
  assert.ok(result.length > 0);
  assert.ok(result.every(item => item.name.includes('PRODUTO 1') && item.paperFormat === 'A5'));
  // Ordem decrescente
  for (let i = 0; i < result.length - 1; i++) {
    assert.ok(result[i].name.localeCompare(result[i + 1].name) >= 0);
  }
});

test('Filtros: ordenação alfabética (A-Z, Z-A) e temporal sem modificar ordem física original da fila', () => {
  const items: ConductorQueueItem[] = [
    mockQueueItem({ name: 'C - COCA COLA', createdAt: 100 }),
    mockQueueItem({ name: 'A - ARROZ', createdAt: 300 }),
    mockQueueItem({ name: 'B - BANANA', createdAt: 200 }),
  ];

  // A-Z
  const az = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, sort: 'name_asc' });
  assert.equal(az[0].name, 'A - ARROZ');
  assert.equal(az[1].name, 'B - BANANA');
  assert.equal(az[2].name, 'C - COCA COLA');

  // Z-A
  const za = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, sort: 'name_desc' });
  assert.equal(za[0].name, 'C - COCA COLA');
  assert.equal(za[1].name, 'B - BANANA');
  assert.equal(za[2].name, 'A - ARROZ');

  // Mais recentes
  const recent = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, sort: 'date_desc' });
  assert.equal(recent[0].name, 'A - ARROZ'); // 300 ms

  // Mais antigos
  const oldest = filterAndSortConductorQueue(items, { ...INITIAL_FILTER_STATE, sort: 'date_asc' });
  assert.equal(oldest[0].name, 'C - COCA COLA'); // 100 ms

  // A lista original física NÃO foi modificada!
  assert.equal(items[0].name, 'C - COCA COLA');
  assert.equal(items[1].name, 'A - ARROZ');
  assert.equal(items[2].name, 'B - BANANA');
});
