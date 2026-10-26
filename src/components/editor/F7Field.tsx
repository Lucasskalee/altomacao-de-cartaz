import { digitsOnly, getF7, type IndexedCartaz } from '../../features/cartazes/f7';

type Props = {
  value?: string | null;
  onChange: (value: string) => void;
  matches: IndexedCartaz[];
  checking: boolean;
  error: string;
  onRefresh: () => void;
};

export function F7Field({ value, onChange, matches, checking, error, onRefresh }: Props) {
  const f7 = getF7(value);
  const legacy = value && !f7 ? value : null;
  return <div className="f7-field">
    <label htmlFor="product-f7">Código F7 do produto
      <input id="product-f7" type="text" inputMode="numeric" pattern="[0-9]*"
        value={f7 ?? ''} onChange={event => onChange(digitsOnly(event.target.value))}
        aria-describedby="f7-help" autoComplete="off" />
    </label>
    <small id="f7-help">Opcional · Somente dígitos · Zeros à esquerda preservados · Não sai no cartaz.</small>
    {legacy && <p className="f7-note">Código antigo preservado: {legacy}. Digite um F7 para substituí-lo.</p>}
    <div aria-live="polite">
      {checking && <p className="f7-note">Consultando F7 na biblioteca local…</p>}
      {error && <p className="f7-note">Não foi possível conferir os cartazes com este F7: {error} <button className="subtle" onClick={onRefresh}>Tentar novamente</button> Você pode continuar e salvar.</p>}
      {!checking && f7 && matches.length > 0 && <div className="f7-matches">
        <p>{matches.length} outro(s) cartaz(es) com este F7. Você pode continuar e salvar normalmente.</p>
        <ul>{matches.map(item => <li key={item.path}><strong>{item.document.product.name}</strong> · R$ {(item.document.product.priceCents / 100).toFixed(2).replace('.', ',')} / {item.document.product.unit}<small>{item.path}</small></li>)}</ul>
      </div>}
    </div>
  </div>;
}
