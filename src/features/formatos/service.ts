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
 */
export function applyDynamicPrintStyles(config: PosterFormatConfig = DEFAULT_FORMAT_CONFIG): void {
  if (typeof document === 'undefined') return;

  // Para o Expositor A3 2x2, cada folha impressa física é A3 Vertical (297 × 420 mm)
  let printWidth: number;
  let printHeight: number;
  if (config.paper === 'expositor-a3-2x2') {
    printWidth = 297;
    printHeight = 420;
  } else {
    const dims = getFormatDimensionsMm(config);
    printWidth = dims.width;
    printHeight = dims.height;
  }

  const styleId = 'sk-dynamic-print-page-style';

  let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = `
    @page {
      size: ${printWidth}mm ${printHeight}mm;
      margin: 0;
    }
    @media print {
      html, body, #root, .app {
        width: ${printWidth}mm !important;
        height: ${printHeight}mm !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      .print-only .poster,
      .print-page {
        width: ${printWidth}mm !important;
        height: ${printHeight}mm !important;
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

