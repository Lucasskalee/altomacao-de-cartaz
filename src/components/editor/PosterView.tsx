export type Poster = { name: string; detail: string; price: string; unit: string };
export const initial: Poster = { name: 'REPOLHO', detail: 'VERDE', price: '2,89', unit: 'KG' };
export const sanitizePrice = (value: string) => {
  const normalized = value.replace(/[^\d,.]/g, '').replace('.', ',');
  const [whole = '0', fraction = ''] = normalized.split(',');
  return { whole: whole || '0', fraction: (fraction + '00').slice(0, 2) };
};
export function PosterView({poster}: {poster: Poster}) {
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
