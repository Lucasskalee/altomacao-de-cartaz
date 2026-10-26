import { useRef, useState } from 'react';

type Poster = { name: string; detail: string; price: string; unit: string };
const initial: Poster = { name: 'REPOLHO', detail: 'VERDE', price: '2,89', unit: 'KG' };
const sanitizePrice = (value: string) => {
  const normalized = value.replace(/[^\d,.]/g, '').replace('.', ',');
  const [whole = '0', fraction = ''] = normalized.split(',');
  return { whole: whole || '0', fraction: (fraction + '00').slice(0, 2) };
};
function PosterView({poster}: {poster: Poster}) {
  const {whole, fraction} = sanitizePrice(poster.price);
  return <div className="poster" aria-label="Prévia do cartaz A5">
    <div className="poster-content">
      <div className="poster-name">{poster.name || 'PRODUTO'}</div>
      <div className="poster-rule" />
      <div className="poster-detail">{poster.detail || '\u00a0'}</div>
      <div className="poster-price">
        <span className="price-whole">{whole}</span>
        <div className="price-right"><span className="price-fraction">{fraction}</span><span className="fraction-rule"/><span className="price-unit">{poster.unit || 'UN'}</span></div>
      </div>
    </div>
  </div>;
}
export default function App() {
  const [poster, setPoster] = useState<Poster>(initial);
  const [queue, setQueue] = useState<Poster[]>([]);
  const posterRef = useRef<HTMLDivElement>(null);
  const change = (field: keyof Poster, value: string) => setPoster(prev => ({...prev, [field]: value}));
  const print = () => window.print();
  const exportPng = async () => {
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
    ctx.fillStyle='#e97858';ctx.textAlign='right';ctx.textBaseline='alphabetic';fit(whole,740,790,900,'Arial, sans-serif');ctx.fillText(whole,920,1780);
    ctx.textAlign='left';fit(fraction,640,410,900,'Arial, sans-serif');ctx.fillText(fraction,930,1460);
    ctx.fillRect(945,1500,530,14);
    ctx.fillStyle='#292d5a';ctx.textAlign='center';ctx.font='italic 900 120px Arial, sans-serif';ctx.fillText(poster.unit.toUpperCase(),1240,1660);
    const link = document.createElement('a');link.download=`cartaz-${name.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.png`;link.href=canvas.toDataURL('image/png');link.click();
  };
  return <div className="app">
    <header><div className="brand"><div className="brand-icon">S</div><div><strong>Skalee Cartazes</strong><small>Editor de ofertas • A5 vertical</small></div></div><span className="version">v0.1.0</span></header>
    <main><section className="panel controls"><h2>Editar oferta</h2><p>Preencha os campos para atualizar a prévia.</p>
      <label>Nome principal<input value={poster.name} maxLength={32} onChange={e=>change('name',e.target.value.toUpperCase())}/></label>
      <label>Complemento<input value={poster.detail} maxLength={28} onChange={e=>change('detail',e.target.value.toUpperCase())}/></label>
      <div className="fields"><label>Preço (R$)<input inputMode="decimal" value={poster.price} onChange={e=>change('price',e.target.value)}/></label><label>Unidade<select value={poster.unit} onChange={e=>change('unit',e.target.value)}><option>KG</option><option>UN</option><option>PCT</option><option>CX</option><option>LT</option></select></label></div>
      <div className="actions"><button onClick={print}>Imprimir A5</button><button className="secondary" onClick={exportPng}>Exportar PNG 300 DPI</button></div>
      <button className="outline" onClick={()=>setQueue(items=>[...items,{...poster}])}>+ Adicionar à lista ({queue.length})</button>
      {queue.length>0 && <div className="queue"><h3>Lista de cartazes</h3>{queue.map((item,i)=><div key={i}><span>{item.name} {item.detail} • R$ {item.price}</span><button className="remove" onClick={()=>setQueue(items=>items.filter((_,j)=>i!==j))}>×</button></div>)}<small>Lista preparada para a futura impressão em lote.</small></div>}
      <p className="hint">Impressão: selecione papel A5, escala 100%, margens nenhuma e desative cabeçalhos/rodapés. A saída depende do driver da impressora.</p>
    </section>
    <section className="panel preview"><div className="preview-heading"><div><h2>Pré-visualização</h2><p>148 × 210 mm • Retrato</p></div><span className="status">Pronto para impressão</span></div><div className="paper-wrap"><div ref={posterRef}><PosterView poster={poster}/></div></div></section></main>
    <div className="print-only"><PosterView poster={poster}/></div>
  </div>;
}
