import {
  DEFAULT_FORMAT_CONFIG,
  PosterFormatConfig,
  ResolutionCheckResult,
  STANDARD_PAPER_DIMENSIONS_MM,
} from './types';

/**
 * Retorna as dimensões em milímetros (largura × altura) para a configuração de formato e orientação informada.
 */
export function getFormatDimensionsMm(config: PosterFormatConfig = DEFAULT_FORMAT_CONFIG): {
  width: number;
  height: number;
} {
  let baseWidth: number;
  let baseHeight: number;

  if (config.paper === 'custom') {
    baseWidth = Math.max(50, Math.min(2000, Number(config.customWidthMm) || 148));
    baseHeight = Math.max(50, Math.min(2000, Number(config.customHeightMm) || 210));
  } else {
    const dim = STANDARD_PAPER_DIMENSIONS_MM[config.paper] || STANDARD_PAPER_DIMENSIONS_MM.A5;
    baseWidth = dim.width;
    baseHeight = dim.height;
  }

  if (config.orientation === 'landscape') {
    return {
      width: Math.max(baseWidth, baseHeight),
      height: Math.min(baseWidth, baseHeight),
    };
  } else {
    return {
      width: Math.min(baseWidth, baseHeight),
      height: Math.max(baseWidth, baseHeight),
    };
  }
}

/**
 * Retorna o rótulo legível do formato (ex: "A4 Vertical (210 × 297 mm)").
 */
export function getFormatLabel(config: PosterFormatConfig = DEFAULT_FORMAT_CONFIG): string {
  if (config.paper === 'expositor-a3-2x2') {
    return 'Expositor A3 2×2 (594 × 840 mm)';
  }
  const { width, height } = getFormatDimensionsMm(config);
  const orientLabel = config.orientation === 'portrait' ? 'Vertical' : 'Horizontal';
  const paperLabel = config.paper === 'custom' ? 'Personalizado' : config.paper;
  return `${paperLabel} ${orientLabel} (${width} × ${height} mm)`;
}

/**
 * Calcula a resolução recomendada e emite aviso se a arte PSD tiver DPI insuficiente (< 150 DPI).
 */
export function checkPosterResolution(
  config: PosterFormatConfig,
  artworkWidth?: number,
  artworkHeight?: number
): ResolutionCheckResult {
  const { width: widthMm, height: heightMm } = getFormatDimensionsMm(config);

  // 300 DPI (ideal profissional para impressão física)
  const recW = Math.round((widthMm / 25.4) * 300);
  const recH = Math.round((heightMm / 25.4) * 300);

  // 150 DPI (limite mínimo aceitável antes de perda visível de nitidez)
  const minW = Math.round((widthMm / 25.4) * 150);
  const minH = Math.round((heightMm / 25.4) * 150);

  if (!artworkWidth || !artworkHeight) {
    return {
      isInsufficient: false,
      recommendedPx: { width: recW, height: recH },
      minimumPx: { width: minW, height: minH },
    };
  }

  // Calcula DPI efetivo ao longo da menor proporção de cobertura
  const dpiX = (artworkWidth / widthMm) * 25.4;
  const dpiY = (artworkHeight / heightMm) * 25.4;
  const effectiveDpi = Math.round(Math.min(dpiX, dpiY));

  const isInsufficient = artworkWidth < minW || artworkHeight < minH || effectiveDpi < 150;

  let warning: string | undefined;
  if (isInsufficient) {
    const paperName = config.paper === 'custom' ? 'formato personalizado' : config.paper;
    warning = `Aviso de resolução: a arte possui ${artworkWidth} × ${artworkHeight} px (~${effectiveDpi} DPI efetivo). Para impressão em ${paperName} sem pixelização, recomenda-se no mínimo 150 DPI (${minW} × ${minH} px) ou ideal de 300 DPI (${recW} × ${recH} px).`;
  }

  return {
    isInsufficient,
    warning,
    recommendedPx: { width: recW, height: recH },
    minimumPx: { width: minW, height: minH },
    effectiveDpi,
  };
}

/**
 * Injeta ou atualiza a tag de estilo de impressão dinâmica no documento
 * para garantir que o driver de impressão use o tamanho exato da página em mm.
 *
 * Quando printerSheetA4 estiver ativo (padrão de proteção da impressora):
 * Para formatos que cabem em A4 (A5, A6, A4), a página física enviada ao driver
 * é sempre A4 (210 × 297 mm), com a arte centralizada horizontalmente no topo (0 mm).
 */
export function applyDynamicPrintStyles(config: PosterFormatConfig = DEFAULT_FORMAT_CONFIG): void {
  if (typeof document === 'undefined') return;

  const dims = getFormatDimensionsMm(config);
  const artWidth = dims.width;
  const artHeight = dims.height;

  const useSheetA4 =
    config.printerSheetA4 !== false &&
    config.paper !== 'expositor-a3-2x2' &&
    config.paper !== 'A3' &&
    artWidth <= 210 &&
    artHeight <= 297;

  let sheetWidth: number;
  let sheetHeight: number;

  if (config.paper === 'expositor-a3-2x2') {
    sheetWidth = 297;
    sheetHeight = 420;
  } else if (useSheetA4) {
    sheetWidth = 210;
    sheetHeight = 297;
  } else {
    sheetWidth = artWidth;
    sheetHeight = artHeight;
  }

  const scale = artWidth / 148;

  const styleId = 'sk-dynamic-print-page-style';

  let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = `
    @page {
      size: ${sheetWidth}mm ${sheetHeight}mm;
      margin: 0;
    }
    @media print {
      html, body, #root, .app {
        width: ${sheetWidth}mm !important;
        height: ${sheetHeight}mm !important;
        margin: 0 !important;
        padding: 0 !important;
        background: #fff !important;
        overflow: visible !important;
      }
      header,
      aside,
      nav,
      main,
      fieldset,
      .sk-header,
      .sk-body-layout,
      .sk-sidebar,
      .sk-main-content,
      .library-container,
      .offer-folders,
      .workspace,
      .modal-backdrop,
      .notifications,
      .price-confirmation {
        display: none !important;
        visibility: hidden !important;
        height: 0 !important;
        width: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
        overflow: hidden !important;
      }
      .print-only {
        display: block !important;
        visibility: visible !important;
        position: static !important;
        width: ${sheetWidth}mm !important;
        margin: 0 auto !important;
        padding: 0 !important;
        background: #fff !important;
      }
      .print-page {
        width: ${sheetWidth}mm !important;
        height: ${sheetHeight}mm !important;
        page-break-after: always !important;
        break-after: page !important;
        position: relative !important;
        overflow: hidden !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        margin: 0 auto !important;
        padding: 0 !important;
        background: transparent !important;
        box-sizing: border-box !important;
      }
      .print-page:last-child {
        page-break-after: auto !important;
        break-after: auto !important;
      }
      .print-only .poster {
        width: ${artWidth}mm !important;
        height: ${artHeight}mm !important;
        margin: auto !important;
        box-shadow: none !important;
        print-color-adjust: exact !important;
        -webkit-print-color-adjust: exact !important;
        flex-shrink: 0 !important;
      }
      .print-only .poster-name {
        font-size: ${(18 * scale).toFixed(2)}mm !important;
      }
      .print-only .poster-rule {
        height: ${(1.3 * scale).toFixed(2)}mm !important;
      }
      .print-only .poster-detail {
        font-size: ${(12.7 * scale).toFixed(2)}mm !important;
      }
      .print-only .price-whole {
        font-size: ${(76.7 * scale).toFixed(2)}mm !important;
      }
      .print-only .price-fraction {
        font-size: ${(38 * scale).toFixed(2)}mm !important;
      }
      .print-only .price-unit {
        font-size: ${(11.7 * scale).toFixed(2)}mm !important;
      }
      .print-only .fraction-rule {
        height: ${(1.7 * scale).toFixed(2)}mm !important;
      }
    }
  `;
}

/**
 * Remove o estilo dinâmico de impressão após a conclusão da impressão.
 */
export function removeDynamicPrintStyles(): void {
  if (typeof document === 'undefined') return;
  const styleEl = document.getElementById('sk-dynamic-print-page-style');
  if (styleEl) {
    styleEl.remove();
  }
}

