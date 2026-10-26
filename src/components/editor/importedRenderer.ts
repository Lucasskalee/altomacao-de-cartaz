import type { ImportedArtwork, ImportedPricePart } from '../../features/cartazes/types';
const sanitizePrice = (value: string) => {
  const normalized=value.replace(/[^\d,.]/g,'').replace('.',','); const [whole='0',fraction='']=normalized.split(',');
  return {whole:whole||'0',fraction:(fraction+'00').slice(0,2)};
};

const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(source: string) {
  let pending = imageCache.get(source);
  if (!pending) {
    pending = new Promise((resolve,reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Recurso visual incorporado inválido.')); image.src = source; });
    imageCache.set(source,pending);
  }
  return pending;
}

export function importedPriceWarning(artwork: ImportedArtwork, price: string): string {
  const whole = sanitizePrice(price).whole;
  const part = artwork.priceParts.find(item => item.role === 'whole');
  if (!part) return 'Mapeamento de reais ausente.';
  const available = Math.max(part.bounds.right - part.bounds.left, part.bounds.right - 24);
  const estimated = whole.length * (part.bounds.bottom - part.bounds.top) * .62;
  return estimated > available / .64 ? 'O valor é largo demais para a área mapeada. Reduza os dígitos ou prepare a arte.' : '';
}

export async function drawImported(canvas: HTMLCanvasElement, artwork: ImportedArtwork, price: string, outputWidth = 886, outputHeight = 1260) {
  canvas.width = outputWidth; canvas.height = outputHeight;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas indisponível.');
  context.fillStyle = '#ffffff'; context.fillRect(0,0,outputWidth,outputHeight);
  const scale = Math.min(outputWidth / artwork.canvas.width, outputHeight / artwork.canvas.height);
  const offsetX = (outputWidth - artwork.canvas.width * scale) / 2, offsetY = (outputHeight - artwork.canvas.height * scale) / 2;
  const background = await loadImage(artwork.staticBackground);
  context.drawImage(background, offsetX, offsetY, artwork.canvas.width * scale, artwork.canvas.height * scale);
  if ('fonts' in document) await document.fonts.load(`${Math.max(12, 500 * scale)}px Zullia`).catch(() => []);
  const { whole, fraction } = sanitizePrice(price);
  context.save(); context.translate(offsetX,offsetY); context.scale(scale,scale);
  for (const part of artwork.priceParts) drawPart(context,part,whole,fraction,artwork.canvas.width);
  context.restore();
}

function drawPart(context: CanvasRenderingContext2D, part: ImportedPricePart, whole: string, fraction: string, _canvasWidth: number) {
  const b = part.bounds, height = Math.max(1,b.bottom-b.top), font = part.fontFamily || 'Zullia';
  context.save(); context.fillStyle = part.color;
  if (part.shadow) { context.shadowOffsetX=part.shadow.dx; context.shadowOffsetY=part.shadow.dy; context.shadowBlur=part.shadow.blur; context.shadowColor=part.shadow.color; }
  if (part.role === 'fractionRule') { context.fillRect(b.left,b.top,b.right-b.left,b.bottom-b.top); context.restore(); return; }
  const value = part.role === 'whole' ? whole : part.role === 'fraction' ? fraction : ',';
  if (part.transform && part.fontSize) {
    const [a,bm,c,d,e,f]=part.transform; context.transform(a,bm,c,d,e,f);
    context.font=`400 ${part.fontSize}px ${quoteFont(font)}, Zullia, sans-serif`;context.textAlign='center';context.textBaseline='alphabetic';
    if(part.role==='whole'&&part.originalText){
      const measured=context.measureText(value).width;
      const origMeasured=Math.max(1,context.measureText(part.originalText).width);
      if(measured>origMeasured*1.05){
        const scaleX=Math.max(0.7,Math.hypot(a,bm));
        const availablePx=Math.max(b.right-b.left,b.right-44);
        const targetLocalWidth=availablePx/scaleX;
        if(measured>targetLocalWidth){
          const ratio=Math.max(0.55,targetLocalWidth/measured);
          const fittedSize=part.fontSize*ratio;
          context.font=`400 ${fittedSize}px ${quoteFont(font)}, Zullia, sans-serif`;
          const newMeasured=context.measureText(value).width;
          const origRight=origMeasured/2*0.92;
          const shiftLeft=Math.max(0,newMeasured/2-origRight);
          context.translate(-shiftLeft,0);
        } else {
          const extra=measured-origMeasured;
          context.translate(-Math.max(0,extra)/2,0);
        }
      }
    }
    context.fillText(value,0,0);context.restore();return;
  }
  let fontSize = height * (part.role === 'decimal' ? 1.18 : 1.14);
  context.font = `400 ${fontSize}px ${quoteFont(font)}, Zullia, sans-serif`; context.textBaseline='alphabetic';
  if (part.role === 'whole') {
    context.textAlign='right';
    const available = Math.max(b.right - b.left, b.right - 36), measured=context.measureText(value).width;
    if (measured > available) { fontSize *= Math.max(.45,available/measured); context.font=`400 ${fontSize}px ${quoteFont(font)}, Zullia, sans-serif`; }
    context.fillText(value,b.right,b.bottom);
  } else { context.textAlign='left'; context.fillText(value,b.left,b.bottom); }
  context.restore();
}

function quoteFont(value: string) { return `"${value.replace(/["\\]/g,'')}"`; }

export async function importedPng(artwork: ImportedArtwork, price: string): Promise<string> {
  const canvas=document.createElement('canvas'); await drawImported(canvas,artwork,price,1748,2480); return canvas.toDataURL('image/png');
}
