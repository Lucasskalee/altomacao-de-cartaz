import { useEffect, useMemo, useRef, useState } from 'react';
import { PosterView, type Poster } from '../editor/PosterView';
import { formatCentsBr } from '../../features/cartazes/presentation';
import type { Cartaz, Library as LibraryData } from '../../features/cartazes/types';
import {
  buildConductorPrintBatch,
  chooseConductorFiles,
  chooseConductorFolder,
  createQueueItemFromCartaz,
  createQueueItemFromFilePath,
  findDuplicateInQueue,
  loadConductorItem,
  loadQueueConcurrently,
  moveQueueItem,
  removeQueueItem,
  scanConductorFolder,
  updateQueueItemCopies,
} from '../../features/condutor/service';
import type { ConductorQueueItem } from '../../features/condutor/types';

type Props = {
  queue: ConductorQueueItem[];
  setQueue: React.Dispatch<React.SetStateAction<ConductorQueueItem[]>>;
  libraryData: LibraryData | null;
  run: (action: () => Promise<void>) => void;
  onPrintBatch: (posters: Poster[]) => void;
};

export function PrintConductor({ queue, setQueue, libraryData, run, onPrintBatch }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showLibraryModal, setShowLibraryModal] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [selectedLibraryPaths, setSelectedLibraryPaths] = useState<Set<string>>(new Set());
  const [notification, setNotification] = useState<string | null>(null);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);

  const processingRef = useRef(false);

  // Automatically select first item if none is selected
  useEffect(() => {
    if (queue.length > 0 && (!selectedId || !queue.some(i => i.id === selectedId))) {
      setSelectedId(queue[0].id);
    } else if (queue.length === 0) {
      setSelectedId(null);
    }
  }, [queue, selectedId]);

  // Progressive background loader for idle items
  useEffect(() => {
    const hasIdle = queue.some(item => item.status === 'idle');
    if (!hasIdle || processingRef.current) return;

    processingRef.current = true;
    setIsProcessingQueue(true);

    loadQueueConcurrently(
      queue,
      2,
      loadedItem => {
        setQueue(prev => prev.map(it => (it.id === loadedItem.id ? loadedItem : it)));
      }
    )
      .catch(() => undefined)
      .finally(() => {
        processingRef.current = false;
        setIsProcessingQueue(false);
      });
  }, [queue, setQueue]);

  const selectedItem = useMemo(() => {
    return queue.find(it => it.id === selectedId) ?? null;
  }, [queue, selectedId]);

  // Summary statistics
  const summary = useMemo(() => {
    let totalCopies = 0;
    let readyCount = 0;
    let errorCount = 0;
    let loadingCount = 0;

    for (const item of queue) {
      totalCopies += item.copies || 1;
      if (item.status === 'ready') readyCount++;
      else if (item.status === 'error') errorCount++;
      else loadingCount++;
    }

    return {
      totalDistinct: queue.length,
      totalCopies,
      readyCount,
      errorCount,
      loadingCount,
    };
  }, [queue]);

  // Handler: Add individual files from disk/network
  const handleAddFiles = async () => {
    const paths = await chooseConductorFiles();
    if (!paths || paths.length === 0) return;

    let addedCount = 0;
    let duplicateCount = 0;
    const newItems: ConductorQueueItem[] = [];

    for (const p of paths) {
      const existing = findDuplicateInQueue([...queue, ...newItems], p);
      if (existing) {
        duplicateCount++;
      } else {
        newItems.push(createQueueItemFromFilePath(p, 'external_file'));
        addedCount++;
      }
    }

    if (newItems.length > 0) {
      setQueue(prev => [...prev, ...newItems]);
    }

    if (duplicateCount > 0 && addedCount > 0) {
      setNotification(`${addedCount} arquivo(s) adicionado(s). ${duplicateCount} já estavam na fila.`);
    } else if (duplicateCount > 0 && addedCount === 0) {
      setNotification(`Todos os ${duplicateCount} arquivo(s) selecionados já estão na fila de impressão.`);
    } else {
      setNotification(`${addedCount} cartaz(es) adicionado(s) à fila.`);
    }
  };

  // Handler: Add entire folder
  const handleAddFolder = async () => {
    const folderPath = await chooseConductorFolder();
    if (!folderPath) return;

    const entries = await scanConductorFolder(folderPath);
    if (!entries || entries.length === 0) {
      setNotification('Nenhum cartaz compatível (.skcartaz ou .psd) foi encontrado na pasta selecionada.');
      return;
    }

    let addedCount = 0;
    let duplicateCount = 0;
    const newItems: ConductorQueueItem[] = [];

    for (const entry of entries) {
      const existing = findDuplicateInQueue([...queue, ...newItems], entry.path);
      if (existing) {
        duplicateCount++;
      } else {
        newItems.push(createQueueItemFromFilePath(entry.path, 'external_folder', entry.size));
        addedCount++;
      }
    }

    if (newItems.length > 0) {
      setQueue(prev => [...prev, ...newItems]);
    }

    if (duplicateCount > 0) {
      setNotification(
        `Pasta varrida: ${addedCount} arquivo(s) adicionado(s). ${duplicateCount} já estavam na fila.`
      );
    } else {
      setNotification(`Pasta varrida: ${addedCount} cartaz(es) adicionado(s) à fila.`);
    }
  };

  // Handler: Add selected items from Meus Cartazes
  const handleConfirmAddFromLibrary = () => {
    if (!libraryData || selectedLibraryPaths.size === 0) {
      setShowLibraryModal(false);
      return;
    }

    let addedCount = 0;
    let duplicateCount = 0;
    const newItems: ConductorQueueItem[] = [];

    for (const entry of libraryData.entries) {
      if (entry.folder || !entry.content || !selectedLibraryPaths.has(entry.path)) continue;
      try {
        const cartaz = JSON.parse(entry.content) as Cartaz;
        const existing = findDuplicateInQueue([...queue, ...newItems], entry.path);
        if (existing) {
          duplicateCount++;
        } else {
          newItems.push(createQueueItemFromCartaz(cartaz, entry.path, 'library'));
          addedCount++;
        }
      } catch {
        // Skip unparseable
      }
    }

    if (newItems.length > 0) {
      setQueue(prev => [...prev, ...newItems]);
    }

    setSelectedLibraryPaths(new Set());
    setShowLibraryModal(false);

    if (duplicateCount > 0) {
      setNotification(`${addedCount} cartaz(es) da biblioteca adicionados. ${duplicateCount} já estavam na fila.`);
    } else {
      setNotification(`${addedCount} cartaz(es) da biblioteca adicionados à fila.`);
    }
  };

  // Handler: Print
  const handlePrintConductor = async () => {
    if (queue.length === 0) return;

    // Ensure all items are loaded before printing
    let currentQueue = queue;
    if (queue.some(it => it.status === 'idle' || it.status === 'loading')) {
      setNotification('Concluindo carregamento dos cartazes antes de imprimir…');
      currentQueue = await loadQueueConcurrently(queue, 2);
      setQueue(currentQueue);
    }

    const { posters, skippedErrors, totalCopies, distinctItemsCount } = buildConductorPrintBatch(currentQueue);

    if (posters.length === 0) {
      throw new Error(
        skippedErrors.length > 0
          ? `Nenhum cartaz pronto para impressão. Erros encontrados:\n${skippedErrors.join('\n')}`
          : 'Nenhum cartaz válido na fila para imprimir.'
      );
    }

    // Requirement 3: Se existirem arquivos com erro ou ausentes, exibir resumo e solicitar confirmação
    if (skippedErrors.length > 0) {
      const summaryMsg =
        `Resumo antes de imprimir:\n\n` +
        `• ${distinctItemsCount} cartaz(es) prontos serão impressos (${totalCopies} folhas A5).\n` +
        `• ${skippedErrors.length} cartaz(es) com erro ou inacessíveis serão IGNORADOS:\n` +
        skippedErrors.slice(0, 6).map(e => `  - ${e}`).join('\n') +
        (skippedErrors.length > 6 ? `\n  ... e outros ${skippedErrors.length - 6} arquivo(s)` : '') +
        `\n\nDeseja prosseguir com a impressão dos ${totalCopies} cartazes válidos?`;

      const proceed = window.confirm(summaryMsg);
      if (!proceed) return;

      setNotification(
        `Aviso: ${skippedErrors.length} cartaz(es) com erro foram ignorados. Imprimindo ${totalCopies} folha(s) A5 válidas.`
      );
    } else {
      setNotification(`Enviando ${totalCopies} folha(s) A5 para impressão.`);
    }

    onPrintBatch(posters);
  };

  // Library modal filtered items
  const filteredLibraryEntries = useMemo(() => {
    if (!libraryData) return [];
    const q = librarySearch.trim().toLowerCase();
    return libraryData.entries.filter(e => {
      if (e.folder || !e.content) return false;
      if (!q) return true;
      try {
        const doc = JSON.parse(e.content) as Cartaz;
        const searchTarget = `${doc.product.name} ${doc.product.complement} ${doc.product.productCode || ''} ${e.name}`.toLowerCase();
        return searchTarget.includes(q);
      } catch {
        return e.name.toLowerCase().includes(q);
      }
    });
  }, [libraryData, librarySearch]);

  return (
    <section className="panel print-conductor" aria-label="Condutor de Impressão">
      <div className="library-heading">
        <div>
          <h2>Condutor de Impressão</h2>
          <p>
            Monte filas personalizadas com arquivos de qualquer pasta local ou rede Windows (UNC), ajuste cópias, reordene e imprima em formato A5.
          </p>
        </div>
        <div className="toolbar">
          <button onClick={() => run(handleAddFiles)}>+ Adicionar Arquivos…</button>
          <button className="subtle" onClick={() => run(handleAddFolder)}>
            + Adicionar Pasta…
          </button>
          <button
            className="subtle"
            disabled={!libraryData || libraryData.entries.length === 0}
            onClick={() => {
              setSelectedLibraryPaths(new Set());
              setShowLibraryModal(true);
            }}
          >
            + De Meus Cartazes
          </button>
          {queue.length > 0 && (
            <button
              className="subtle danger"
              onClick={() => {
                if (window.confirm('Deseja limpar todos os cartazes da fila de impressão?')) {
                  setQueue([]);
                  setNotification('Fila limpa com sucesso.');
                }
              }}
            >
              Limpar fila
            </button>
          )}
        </div>
      </div>

      {notification && (
        <div className="import-warning" style={{ margin: '14px 0' }} role="status">
          <span>{notification}</span>
          <button
            type="button"
            className="subtle"
            style={{ float: 'right', padding: '2px 8px', fontSize: 11 }}
            onClick={() => setNotification(null)}
          >
            Fechar
          </button>
        </div>
      )}

      {/* Summary statistics */}
      <div className="import-stats" aria-live="polite">
        <span>
          <strong>{summary.totalDistinct}</strong> cartazes na fila
        </span>
        <span>
          <strong>{summary.totalCopies}</strong> folhas A5 totais
        </span>
        <span>
          <strong>{summary.readyCount}</strong> prontos para impressão
        </span>
        {summary.errorCount > 0 && (
          <span style={{ background: '#fde8e8', color: '#9e233b' }}>
            <strong style={{ color: '#9e233b' }}>{summary.errorCount}</strong> com erro / inacessíveis
          </span>
        )}
        {isProcessingQueue && (
          <span>
            <strong>{summary.loadingCount}</strong> carregando…
          </span>
        )}
      </div>

      {/* Empty State */}
      {queue.length === 0 ? (
        <div className="empty" style={{ textAlign: 'center', padding: '48px 16px' }}>
          <p style={{ fontSize: 16, fontWeight: 600, color: '#34415a', marginBottom: 8 }}>
            A fila do Condutor de Impressão está vazia.
          </p>
          <p style={{ color: '#68778f', maxWidth: 540, margin: '0 auto 20px' }}>
            Clique em <strong>+ Adicionar Arquivos</strong> ou <strong>+ Adicionar Pasta</strong> para incluir cartazes (.skcartaz ou .psd) de qualquer pasta do Windows, ou adicione direto do Editor e de Meus Cartazes.
          </p>
          <div className="toolbar" style={{ justifyContent: 'center' }}>
            <button onClick={() => run(handleAddFiles)}>Adicionar Arquivos</button>
            <button className="subtle" onClick={() => run(handleAddFolder)}>
              Adicionar Pasta Inteira
            </button>
          </div>
        </div>
      ) : (
        <div className="offer-workspace" style={{ gridTemplateColumns: 'minmax(0, 1fr) 370px' }}>
          {/* Queue Table */}
          <div>
            <div className="library-toolbar" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: '#4b5563', alignSelf: 'center' }}>
                Arraste ou use as setas para definir a ordem exata de saída da impressora.
              </span>
              <button
                disabled={summary.readyCount === 0}
                style={{ padding: '10px 18px', fontSize: 14 }}
                onClick={() => run(handlePrintConductor)}
              >
                Imprimir Condutor ({summary.totalCopies} folhas A5)
              </button>
            </div>

            <div className="import-table-wrap">
              <table className="import-table">
                <thead>
                  <tr>
                    <th style={{ width: 68 }}>Ordem</th>
                    <th style={{ width: 60 }}>Prévia</th>
                    <th>Produto / Cartaz</th>
                    <th>Origem / Caminho</th>
                    <th style={{ width: 100 }}>Preço</th>
                    <th style={{ width: 110 }}>Cópias</th>
                    <th style={{ width: 50 }}>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((item, index) => {
                    const isSelected = item.id === selectedId;
                    const isNetwork = item.sourcePath.startsWith('\\\\');
                    return (
                      <tr
                        key={item.id}
                        className={isSelected ? 'folder selected' : ''}
                        style={{
                          background: isSelected ? '#edf3fe' : undefined,
                          cursor: 'pointer',
                        }}
                        onClick={() => setSelectedId(item.id)}
                      >
                        {/* Order buttons */}
                        <td onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
                            <button
                              type="button"
                              className="subtle"
                              disabled={index === 0}
                              style={{ padding: '2px 6px', fontSize: 10, lineHeight: 1 }}
                              title="Subir na fila de impressão"
                              onClick={() => setQueue(q => moveQueueItem(q, index, index - 1))}
                            >
                              ▲
                            </button>
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#4b5563' }}>
                              #{index + 1}
                            </span>
                            <button
                              type="button"
                              className="subtle"
                              disabled={index === queue.length - 1}
                              style={{ padding: '2px 6px', fontSize: 10, lineHeight: 1 }}
                              title="Descer na fila de impressão"
                              onClick={() => setQueue(q => moveQueueItem(q, index, index + 1))}
                            >
                              ▼
                            </button>
                          </div>
                        </td>

                        {/* Thumbnail */}
                        <td>
                          <div
                            style={{
                              width: 48,
                              height: 64,
                              background: '#e7ecf4',
                              borderRadius: 4,
                              overflow: 'hidden',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              border: '1px solid #dfe5ee',
                            }}
                          >
                            {item.thumbnailUrl ? (
                              <img
                                src={item.thumbnailUrl}
                                alt={item.name}
                                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                              />
                            ) : item.status === 'error' ? (
                              <span style={{ color: '#9e233b', fontSize: 16 }}>⚠</span>
                            ) : item.status === 'loading' ? (
                              <span style={{ fontSize: 10, color: '#68778f' }}>…</span>
                            ) : (
                              <span style={{ fontSize: 9, color: '#68778f' }}>A5</span>
                            )}
                          </div>
                        </td>

                        {/* Product Info */}
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <strong>{item.name}</strong>
                            <span
                              style={{
                                fontSize: 10,
                                padding: '2px 6px',
                                borderRadius: 4,
                                background: item.fileFormat === 'psd' ? '#eef2ff' : '#f0fdf4',
                                color: item.fileFormat === 'psd' ? '#4338ca' : '#15803d',
                                fontWeight: 700,
                              }}
                            >
                              .{item.fileFormat}
                            </span>
                            {item.f7 ? (
                              <span className="code-cell" style={{ fontSize: 11 }}>
                                F7: {item.f7}
                              </span>
                            ) : (
                              <small style={{ color: '#9ca3af' }}>Sem F7</small>
                            )}
                          </div>
                          {item.detail && (
                            <small style={{ color: '#68778f', display: 'block', marginTop: 2 }}>
                              {item.detail}
                            </small>
                          )}
                          {item.status === 'error' && (
                            <small style={{ color: '#9e233b', fontWeight: 600, display: 'block', marginTop: 4 }}>
                              ⚠ {item.errorMessage || 'Falha de leitura'}
                            </small>
                          )}
                        </td>

                        {/* Origin Path */}
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                            {isNetwork && (
                              <span
                                style={{
                                  fontSize: 10,
                                  background: '#fef3c7',
                                  color: '#92400e',
                                  padding: '1px 5px',
                                  borderRadius: 4,
                                  fontWeight: 700,
                                }}
                              >
                                Rede UNC
                              </span>
                            )}
                            {item.sourceType === 'library' && (
                              <span
                                style={{
                                  fontSize: 10,
                                  background: '#e0f2fe',
                                  color: '#0369a1',
                                  padding: '1px 5px',
                                  borderRadius: 4,
                                  fontWeight: 700,
                                }}
                              >
                                Meus Cartazes
                              </span>
                            )}
                            {item.sourceType === 'editor' && (
                              <span
                                style={{
                                  fontSize: 10,
                                  background: '#f3e8ff',
                                  color: '#7e22ce',
                                  padding: '1px 5px',
                                  borderRadius: 4,
                                  fontWeight: 700,
                                }}
                              >
                                Editor
                              </span>
                            )}
                          </div>
                          <small
                            className="document-path"
                            style={{
                              fontSize: 11,
                              maxWidth: 240,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              display: 'block',
                            }}
                            title={item.sourcePath}
                          >
                            {item.sourcePath}
                          </small>
                        </td>

                        {/* Price */}
                        <td>
                          {item.price ? (
                            <strong>R$ {item.price}</strong>
                          ) : (
                            <small style={{ color: '#9ca3af' }}>—</small>
                          )}
                          {item.unit && (
                            <small style={{ display: 'block', color: '#68778f' }}>{item.unit}</small>
                          )}
                        </td>

                        {/* Copies */}
                        <td onClick={e => e.stopPropagation()}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <button
                              type="button"
                              className="subtle"
                              disabled={item.copies <= 1}
                              style={{ padding: '4px 8px', fontSize: 12 }}
                              onClick={() =>
                                setQueue(q => updateQueueItemCopies(q, item.id, item.copies - 1))
                              }
                            >
                              -
                            </button>
                            <input
                              type="number"
                              min={1}
                              max={999}
                              value={item.copies}
                              onChange={e =>
                                setQueue(q =>
                                  updateQueueItemCopies(q, item.id, parseInt(e.target.value, 10) || 1)
                                )
                              }
                              style={{ width: 48, textAlign: 'center', padding: '4px 2px' }}
                            />
                            <button
                              type="button"
                              className="subtle"
                              style={{ padding: '4px 8px', fontSize: 12 }}
                              onClick={() =>
                                setQueue(q => updateQueueItemCopies(q, item.id, item.copies + 1))
                              }
                            >
                              +
                            </button>
                          </div>
                        </td>

                        {/* Remove */}
                        <td onClick={e => e.stopPropagation()}>
                          <button
                            type="button"
                            className="remove"
                            aria-label={`Remover ${item.name}`}
                            title="Remover da fila"
                            onClick={() => setQueue(q => removeQueueItem(q, item.id))}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Preview Panel */}
          <div className="offer-preview-box">
            <h3>Prévia do Cartaz Selecionado</h3>
            {selectedItem ? (
              <>
                <div style={{ marginBottom: 10, fontSize: 12 }}>
                  <strong>{selectedItem.name}</strong>
                  {selectedItem.detail && <span> · {selectedItem.detail}</span>}
                  {selectedItem.price && <span> · R$ {selectedItem.price}</span>}
                  <div style={{ fontSize: 11, color: '#68778f', marginTop: 4 }}>
                    Cópias configuradas: <strong>{selectedItem.copies}</strong> folha(s) A5
                  </div>
                </div>

                <div className="paper-wrap" style={{ height: 460 }}>
                  {selectedItem.poster ? (
                    <PosterView poster={selectedItem.poster} />
                  ) : selectedItem.status === 'loading' ? (
                    <div style={{ textAlign: 'center', padding: 40, color: '#68778f' }}>
                      <p>Carregando arte do cartaz…</p>
                    </div>
                  ) : selectedItem.status === 'error' ? (
                    <div style={{ textAlign: 'center', padding: 24, color: '#9e233b' }}>
                      <p style={{ fontWeight: 700 }}>Erro ao carregar cartaz:</p>
                      <p style={{ fontSize: 12 }}>{selectedItem.errorMessage}</p>
                      <button
                        type="button"
                        className="subtle"
                        style={{ marginTop: 12 }}
                        onClick={() => {
                          run(async () => {
                            const reloaded = await loadConductorItem(selectedItem);
                            setQueue(q => q.map(it => (it.id === reloaded.id ? reloaded : it)));
                          });
                        }}
                      >
                        Tentar recarregar
                      </button>
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', padding: 40, color: '#68778f' }}>
                      <p>Aguardando leitura do arquivo…</p>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="empty">Selecione um cartaz na tabela para ver a prévia.</p>
            )}
          </div>
        </div>
      )}

      {/* Modal: Select from Library */}
      {showLibraryModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="lib-modal-title">
          <div className="modal price-confirmation" style={{ width: 'min(760px, 94vw)' }}>
            <h3 id="lib-modal-title">Adicionar Cartazes de "Meus Cartazes"</h3>
            <p style={{ color: '#68778f', margin: '4px 0 16px' }}>
              Selecione os cartazes salvos na sua biblioteca para adicionar à fila de impressão.
            </p>

            <div className="library-toolbar" style={{ marginBottom: 12 }}>
              <input
                placeholder="Pesquisar por nome ou F7…"
                value={librarySearch}
                onChange={e => setLibrarySearch(e.target.value)}
              />
              <button
                type="button"
                className="subtle"
                onClick={() => {
                  const all = new Set(filteredLibraryEntries.map(e => e.path));
                  setSelectedLibraryPaths(all);
                }}
              >
                Selecionar todos ({filteredLibraryEntries.length})
              </button>
              <button
                type="button"
                className="subtle"
                onClick={() => setSelectedLibraryPaths(new Set())}
              >
                Desmarcar todos
              </button>
            </div>

            <div className="import-table-wrap" style={{ maxHeight: '45vh' }}>
              <table className="import-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}></th>
                    <th>Cartaz / Produto</th>
                    <th>F7</th>
                    <th>Preço</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLibraryEntries.map(entry => {
                    const isChecked = selectedLibraryPaths.has(entry.path);
                    let doc: Cartaz | null = null;
                    try {
                      if (entry.content) doc = JSON.parse(entry.content);
                    } catch {}

                    return (
                      <tr
                        key={entry.path}
                        style={{ cursor: 'pointer', background: isChecked ? '#edf3fe' : undefined }}
                        onClick={() => {
                          const next = new Set(selectedLibraryPaths);
                          if (next.has(entry.path)) next.delete(entry.path);
                          else next.add(entry.path);
                          setSelectedLibraryPaths(next);
                        }}
                      >
                        <td>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {}} // Handled by tr onClick
                          />
                        </td>
                        <td>
                          <strong>{doc?.product.name || entry.name}</strong>
                          {doc?.product.complement && (
                            <small>{doc.product.complement}</small>
                          )}
                        </td>
                        <td className="code-cell">{doc?.product.productCode || '—'}</td>
                        <td>{doc ? `R$ ${formatCentsBr(doc.product.priceCents)}` : '—'}</td>
                      </tr>
                    );
                  })}
                  {filteredLibraryEntries.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', padding: 24, color: '#68778f' }}>
                        Nenhum cartaz encontrado com os critérios de busca.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="toolbar" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="subtle"
                onClick={() => setShowLibraryModal(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={selectedLibraryPaths.size === 0}
                onClick={handleConfirmAddFromLibrary}
              >
                Adicionar {selectedLibraryPaths.size} selecionado(s) à fila
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
