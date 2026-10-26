import { sanitizePrice, type Poster } from './PosterView';
export function exportPng(poster: Poster) {
    // Renderização em 300 DPI com fontes do sistema e desenho vetorial no canvas.
    const canvas = document.createElement('canvas'); canvas.width = 1748; canvas.height = 2480;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fit = (text: string, maxWidth: number, startSize: number, weight: number, family: string) => {
      let size = startSize;
      do { ctx.font = `${weight} ${size}px ${family}`; if (ctx.measureText(text).width <= maxWidth) break; size -= 4; } while (size > 30);
      return size;
    };
    const name = (poster.name || 'PRODUTO').toUpperCase();
    ctx.fillStyle='#292d5a'; fit(name,1500,235,900,'Arial, sans-serif');ctx.fillText(name,874,790);
    ctx.fillRect(210,925,1328,14);
    const detail = (poster.detail || '').toUpperCase();fit(detail,1250,148,900,'Arial, sans-serif');ctx.fillText(detail,874,1030);
    const {whole,fraction}=sanitizePrice(poster.price);
    ctx.fillStyle='#e97858';ctx.textAlign='right';ctx.textBaseline='alphabetic';fit(whole,740,790,400,'Zullia, Arial, sans-serif');ctx.fillText(whole,920,1780);
    ctx.textAlign='left';fit(fraction,640,410,400,'Zullia, Arial, sans-serif');ctx.fillText(fraction,930,1460);
    ctx.fillRect(945,1500,530,14);
    ctx.fillStyle='#292d5a';ctx.textAlign='center';ctx.font='italic 900 120px Arial, sans-serif';ctx.fillText(poster.unit.toUpperCase(),1240,1660);
    const link = document.createElement('a');link.download=`cartaz-${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.png`;link.href=canvas.toDataURL('image/png');link.click();
}
