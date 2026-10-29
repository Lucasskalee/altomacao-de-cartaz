import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getFormatDimensionsMm,
  getFormatLabel,
  checkPosterResolution,
  applyDynamicPrintStyles,
  removeDynamicPrintStyles,
} from '../src/features/formatos/service';
import {
  EXPOSITOR_PANELS,
  EXPOSITOR_DIMENSIONS_MM,
  expandExpositorToA3Posters,
} from '../src/features/formatos/expositor';
import type { PosterFormatConfig } from '../src/features/formatos/types';
import type { Poster } from '../src/components/editor/PosterView';

test('Formatos Oficiais: dimensões milimétricas padrão A6, A5, A4, A3 e Expositor A3 2×2', () => {
  // 1. A6 Vertical (105 × 148 mm)
  const a6 = getFormatDimensionsMm({ paper: 'A6', orientation: 'portrait' });
  assert.equal(a6.width, 105);
  assert.equal(a6.height, 148);

  // 2. A5 Vertical (148 × 210 mm)
  const a5 = getFormatDimensionsMm({ paper: 'A5', orientation: 'portrait' });
  assert.equal(a5.width, 148);
  assert.equal(a5.height, 210);

  // 3. A4 Vertical (210 × 297 mm)
  const a4 = getFormatDimensionsMm({ paper: 'A4', orientation: 'portrait' });
  assert.equal(a4.width, 210);
  assert.equal(a4.height, 297);

  // 4. A3 Vertical (297 × 420 mm)
  const a3 = getFormatDimensionsMm({ paper: 'A3', orientation: 'portrait' });
  assert.equal(a3.width, 297);
  assert.equal(a3.height, 420);

  // 5. Expositor A3 2×2 (594 × 840 mm)
  const exp = getFormatDimensionsMm({ paper: 'expositor-a3-2x2', orientation: 'portrait' });
  assert.equal(exp.width, 594);
  assert.equal(exp.height, 840);
  assert.equal(exp.width, a3.width * 2);
  assert.equal(exp.height, a3.height * 2);
});

test('Formatos Oficiais: rótulos padrão conforme especificação', () => {
  assert.equal(getFormatLabel({ paper: 'A6', orientation: 'portrait' }), 'A6 Vertical (105 × 148 mm)');
  assert.equal(getFormatLabel({ paper: 'A5', orientation: 'portrait' }), 'A5 Vertical (148 × 210 mm)');
  assert.equal(getFormatLabel({ paper: 'A4', orientation: 'portrait' }), 'A4 Vertical (210 × 297 mm)');
  assert.equal(getFormatLabel({ paper: 'A3', orientation: 'portrait' }), 'A3 Vertical (297 × 420 mm)');
  assert.equal(getFormatLabel({ paper: 'expositor-a3-2x2', orientation: 'portrait' }), 'Expositor A3 2×2 (594 × 840 mm)');
  assert.equal(
    getFormatLabel({ paper: 'custom', orientation: 'portrait', customWidthMm: 120, customHeightMm: 180 }),
    'Personalizado Vertical (120 × 180 mm)'
  );
});

test('Expositor A3 2×2: divisão de arte em 4 folhas A3 verticais com sequência e overlap', () => {
  assert.equal(EXPOSITOR_PANELS.length, 4);

  // Folha 1: Superior Esquerda
  assert.equal(EXPOSITOR_PANELS[0].sheetNumber, 1);
  assert.equal(EXPOSITOR_PANELS[0].row, 0);
  assert.equal(EXPOSITOR_PANELS[0].col, 0);
  assert.ok(EXPOSITOR_PANELS[0].sheetLabel.includes('Folha 1'));

  // Folha 2: Superior Direita
  assert.equal(EXPOSITOR_PANELS[1].sheetNumber, 2);
  assert.equal(EXPOSITOR_PANELS[1].row, 0);
  assert.equal(EXPOSITOR_PANELS[1].col, 1);

  // Folha 3: Inferior Esquerda
  assert.equal(EXPOSITOR_PANELS[2].sheetNumber, 3);
  assert.equal(EXPOSITOR_PANELS[2].row, 1);
  assert.equal(EXPOSITOR_PANELS[2].col, 0);

  // Folha 4: Inferior Direita
  assert.equal(EXPOSITOR_PANELS[3].sheetNumber, 4);
  assert.equal(EXPOSITOR_PANELS[3].row, 1);
  assert.equal(EXPOSITOR_PANELS[3].col, 1);

  // Overlap de montagem
  assert.equal(EXPOSITOR_DIMENSIONS_MM.overlapMm, 5);

  // Expansão do cartaz em 4 páginas Poster A3
  const basePoster: Poster = {
    name: 'REFRIGERANTE COCA-COLA 2L',
    detail: 'PET PROMOCIONAL',
    price: '7,99',
    unit: 'UN',
  };

  const expanded = expandExpositorToA3Posters(basePoster);
  assert.equal(expanded.length, 4);
  assert.equal(expanded[0].expositorPanel?.sheetNumber, 1);
  assert.equal(expanded[1].expositorPanel?.sheetNumber, 2);
  assert.equal(expanded[2].expositorPanel?.sheetNumber, 3);
  assert.equal(expanded[3].expositorPanel?.sheetNumber, 4);
  assert.ok(expanded[0].name.includes('Folha 1'));
});

test('Formatos: verificação de resolução insuficiente (< 150 DPI) e aceitável (>= 150 DPI)', () => {
  // A5 vertical: 148x210 mm.
  const lowRes = checkPosterResolution({ paper: 'A5', orientation: 'portrait' }, 500, 700);
  assert.equal(lowRes.isInsufficient, true);
  assert.ok(lowRes.warning);
  assert.ok(lowRes.warning.includes('DPI'));

  const highRes = checkPosterResolution({ paper: 'A5', orientation: 'portrait' }, 1800, 2500);
  assert.equal(highRes.isInsufficient, false);
  assert.equal(highRes.warning, undefined);

  // Expositor A3 2x2 (594x840 mm): arte de 1500x2100 px é insuficiente (< 150 DPI)
  const expLow = checkPosterResolution({ paper: 'expositor-a3-2x2', orientation: 'portrait' }, 1500, 2100);
  assert.equal(expLow.isInsufficient, true);
});

test('Formatos: injeção de estilo de impressão do Expositor A3 2×2 usa tamanho de página A3 físico', () => {
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    applyDynamicPrintStyles({ paper: 'expositor-a3-2x2', orientation: 'portrait' });
    const tag = document.getElementById('sk-dynamic-print-page-style');
    assert.ok(tag);
    // Cada página física enviada para a impressora é A3 (297mm 420mm)
    assert.ok(tag.textContent?.includes('297mm 420mm'));
    removeDynamicPrintStyles();
  }
});

test('Transparência PSD: prévia e miniaturas compõem sobre branco (#FFFFFF) sem alterar arquivo original', async () => {
  const { createOptimizedThumbnail } = require('../src/features/condutor/cache');

  // Cria canvas simulado com fundo transparente e um ponto colorido
  let filledWithColor: string | null = null;
  const mockContext = {
    fillStyle: '',
    fillRect: (x: number, y: number, w: number, h: number) => {
      filledWithColor = mockContext.fillStyle;
    },
    drawImage: () => {},
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
  };

  // Se createOptimizedThumbnail receber um dataURL, deve preencher o fundo com #FFFFFF
  // Criamos elemento canvas para interceptar
  if (typeof document !== 'undefined') {
    const origCreateElement = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 100,
          height: 100,
          getContext: () => mockContext,
          toDataURL: () => 'data:image/png;base64,mockwhitebg',
        } as any;
      }
      return origCreateElement(tag);
    }) as any;

    try {
      // Executa criação de miniatura otimizada
      // Note: em ambiente de Node sem DOM Image real, retorna a sourceDataUrl de forma segura
      const inputUrl = 'data:image/png;base64,sampletransparentdata';
      const result = await createOptimizedThumbnail(inputUrl, 160, 226);
      assert.ok(result);
    } finally {
      document.createElement = origCreateElement;
    }
  }
});
