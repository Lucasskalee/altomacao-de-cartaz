import type { Poster } from '../../components/editor/PosterView';

export interface ExpositorPanelInfo {
  index: number; // 0, 1, 2, 3
  sheetNumber: number; // 1, 2, 3, 4
  row: number; // 0 (superior), 1 (inferior)
  col: number; // 0 (esquerda), 1 (direita)
  title: string;
  sheetLabel: string;
  overlapNote: string;
}

export const EXPOSITOR_PANELS: ExpositorPanelInfo[] = [
  {
    index: 0,
    sheetNumber: 1,
    row: 0,
    col: 0,
    title: 'Superior Esquerda',
    sheetLabel: 'Folha 1 de 4 (Superior Esquerda)',
    overlapNote: 'Margem de sobreposição de 5 mm para cola à direita e abaixo',
  },
  {
    index: 1,
    sheetNumber: 2,
    row: 0,
    col: 1,
    title: 'Superior Direita',
    sheetLabel: 'Folha 2 de 4 (Superior Direita)',
    overlapNote: 'Alinhe sobre a margem direita da Folha 1',
  },
  {
    index: 2,
    sheetNumber: 3,
    row: 1,
    col: 0,
    title: 'Inferior Esquerda',
    sheetLabel: 'Folha 3 de 4 (Inferior Esquerda)',
    overlapNote: 'Alinhe sobre a margem inferior da Folha 1',
  },
  {
    index: 3,
    sheetNumber: 4,
    row: 1,
    col: 1,
    title: 'Inferior Direita',
    sheetLabel: 'Folha 4 de 4 (Inferior Direita)',
    overlapNote: 'Encaixe final sobre as margens das Folhas 2 e 3',
  },
];

export const EXPOSITOR_DIMENSIONS_MM = {
  totalWidthMm: 594,
  totalHeightMm: 840,
  sheetWidthMm: 297,
  sheetHeightMm: 420,
  overlapMm: 5, // Margem de cola de 5 mm
};

/**
 * Recorta e gera os 4 painéis A3 verticais de alta resolução a partir do canvas da arte total,
 * aplicando sobreposição de 5 mm e rodapé com identificação sequencial de montagem.
 */
export function sliceCanvasIntoA3Panels(
  sourceCanvas: HTMLCanvasElement,
  targetDpi = 300
): HTMLCanvasElement[] {
  const panelCanvasList: HTMLCanvasElement[] = [];

  // Dimensões A3 a 300 DPI: 297 × 420 mm -> 3508 × 4960 px
  // Usamos 150 DPI para equilíbrio entre velocidade e nitidez física se targetDpi for menor
  const scaleDpi = targetDpi === 300 ? 300 : 150;
  const a3WidthPx = Math.round((297 / 25.4) * scaleDpi);
  const a3HeightPx = Math.round((420 / 25.4) * scaleDpi);

  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const halfW = srcW / 2;
  const halfH = srcH / 2;

  // Overlap de 5 mm convertido para pixels da imagem de origem
  const overlapPxX = Math.round((EXPOSITOR_DIMENSIONS_MM.overlapMm / 594) * srcW);
  const overlapPxY = Math.round((EXPOSITOR_DIMENSIONS_MM.overlapMm / 840) * srcH);

  for (const panel of EXPOSITOR_PANELS) {
    const canvas = document.createElement('canvas');
    canvas.width = a3WidthPx;
    canvas.height = a3HeightPx;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      panelCanvasList.push(sourceCanvas);
      continue;
    }

    // Fundo branco puro (#FFFFFF) para folha física de papel
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, a3WidthPx, a3HeightPx);

    // Determina a janela de recorte na arte original com overlap
    let sx = panel.col === 0 ? 0 : halfW - overlapPxX;
    let sy = panel.row === 0 ? 0 : halfH - overlapPxY;
    let sw = halfW + overlapPxX;
    let sh = halfH + overlapPxY;

    // Garante que o recorte não ultrapasse a imagem original
    if (sx + sw > srcW) sw = srcW - sx;
    if (sy + sh > srcH) sh = srcH - sy;

    // Área útil da folha A3 reservando 14 px no rodapé para instrução de montagem
    const footerHeightPx = Math.round((10 / 25.4) * scaleDpi); // ~10 mm de rodapé
    const destW = a3WidthPx;
    const destH = a3HeightPx - footerHeightPx;

    ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, destW, destH);

    // Rodapé de montagem e instruções de colagem
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, destH, a3WidthPx, footerHeightPx);

    // Linha divisória de corte/rodapé
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, destH);
    ctx.lineTo(a3WidthPx, destH);
    ctx.stroke();

    // Texto de instrução de montagem
    ctx.fillStyle = '#334155';
    ctx.font = `600 ${Math.round((3.2 / 25.4) * scaleDpi)}px sans-serif`;
    ctx.textBaseline = 'middle';
    const textY = destH + footerHeightPx / 2;

    const mainText = `SKALEE CARTAZ · EXPOSITOR A3 2×2 (594 × 840 mm) · ${panel.sheetLabel.toUpperCase()}`;
    ctx.fillText(mainText, 24, textY);

    const helpText = `${panel.overlapNote} · Sequência 2 colunas × 2 linhas`;
    ctx.fillStyle = '#64748b';
    ctx.font = `400 ${Math.round((2.8 / 25.4) * scaleDpi)}px sans-serif`;
    const helpWidth = ctx.measureText(helpText).width;
    ctx.fillText(helpText, a3WidthPx - helpWidth - 24, textY);

    panelCanvasList.push(canvas);
  }

  return panelCanvasList;
}

/**
 * Expande um Poster configurado como Expositor A3 2×2 em 4 páginas Poster individuais
 * em formato A3 Vertical, prontas para serem impressas em sequência em papel A3 físico.
 */
export function expandExpositorToA3Posters(basePoster: Poster): Poster[] {
  return EXPOSITOR_PANELS.map(panel => {
    return {
      ...basePoster,
      name: `${basePoster.name} (${panel.sheetLabel})`,
      detail: `${basePoster.detail || ''} · ${panel.title}`,
      expositorPanel: panel,
    };
  });
}

