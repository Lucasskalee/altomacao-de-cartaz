import type { HistoryData, HistoryEntry, UpdateOutcome } from '../../features/importacao/updates';
import { resultLabel } from '../../features/importacao/updates';
import { money } from './PriceConfirmation';
type Props = { history: HistoryData | null; error: string; outcome: UpdateOutcome | null; refresh: () => void; restore: (id: string) => void };
export function PriceHistory({ history, error, outcome, refresh, restore }: Props) {
  const restored = new Set(history?.entries.filter(entry => entry.result === 'restored').map(entry => entry.restoresId));
  const item = (entry: HistoryEntry, historical: boolean) => <li key={entry.id}>
    <strong>{entry.name} · F7 {entry.f7}</strong> · {money(entry.oldPriceCents)} → {money(entry.newPriceCents)}
    <p>{resultLabel[entry.result] ?? entry.result}{historical && restored.has(entry.id) ? ' · Restauração concluída' : ''} · {entry.message}</p>
    <small>{new Date(entry.timestamp).toLocaleString('pt-BR')} · DBF: {entry.dbfName}</small><small>{entry.path}</small>
    {entry.backupAvailable && <small>Backup: {entry.backupPath}</small>}
    {historical && entry.action === 'update' && entry.backupAvailable && ['updated', 'prepared', 'recovery-required'].includes(entry.result) && !restored.has(entry.id) && <button className="subtle" onClick={() => restore(entry.id)}>Restaurar preço anterior…</button>}
  </li>;
  return <section className="price-history" aria-label="Histórico local de preços">
    {outcome && <div role="status"><h3>Resultado do último lote</h3><p>{outcome.entries.filter(entry => ['updated', 'restored'].includes(entry.result)).length} arquivo(s) atualizado(s) · {outcome.entries.filter(entry => entry.result === 'skipped').length} não executado(s) · {outcome.entries.filter(entry => ['failed', 'recovery-required'].includes(entry.result)).length} falha(s).</p>{outcome.stopped && <p className="error-text">O lote foi interrompido. Revise as falhas antes de repetir.</p>}{outcome.errors.map(message => <p className="error-text" key={message}>{message}</p>)}<ul>{outcome.entries.map(entry => item(entry, false))}</ul></div>}
    <details><summary>Histórico local e restauração</summary><p>Carregado do computador. Restaurar também exige revisão e confirmação. Arquivos alterados posteriormente são bloqueados.</p><button className="subtle" onClick={refresh}>Atualizar histórico</button>{error && <p className="error-text" role="alert">{error}</p>}{history?.errors.map(message => <p className="error-text" key={message}>{message}</p>)}{history?.entries.length === 0 && <p>Nenhuma atualização registrada.</p>}<ul>{history?.entries.map(entry => item(entry, true))}</ul></details>
  </section>;
}
