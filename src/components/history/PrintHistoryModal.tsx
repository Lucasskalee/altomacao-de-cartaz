import { useMemo, useState } from 'react';
import { clearPrintHistory, filterPrintHistory, getPrintHistory, updatePrintHistoryStatus } from '../../features/history/service';
import { HistoryPeriodFilter, PrintHistoryEntry } from '../../features/history/types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function PrintHistoryModal({ isOpen, onClose }: Props) {
  const [history, setHistory] = useState<PrintHistoryEntry[]>(() => getPrintHistory());
  const [period, setPeriod] = useState<HistoryPeriodFilter>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [format, setFormat] = useState('all');
  const [query, setQuery] = useState('');

  const refreshHistory = () => {
    setHistory(getPrintHistory());
  };

  const filtered = useMemo(() => {
    return filterPrintHistory(history, {
      period,
      startDate,
      endDate,
      format,
      query,
    });
  }, [history, period, startDate, endDate, format, query]);

  if (!isOpen) return null;

  const handleClear = () => {
    if (confirm('Deseja realmente limpar todo o histórico de impressão local?')) {
      clearPrintHistory();
      refreshHistory();
    }
  };

  return (
    <div
      className="modal-backdrop"
      style={{ zIndex: 100 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-modal-title"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        style={{
          width: 'min(920px, 95vw)',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff',
          borderRadius: 12,
          padding: 24,
          boxShadow: '0 20px 40px rgba(0,0,0,0.18)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h2 id="history-modal-title" style={{ margin: 0, fontSize: 18, color: '#0f172a', fontWeight: 700 }}>
              📜 Histórico de Impressão Local
            </h2>
            <p style={{ margin: '4px 0 0 0', fontSize: 12, color: '#64748b' }}>
              Registro persistente com distinção rigorosa entre pedidos solicitados, enviados ao driver e confirmados fisicamente.
            </p>
          </div>
          <button
            type="button"
            className="editor-queue-remove"
            style={{ fontSize: 20 }}
            onClick={onClose}
            aria-label="Fechar modal de histórico"
          >
            ✕
          </button>
        </div>

        {/* Resumo de Status Real */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, padding: '8px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, fontSize: 12 }}>
            <span style={{ color: '#15803d', fontWeight: 700 }}>✓ Confirmadas Fisicamente:</span>{' '}
            <strong style={{ color: '#166534' }}>{filtered.filter(e => e.status === 'confirmed').length}</strong>
          </div>
          <div style={{ flex: 1, padding: '8px 12px', background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12 }}>
            <span style={{ color: '#475569', fontWeight: 600 }}>↗ Encaminhadas para Impressão:</span>{' '}
            <strong>{filtered.filter(e => e.status === 'sent').length}</strong>
          </div>
          <div style={{ flex: 1, padding: '8px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12 }}>
            <span style={{ color: '#b45309', fontWeight: 600 }}>⏳ Solicitadas:</span>{' '}
            <strong>{filtered.filter(e => e.status === 'requested').length}</strong>
          </div>
        </div>

        {/* Barra de Filtros do Histórico */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 10,
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
          }}
        >
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 4 }}>
              Buscar produto / F7:
            </label>
            <input
              type="search"
              placeholder="Ex: Arroz ou 001245..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="editor-input"
              style={{ height: 34, fontSize: 12 }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 4 }}>
              Período:
            </label>
            <select
              value={period}
              onChange={e => setPeriod(e.target.value as HistoryPeriodFilter)}
              className="editor-select"
              style={{ height: 34, fontSize: 12 }}
            >
              <option value="all">Todo o período</option>
              <option value="today">Hoje</option>
              <option value="7days">Últimos 7 dias</option>
              <option value="30days">Últimos 30 dias</option>
              <option value="custom">Personalizado (datas)</option>
            </select>
          </div>

          {period === 'custom' && (
            <>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 4 }}>
                  De:
                </label>
                <input
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="editor-input"
                  style={{ height: 34, fontSize: 12 }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 4 }}>
                  Até:
                </label>
                <input
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                  className="editor-input"
                  style={{ height: 34, fontSize: 12 }}
                />
              </div>
            </>
          )}

          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 4 }}>
              Formato:
            </label>
            <select
              value={format}
              onChange={e => setFormat(e.target.value)}
              className="editor-select"
              style={{ height: 34, fontSize: 12 }}
            >
              <option value="all">Todos os formatos</option>
              <option value="A6">A6 (105 × 148 mm)</option>
              <option value="A5">A5 (148 × 210 mm)</option>
              <option value="A4">A4 (210 × 297 mm)</option>
              <option value="A3">A3 (297 × 420 mm)</option>
              <option value="expositor-a3-2x2">Expositor A3 2×2 (594 × 840 mm)</option>
              <option value="custom">Personalizado</option>
            </select>
          </div>
        </div>

        {/* Tabela de Histórico com Scroll */}
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 8, minHeight: 260 }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: '#64748b', fontSize: 13 }}>
              Nenhum registro de impressão encontrado para os filtros selecionados.
            </div>
          ) : (
            <table className="conductor-table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Data / Horário</th>
                  <th>Produto</th>
                  <th style={{ width: 90 }}>Código F7</th>
                  <th style={{ width: 110 }}>Formato</th>
                  <th style={{ width: 70, textAlign: 'center' }}>Cópias</th>
                  <th style={{ width: 100, textAlign: 'center' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(entry => (
                  <tr key={entry.id}>
                    <td style={{ fontSize: 11, color: '#475569', whiteSpace: 'nowrap' }}>
                      {entry.formattedDate}
                    </td>
                    <td>
                      <div className="conductor-product-name">{entry.productName}</div>
                      {entry.sourcePath && (
                        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
                          {entry.sourcePath}
                        </div>
                      )}
                    </td>
                    <td>
                      {entry.f7 ? (
                        <span className="conductor-badge psd" style={{ fontSize: 11 }}>
                          {entry.f7}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>—</span>
                      )}
                    </td>
                    <td>
                      <span className="conductor-badge category" style={{ fontSize: 11 }}>
                        {entry.formatLabel || entry.paper}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center', fontWeight: 700, color: '#0f172a' }}>
                      {entry.copies}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {entry.status === 'confirmed' ? (
                        <span className="conductor-badge skcartaz" title="Impressão confirmada fisicamente pelo operador">
                          ✓ Confirmada
                        </span>
                      ) : (
                        <div>
                          {entry.status === 'sent' ? (
                            <span className="conductor-badge psd" title="Operação encaminhada ao mecanismo de impressão pelo diálogo do sistema (sem confirmação de saída física)">
                              ↗ Enviada
                            </span>
                          ) : (
                            <span className="conductor-badge network" title="Solicitada e aguardando processamento">
                              ⏳ Solicitada
                            </span>
                          )}
                          <button
                            type="button"
                            className="editor-btn subtle"
                            style={{ fontSize: 10, padding: '2px 6px', display: 'block', margin: '4px auto 0 auto', color: '#16a34a', borderColor: '#bbf7d0' }}
                            onClick={() => {
                              updatePrintHistoryStatus([entry.id], 'confirmed');
                              refreshHistory();
                            }}
                            title="Confirmar manualmente a saída física desta impressão"
                          >
                            ✓ Confirmar
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Rodapé do Modal */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            Mostrando <strong>{filtered.length}</strong> de <strong>{history.length}</strong> registros
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {history.length > 0 && (
              <button
                type="button"
                className="editor-btn subtle"
                style={{ color: '#dc2626' }}
                onClick={handleClear}
              >
                🗑️ Limpar Histórico
              </button>
            )}
            <button type="button" className="editor-btn primary" onClick={onClose}>
              Fechar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

