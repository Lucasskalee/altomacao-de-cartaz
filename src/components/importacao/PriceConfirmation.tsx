import { useEffect, useRef, useState } from 'react';
import type { Review } from '../../features/importacao/updates';
export const money = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
type Props = { review: Review; saving: boolean; confirm: () => void; cancel: () => void };
export function PriceConfirmation({ review, saving, confirm, cancel }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="price-confirmation" onCancel={event => { event.preventDefault(); if (!saving) cancel(); }} aria-labelledby="confirm-price-title">
    <form onSubmit={event => { event.preventDefault(); if (accepted && !saving) confirm(); }}>
      <h2 id="confirm-price-title">{review.action === 'restore' ? 'Confirmar restauração de preço' : 'Confirmar atualização de preços'}</h2>
      <p>{review.changes.length} cartaz(es) selecionado(s) · DBF: {review.dbfName} · {review.ignoredConflicts} F7 conflitante(s) ignorado(s).</p>
      <p>O arquivo será reaberto e validado novamente. Um backup será criado antes de gravar.</p>
      <p>Se houver falha, o lote será interrompido. Arquivos já atualizados permanecem gravados e podem ser restaurados pelo histórico.</p>
      <div className="import-table-wrap"><table className="import-table"><thead><tr><th>Produto / F7 / Arquivo</th><th>Anterior</th><th>Novo</th></tr></thead><tbody>{review.changes.map(change => <tr key={JSON.stringify([change.documentId, change.path])}><td><strong>{change.name}</strong><small>F7: {change.f7}</small><small>{change.path}</small></td><td>{money(change.oldPriceCents)}</td><td>{money(change.newPriceCents)}</td></tr>)}</tbody></table></div>
      <label className="price-accept"><input type="checkbox" required checked={accepted} onChange={event => setAccepted(event.target.checked)} disabled={saving}/> Revisei os preços e autorizo a gravação destes cartazes.</label>
      <div className="toolbar"><button type="submit" disabled={!accepted || saving}>{saving ? 'Salvando…' : 'Confirmar e salvar'}</button><button type="button" className="subtle" onClick={cancel} disabled={saving}>Cancelar</button></div>
    </form>
  </dialog>;
}
