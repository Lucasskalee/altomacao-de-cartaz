import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPrintHistory,
  savePrintHistory,
  addPrintHistoryEntries,
  updatePrintHistoryStatus,
  clearPrintHistory,
  filterPrintHistory,
  getLatestPrintMap,
} from '../src/features/history/service';
import type { PrintHistoryEntry } from '../src/features/history/types';

test('Histórico de Impressão: registro, ciclo de status (requested -> sent -> confirmed) e persistência', () => {
  clearPrintHistory();
  assert.equal(getPrintHistory().length, 0);

  // 1. Adicionar novos registros
  const added = addPrintHistoryEntries([
    {
      productName: 'ARROZ TIPO 1 5KG',
      f7: '0038340',
      formatLabel: 'A5 Vertical (148 × 210 mm)',
      paper: 'A5',
      orientation: 'portrait',
      copies: 3,
      status: 'requested',
      sourcePath: 'C:\\Cartazes\\arroz.psd',
    },
    {
      productName: 'FEIJÃO CARIOCA 1KG',
      f7: '0015020',
      formatLabel: 'A4 Vertical (210 × 297 mm)',
      paper: 'A4',
      orientation: 'portrait',
      copies: 2,
      status: 'requested',
      sourcePath: 'C:\\Cartazes\\feijao.skcartaz',
    },
  ]);

  assert.equal(added.length, 2);
  const current = getPrintHistory();
  assert.equal(current.length, 2);
  assert.equal(current[0].productName, 'ARROZ TIPO 1 5KG');
  assert.equal(current[0].status, 'requested');

  // 2. Atualizar status de operação
  updatePrintHistoryStatus(added.map(a => a.id), 'sent');
  assert.equal(getPrintHistory()[0].status, 'sent');

  updatePrintHistoryStatus(added.map(a => a.id), 'confirmed');
  assert.equal(getPrintHistory()[0].status, 'confirmed');
  assert.equal(getPrintHistory()[1].status, 'confirmed');

  // 3. Mapa de últimas impressões
  const printMap = getLatestPrintMap();
  assert.ok(printMap.has('C:\\Cartazes\\arroz.psd'));
  assert.ok(printMap.has('name:arroz tipo 1 5kg'));
  assert.ok(printMap.has('f7:0038340'));
});

test('Histórico de Impressão: filtros por período, formato e consulta de texto', () => {
  clearPrintHistory();
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  addPrintHistoryEntries([
    {
      productName: 'CERVEJA CORONA 350ML',
      f7: '0025037',
      formatLabel: 'A5 Vertical',
      paper: 'A5',
      orientation: 'portrait',
      copies: 5,
      status: 'confirmed',
      timestamp: now,
    },
    {
      productName: 'MAÇÃ GALA KG',
      f7: null,
      formatLabel: 'A3 Vertical',
      paper: 'A3',
      orientation: 'portrait',
      copies: 1,
      status: 'confirmed',
      timestamp: now - 3 * oneDay, // 3 dias atrás
    },
    {
      productName: 'AÇÚCAR REFINADO 1KG',
      f7: '0019999',
      formatLabel: 'A4 Horizontal',
      paper: 'A4',
      orientation: 'landscape',
      copies: 2,
      status: 'confirmed',
      timestamp: now - 15 * oneDay, // 15 dias atrás
    },
  ]);

  const history = getPrintHistory();
  assert.equal(history.length, 3);

  // Filtro: período 'today'
  const todayOnly = filterPrintHistory(history, { period: 'today' });
  assert.equal(todayOnly.length, 1);
  assert.equal(todayOnly[0].productName, 'CERVEJA CORONA 350ML');

  // Filtro: período '7days'
  const sevenDays = filterPrintHistory(history, { period: '7days' });
  assert.equal(sevenDays.length, 2);

  // Filtro: período '30days'
  const thirtyDays = filterPrintHistory(history, { period: '30days' });
  assert.equal(thirtyDays.length, 3);

  // Filtro por formato 'A3'
  const a3Only = filterPrintHistory(history, { period: 'all', format: 'A3' });
  assert.equal(a3Only.length, 1);
  assert.equal(a3Only[0].productName, 'MAÇÃ GALA KG');

  // Filtro por busca textual (nome ou F7)
  const queryName = filterPrintHistory(history, { period: 'all', query: 'corona' });
  assert.equal(queryName.length, 1);
  assert.equal(queryName[0].productName, 'CERVEJA CORONA 350ML');

  const queryF7 = filterPrintHistory(history, { period: 'all', query: '0019999' });
  assert.equal(queryF7.length, 1);
  assert.equal(queryF7[0].productName, 'AÇÚCAR REFINADO 1KG');

  // Limpeza
  clearPrintHistory();
  assert.equal(getPrintHistory().length, 0);
});

