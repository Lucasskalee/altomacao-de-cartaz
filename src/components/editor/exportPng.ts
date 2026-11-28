import { sanitizePrice, type Poster } from './PosterView';
import { importedPng } from './importedRenderer';
import { getFormatDimensionsMm } from '../../features/formatos/service';
import type { PosterFormatConfig } from '../../features/formatos/types';

export function computePngDimensionsPx(formatConfig?: PosterFormatConfig): { width: number; height: number } {
  if (!formatConfig || (formatConfig.paper === 'A5' && formatConfig.orientation === 'portrait')) {
    return { width: 1748, height: 2480 };
  }
  const dims = getFormatDimensionsMm(formatConfig);
  return {
    width: Math.max(100, Math.round((dims.width / 25.4) * 300)),
    height: Math.max(100, Math.round((dims.height / 25.4) * 300)),
  };
}

export async function exportPng(poster: Poster, formatConfig?: PosterFormatConfig) {
  const effectiveFormat = formatConfig ?? poster.formatConfig;
  const { width, height } = computePngDimensionsPx(effectiveFormat);

  if (poster.artwork) {
    const link = document.createElement('a');
    link.download = `cartaz-${safe(poster.name)}.png`;
    link.href = await importedPng(poster.artwork, poster.price, {
      width,
      height,
      validityText: poster.validityText,
      dynamicTexts: {
        category: poster.category,
        name: poster.name,
        complement: poster.detail,
        unit: poster.unit,
        hasBoxPrice: poster.hasBoxPrice,
        boxQuantity: poster.boxQuantity,
        boxUnitLabel: poster.boxUnitLabel,
        boxPrice: poster.boxPrice,
        boxPackageType: poster.boxPackageType,
        boxPackageLabel: poster.boxPackageLabel,
        unitBadgeMode: poster.unitBadgeMode,
        productImage: poster.productImage,
      },
    });
    link.click();
    return;
  }

  // Renderização em 300 DPI com fontes do sistema e desenho vetorial no canvas.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const isDefaultA5 = width === 1748 && height === 2480;
  if (!isDefaultA5 && typeof ctx.save === 'function' && typeof ctx.translate === 'function' && typeof ctx.scale === 'function') {
    const scale = Math.min(width / 1748, height / 2480);
    const offsetX = (width - 1748 * scale) / 2;
    const offsetY = (height - 2480 * scale) / 2;
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fit = (text: string, maxWidth: number, startSize: number, weight: number, family: string) => {
    let size = startSize;
    do {
      ctx.font = `${weight} ${size}px ${family}`;
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 4;
    } while (size > 30);
    return size;
  };
  const name = (poster.name || 'PRODUTO').toUpperCase();
  ctx.fillStyle = '#292d5a';
  fit(name, 1500, 235, 900, 'Arial, sans-serif');
  ctx.fillText(name, 874, 790);
  ctx.fillRect(210, 925, 1328, 14);
  const detail = (poster.detail || '').toUpperCase();
  fit(detail, 1250, 148, 900, 'Arial, sans-serif');
  ctx.fillText(detail, 874, 1030);
  const { whole, fraction } = sanitizePrice(poster.price);
  ctx.fillStyle = '#e97858';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  fit(whole, 740, 790, 400, 'Zullia, Arial, sans-serif');
  ctx.fillText(whole, 920, 1780);
  ctx.textAlign = 'left';
  fit(fraction, 640, 410, 400, 'Zullia, Arial, sans-serif');
  ctx.fillText(fraction, 930, 1460);
  ctx.fillRect(945, 1500, 530, 14);
  ctx.fillStyle = '#292d5a';
  ctx.textAlign = 'center';
  ctx.font = 'italic 900 120px Arial, sans-serif';
  ctx.fillText(poster.unit.toUpperCase(), 1240, 1660);

  if (!isDefaultA5 && typeof ctx.restore === 'function') {
    ctx.restore();
  }

  const link = document.createElement('a');
  link.download = `cartaz-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
const safe = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'arte';
