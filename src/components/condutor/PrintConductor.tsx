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
import {
  partitionQueueIntoBatches,
  prepareBatchPosters,
  releaseBatchMemory,
  type ConductorBatchPlan,
  type ConductorBatchStatus,
} from '../../features/condutor/batching';
import type { ConductorQueueItem } from '../../features/condutor/types';

type Props = {
  queue: ConductorQueueItem[];
  setQueue: React.Dispatch<React.SetStateAction<ConductorQueueItem[]>>;
  libraryData: LibraryData | null;
  run: (action: () => Promise<void>) => void;
  onPrintBatch: (
    posters: Poster[] | null,
    options?: {
      onReadyToPrint?: () => void;
      onDialogClosed?: () => void;
      keepMountedUntilConfirmed?: boolean;
    }
  ) => Promise<void> | void;
};

function compactPath(fullPath: string): string {
  if (!fullPath) return '';
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return fullPath;
  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  const isUNC = fullPath.startsWith('\\\\');
  return `${isUNC ? '\\\\' : ''}…\\${parent}\\${last}`;
}

export function PrintConductor({ queue, setQueue, libraryData, run, onPrintBatch }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [showLibraryModal, setShowLibraryModal] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [selectedLibraryPaths, setSelectedLibraryPaths] = useState<Set<string>>(new Set());
  const [notification, setNotification] = useState<string | null>(null);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);

  // Enlarged preview modal state
  const [enlargedItem, setEnlargedItem] = useState<ConductorQueueItem | null>(null);
  const [enlargedPoster, setEnlargedPoster] = useState<Poster | null>(null);
  const [loadingEnlarged, setLoadingEnlarged] = useState(false);

  // Batch print state
  const [batchSize, setBatchSize] = useState<number>(20);
  const [batchExecution, setBatchExecution] = useState<{
    allPlans: ConductorBatchPlan[];
    currentIndex: number;
    status: ConductorBatchStatus;
    preparedPosters: Poster[];
    errors: string[];
    printedPagesCount: number;
  } | null>(null);

  const processingRef = useRef(false);

  // Automatically select first item if none is selected
  useEffect(() => {
    if (queue.length > 0 && (!selectedId || !queue.some(i => i.id === selectedId))) {
      setSelectedId(queue[0].id);
    } else if (queue.length === 0) {
      setSelectedId(null);
    }
  }, [queue, selectedId]);

  // Progressive background loader for idle items (keeps heap lightweight by not retaining full posters in queue)
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
      },
      undefined,
      { keepFullPoster: false }
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

  // Side-panel preview on demand
  const [selectedPoster, setSelectedPoster] = useState<Poster | null>(null);
  useEffect(() => {
    let active = true;
    if (!selectedItem) {
      setSelectedPoster(null);
      return;
    }
    if (selectedItem.poster) {
      setSelectedPoster(selectedItem.poster);
      return;
    }
    loadConductorItem(selectedItem, undefined, { keepFullPoster: true })
      .then(loaded => {
        if (active && loaded.poster) {
          setSelectedPoster(loaded.poster);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selectedId, selectedItem]);

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

  // Open enlarged modal
  const handleOpenEnlarged = (item: ConductorQueueItem) => {
    setEnlargedItem(item);
    if (item.poster) {
      setEnlargedPoster(item.poster);
      return;
    }
    setLoadingEnlarged(true);
    loadConductorItem(item, undefined, { keepFullPoster: true })
      .then(loaded => {
        setEnlargedPoster(loaded.poster || null);
      })
      .catch(() => setEnlargedPoster(null))
      .finally(() => setLoadingEnlarged(false));
  };

  const handleCloseEnlarged = () => {
    setEnlargedItem(null);
    setEnlargedPoster(null);
  };

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

  // Handler: Start printing (Controlled batch execution)
  const handlePrintConductor = async () => {
    if (queue.length === 0) return;

    // Ensure pending items have basic metadata loaded
    let currentQueue = queue;
    if (queue.some(it => it.status === 'idle' || it.status === 'loading')) {
      setNotification('Concluindo carregamento dos cartazes antes de imprimir…');
      currentQueue = await loadQueueConcurrently(queue, 2, undefined, undefined, { keepFullPoster: false });
      setQueue(currentQueue);
    }

    const { skippedErrors, totalCopies, distinctItemsCount } = buildConductorPrintBatch(currentQueue);

    if (distinctItemsCount === 0 || totalCopies === 0) {
      throw new Error(
        skippedErrors.length > 0
          ? `Nenhum cartaz pronto para impressão. Erros encontrados:\n${skippedErrors.join('\n')}`
          : 'Nenhum cartaz válido na fila para imprimir.'
      );
    }

    // Se existirem erros ou ausentes, alertar e solicitar confirmação
    if (skippedErrors.length > 0) {
      const summaryMsg =
        `Resumo antes de imprimir:\n\n` +
        `• ${distinctItemsCount} cartaz(es) válidos serão preparados (${totalCopies} folhas A5).\n` +
        `• ${skippedErrors.length} cartaz(es) com erro ou inacessíveis serão IGNORADOS:\n` +
        skippedErrors.slice(0, 6).map(e => `  - ${e}`).join('\n') +
        (skippedErrors.length > 6 ? `\n  ... e outros ${skippedErrors.length - 6} arquivo(s)` : '') +
        `\n\nDeseja prosseguir com a impressão dos ${totalCopies} cartazes válidos?`;

      const proceed = window.confirm(summaryMsg);
      if (!proceed) return;
    }

    const plans = partitionQueueIntoBatches(currentQueue, batchSize);
    if (plans.length === 0) return;

    const firstPlan = plans[0];
    setNotification(
      plans.length > 1
        ? `Iniciando impressão em lotes: ${plans.length} lotes de até ${batchSize} páginas A5 (Total: ${totalCopies} folhas).`
        : `Preparando lote único de ${totalCopies} folhas A5…`
    );

    setBatchExecution({
      allPlans: plans,
      currentIndex: 0,
      status: 'preparing',
      preparedPosters: [],
      errors: [],
      printedPagesCount: 0,
    });

    const { posters: firstBatchPosters, errors: firstBatchErrors } = await prepareBatchPosters(
      firstPlan,
      currentQueue
    );

    setBatchExecution(prev => (prev ? {
      ...prev,
      preparedPosters: firstBatchPosters,
      errors: firstBatchErrors,
      status: 'ready',
    } : null));

    await onPrintBatch(firstBatchPosters, {
      onReadyToPrint: () => {
        setBatchExecution(prev => (prev ? { ...prev, status: 'dialog_open' } : null));
      },
      onDialogClosed: () => {
        setBatchExecution(prev => (prev ? { ...prev, status: 'waiting_confirmation' } : null));
      },
      keepMountedUntilConfirmed: true,
    });
  };

  const handleConfirmAdvanceBatch = async () => {
    if (!batchExecution) return;

    const currentPlan = batchExecution.allPlans[batchExecution.currentIndex];
    const newPrintedCount = batchExecution.printedPagesCount + currentPlan.pageCount;
    const nextIndex = batchExecution.currentIndex + 1;

    // Se era o último lote, finaliza e libera tudo
    if (nextIndex >= batchExecution.allPlans.length) {
      await onPrintBatch(null);
      releaseBatchMemory();
      setBatchExecution(null);
      setNotification(
        `Todos os ${batchExecution.allPlans.length} lotes foram confirmados com sucesso! (${newPrintedCount} folhas A5 concluídas).`
      );
      return;
    }

    // Libera a memória do lote anterior antes de preparar o seguinte
    await onPrintBatch(null);
    releaseBatchMemory();

    const nextPlan = batchExecution.allPlans[nextIndex];
    setNotification(
      `Preparando Lote ${nextPlan.batchNumber} de ${nextPlan.totalBatches} (${nextPlan.pageCount} páginas)…`
    );

    setBatchExecution({
      ...batchExecution,
      currentIndex: nextIndex,
      status: 'preparing',
      preparedPosters: [],
      errors: [],
      printedPagesCount: newPrintedCount,
    });

    const { posters: nextPosters, errors: nextErrors } = await prepareBatchPosters(
      nextPlan,
      queue
    );

    setBatchExecution(prev => (prev ? {
      ...prev,
      preparedPosters: nextPosters,
      errors: nextErrors,
      status: 'ready',
    } : null));

    await onPrintBatch(nextPosters, {
      onReadyToPrint: () => {
        setBatchExecution(prev => (prev ? { ...prev, status: 'dialog_open' } : null));
      },
      onDialogClosed: () => {
        setBatchExecution(prev => (prev ? { ...prev, status: 'waiting_confirmation' } : null));
      },
      keepMountedUntilConfirmed: true,
    });
  };

  const handleRepeatCurrentBatch = async () => {
    if (!batchExecution || batchExecution.preparedPosters.length === 0) return;
    const currentPlan = batchExecution.allPlans[batchExecution.currentIndex];
    setNotification(
      `Reenviando Lote ${currentPlan.batchNumber} de ${currentPlan.totalBatches} (${currentPlan.pageCount} páginas) para a impressora…`
    );

    await onPrintBatch(batchExecution.preparedPosters, {
      onReadyToPrint: () => {
        setBatchExecution(prev => (prev ? { ...prev, status: 'dialog_open' } : null));
      },
      onDialogClosed: () => {
        setBatchExecution(prev => (prev ? { ...prev, status: 'waiting_confirmation' } : null));
      },
      keepMountedUntilConfirmed: true,
    });
  };

  const handleCancelBatchPrinting = async () => {
    if (!batchExecution) return;
    const printedSoFar = batchExecution.printedPagesCount;
    await onPrintBatch(null);
    releaseBatchMemory();
    setBatchExecution(null);
    setNotification(
      `Impressão em lotes cancelada. ${printedSoFar} folha(s) A5 foram confirmadas nos lotes anteriores. A fila original permanece intacta.`
    );
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

      {/* Batch Execution Progress Banner */}
      {batchExecution && (
        <div
          role="region"
          aria-label="Controle de Impressão em Lotes"
          style={{
            background:
              batchExecution.status === 'dialog_open'
                ? '#fefce8'
                : batchExecution.status === 'waiting_confirmation'
                ? '#fffbeb'
                : batchExecution.status === 'ready'
                ? '#f0fdf4'
                : '#eef4ff',
            border:
              batchExecution.status === 'dialog_open'
                ? '2px solid #ca8a04'
                : batchExecution.status === 'waiting_confirmation'
                ? '2px solid #d97706'
                : batchExecution.status === 'ready'
                ? '2px solid #16a34a'
                : '2px solid #3b82f6',
            borderRadius: 8,
            padding: '16px 20px',
            margin: '12px 0 16px 0',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                <span
                  style={{
                    background:
                      batchExecution.status === 'dialog_open'
                        ? '#ca8a04'
                        : batchExecution.status === 'waiting_confirmation'
                        ? '#d97706'
                        : batchExecution.status === 'ready'
                        ? '#16a34a'
                        : '#2563eb',
                    color: '#ffffff',
                    fontWeight: 700,
                    fontSize: 11,
                    padding: '3px 8px',
                    borderRadius: 4,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}
                >
                  {batchExecution.status === 'preparing' && 'Preparando lote'}
                  {batchExecution.status === 'ready' && 'Lote pronto'}
                  {batchExecution.status === 'dialog_open' && 'Diálogo de impressão aberto'}
                  {batchExecution.status === 'waiting_confirmation' && 'Aguardando conferência manual'}
                  {batchExecution.status === 'confirmed' && 'Lote confirmado'}
                  {batchExecution.status === 'cancelled' && 'Cancelado'}
                </span>
                <strong style={{ fontSize: 16, color: '#0f172a' }}>
                  Lote {batchExecution.currentIndex + 1} de {batchExecution.allPlans.length} (
                  {batchExecution.allPlans[batchExecution.currentIndex]?.pageCount} páginas A5)
                </strong>
              </div>

              <p style={{ margin: '4px 0 0 0', fontSize: 13, color: '#334155', lineHeight: 1.5 }}>
                {batchExecution.status === 'preparing' && (
                  <span>Carregando composições em alta fidelidade e aguardando renderização dos canvas…</span>
                )}
                {batchExecution.status === 'ready' && (
                  <span>Todas as páginas e fontes foram renderizadas. Abrindo diálogo do Windows…</span>
                )}
                {batchExecution.status === 'dialog_open' && (
                  <span>O diálogo de impressão do Windows está aberto. Selecione a impressora e clique em Imprimir.</span>
                )}
                {batchExecution.status === 'waiting_confirmation' && (
                  <span>
                    O diálogo de impressão foi fechado. <strong>Confira as folhas na bandeja da impressora.</strong> Só confirme o lote quando as impressões saírem corretamente.
                  </span>
                )}
              </p>

              <div style={{ marginTop: 6, fontSize: 12, color: '#475569' }}>
                Folhas confirmadas até agora: <strong>{batchExecution.printedPagesCount}</strong> de{' '}
                <strong>{summary.totalCopies}</strong> folhas totais. Memória do lote anterior liberada.
              </div>

              {batchExecution.errors.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#b91c1c' }}>
                  Avisos neste lote: {batchExecution.errors.join('; ')}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                style={{
                  background: '#16a34a',
                  borderColor: '#15803d',
                  color: '#ffffff',
                  fontWeight: 600,
                  padding: '8px 16px',
                }}
                disabled={batchExecution.status === 'preparing'}
                onClick={() => run(handleConfirmAdvanceBatch)}
              >
                {batchExecution.currentIndex + 1 < batchExecution.allPlans.length
                  ? `✓ Confirmar lote e avançar para Lote ${batchExecution.currentIndex + 2}`
                  : '✓ Confirmar último lote e finalizar'}
              </button>
              <button
                type="button"
                className="subtle"
                disabled={batchExecution.status === 'preparing'}
                onClick={() => run(handleRepeatCurrentBatch)}
                title="Reenviar este lote para a impressora se houve atolamento de papel ou erro no driver"
              >
                ↻ Repetir este lote
              </button>
              <button
                type="button"
                className="subtle danger"
                onClick={() => run(handleCancelBatchPrinting)}
                title="Cancela os lotes pendentes mantendo a fila original intacta"
              >
                ✕ Cancelar lotes restantes
              </button>
            </div>
          </div>
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
        <div
          className="offer-workspace"
          style={{
            gridTemplateColumns: viewMode === 'grid' ? '1fr' : 'minmax(0, 1fr) 370px',
            alignItems: 'start',
          }}
        >
          {/* Main Queue View */}
          <div>
            {/* Sticky Queue Toolbar */}
            <div
              className="library-toolbar"
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 10,
                background: '#ffffff',
                padding: '12px 14px',
                borderRadius: 8,
                marginBottom: 14,
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                border: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <select
                  aria-label="Modo de visualização"
                  value={viewMode}
                  onChange={e => setViewMode(e.target.value as 'list' | 'grid')}
                  style={{ padding: '6px 10px', fontSize: 13, borderRadius: 6 }}
                >
                  <option value="list">☰ Lista</option>
                  <option value="grid">☷ Grade</option>
                </select>
                <span style={{ fontSize: 12, color: '#64748b' }}>
                  {viewMode === 'list' ? 'Arraste ou use setas para reordenar' : 'Cartazes organizados em cartões'}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label
                  style={{
                    fontSize: 12,
                    color: '#4b5563',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    background: '#f1f5f9',
                    padding: '4px 8px',
                    borderRadius: 4,
                  }}
                  title="Quantidade máxima de páginas A5 renderizadas por lote de impressão para proteção de memória"
                >
                  <span>Lote:</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={batchSize}
                    onChange={e => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val)) setBatchSize(Math.max(1, Math.min(50, val)));
                    }}
                    style={{ width: 44, padding: '2px 4px', textAlign: 'center', fontSize: 12 }}
                  />
                  <span>págs</span>
                </label>
                <button
                  disabled={summary.readyCount === 0 || !!batchExecution}
                  style={{ padding: '8px 18px', fontSize: 13, fontWeight: 700 }}
                  onClick={() => run(handlePrintConductor)}
                >
                  {summary.totalCopies > batchSize
                    ? `Imprimir em Lotes (${Math.ceil(summary.totalCopies / batchSize)} lotes · ${summary.totalCopies} folhas)`
                    : `Imprimir Condutor (${summary.totalCopies} folhas A5)`}
                </button>
              </div>
            </div>

            {/* List Mode View */}
            {viewMode === 'list' && (
              <div className="import-table-wrap">
                <table className="import-table">
                  <thead>
                    <tr>
                      <th style={{ width: 64 }}>Ordem</th>
                      <th style={{ width: 54 }}>Prévia</th>
                      <th>Produto / Cartaz</th>
                      <th>Origem / Caminho</th>
                      <th style={{ width: 90 }}>Preço</th>
                      <th style={{ width: 110 }}>Cópias</th>
                      <th style={{ width: 70 }}>Ação</th>
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

                          {/* Thumbnail with zoom click */}
                          <td onClick={e => e.stopPropagation()} style={{ textAlign: 'center' }}>
                            <div
                              style={{
                                width: 44,
                                height: 60,
                                background: '#f8fafc',
                                borderRadius: 4,
                                overflow: 'hidden',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                border: '1px solid #cbd5e1',
                                cursor: 'pointer',
                                margin: '0 auto',
                              }}
                              onClick={() => handleOpenEnlarged(item)}
                              title="Clique para ver prévia ampliada"
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

                          {/* Product Info - Horizontal single line name without vertical break */}
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div
                                style={{
                                  fontWeight: 700,
                                  fontSize: 13,
                                  color: '#0f172a',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  maxWidth: 240,
                                }}
                                title={item.name}
                              >
                                {item.name}
                              </div>
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: '1px 5px',
                                  borderRadius: 4,
                                  background: item.fileFormat === 'psd' ? '#eef2ff' : '#f0fdf4',
                                  color: item.fileFormat === 'psd' ? '#4338ca' : '#15803d',
                                  fontWeight: 700,
                                  flexShrink: 0,
                                }}
                              >
                                .{item.fileFormat}
                              </span>
                              {item.f7 && (
                                <span className="code-cell" style={{ fontSize: 10, padding: '1px 4px' }}>
                                  F7: {item.f7}
                                </span>
                              )}
                            </div>
                            {item.detail && (
                              <small
                                style={{
                                  color: '#64748b',
                                  display: 'block',
                                  marginTop: 2,
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  maxWidth: 240,
                                }}
                              >
                                {item.detail}
                              </small>
                            )}
                            {item.status === 'error' && (
                              <small style={{ color: '#9e233b', fontWeight: 600, display: 'block', marginTop: 4 }}>
                                ⚠ {item.errorMessage || 'Falha de leitura'}
                              </small>
                            )}
                          </td>

                          {/* Origin Path - Compact with full path tooltip */}
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                              {isNetwork && (
                                <span
                                  style={{
                                    fontSize: 9,
                                    background: '#fef3c7',
                                    color: '#92400e',
                                    padding: '1px 4px',
                                    borderRadius: 3,
                                    fontWeight: 700,
                                  }}
                                >
                                  Rede UNC
                                </span>
                              )}
                              {item.sourceType === 'library' && (
                                <span
                                  style={{
                                    fontSize: 9,
                                    background: '#e0f2fe',
                                    color: '#0369a1',
                                    padding: '1px 4px',
                                    borderRadius: 3,
                                    fontWeight: 700,
                                  }}
                                >
                                  Biblioteca
                                </span>
                              )}
                              {item.sourceType === 'editor' && (
                                <span
                                  style={{
                                    fontSize: 9,
                                    background: '#f3e8ff',
                                    color: '#7e22ce',
                                    padding: '1px 4px',
                                    borderRadius: 3,
                                    fontWeight: 700,
                                  }}
                                >
                                  Editor
                                </span>
                              )}
                            </div>
                            <span
                              style={{
                                fontSize: 11,
                                color: '#64748b',
                                maxWidth: 220,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                display: 'inline-block',
                              }}
                              title={item.sourcePath}
                            >
                              {compactPath(item.sourcePath)}
                            </span>
                          </td>

                          {/* Price */}
                          <td>
                            {item.price ? (
                              <strong style={{ fontSize: 13, color: '#0f172a' }}>R$ {item.price}</strong>
                            ) : (
                              <small style={{ color: '#9ca3af' }}>—</small>
                            )}
                            {item.unit && (
                              <small style={{ display: 'block', color: '#64748b', fontSize: 11 }}>{item.unit}</small>
                            )}
                          </td>

                          {/* Copies */}
                          <td onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                              <button
                                type="button"
                                className="subtle"
                                disabled={item.copies <= 1}
                                style={{ padding: '3px 7px', fontSize: 12 }}
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
                                style={{ width: 42, textAlign: 'center', padding: '3px 2px', fontSize: 12 }}
                              />
                              <button
                                type="button"
                                className="subtle"
                                style={{ padding: '3px 7px', fontSize: 12 }}
                                onClick={() =>
                                  setQueue(q => updateQueueItemCopies(q, item.id, item.copies + 1))
                                }
                              >
                                +
                              </button>
                            </div>
                          </td>

                          {/* Actions */}
                          <td onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <button
                                type="button"
                                className="subtle"
                                style={{ padding: '4px 6px', fontSize: 11 }}
                                title="Ver prévia ampliada"
                                onClick={() => handleOpenEnlarged(item)}
                              >
                                🔍
                              </button>
                              <button
                                type="button"
                                className="remove"
                                aria-label={`Remover ${item.name}`}
                                title="Remover da fila"
                                onClick={() => setQueue(q => removeQueueItem(q, item.id))}
                              >
                                ×
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Grid Mode View */}
            {viewMode === 'grid' && (
              <div
                className="cards grid"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                  gap: 14,
                }}
              >
                {queue.map((item, index) => {
                  const isSelected = item.id === selectedId;
                  const isNetwork = item.sourcePath.startsWith('\\\\');
                  return (
                    <article
                      key={item.id}
                      className="cartaz-card"
                      style={{
                        border: isSelected ? '2px solid #2563eb' : '1px solid #cbd5e1',
                        borderRadius: 8,
                        padding: 10,
                        background: isSelected ? '#f8faff' : '#ffffff',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
                        position: 'relative',
                      }}
                      onClick={() => setSelectedId(item.id)}
                    >
                      {/* Card Thumbnail */}
                      <div
                        style={{
                          position: 'relative',
                          width: '100%',
                          height: 180,
                          background: '#f8fafc',
                          borderRadius: 6,
                          overflow: 'hidden',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                          border: '1px solid #e2e8f0',
                        }}
                        onClick={e => {
                          e.stopPropagation();
                          handleOpenEnlarged(item);
                        }}
                        title="Clique para ver prévia ampliada"
                      >
                        {item.thumbnailUrl ? (
                          <img
                            src={item.thumbnailUrl}
                            alt={item.name}
                            style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }}
                          />
                        ) : item.status === 'error' ? (
                          <span style={{ color: '#9e233b', fontSize: 24 }}>⚠</span>
                        ) : item.status === 'loading' ? (
                          <span style={{ fontSize: 12, color: '#64748b' }}>Carregando…</span>
                        ) : (
                          <span style={{ fontSize: 12, color: '#64748b' }}>A5</span>
                        )}

                        <span
                          style={{
                            position: 'absolute',
                            top: 6,
                            left: 6,
                            background: 'rgba(15, 23, 42, 0.75)',
                            color: '#ffffff',
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                          }}
                        >
                          #{index + 1}
                        </span>

                        <button
                          type="button"
                          className="subtle"
                          style={{
                            position: 'absolute',
                            top: 6,
                            right: 6,
                            background: 'rgba(255, 255, 255, 0.9)',
                            border: '1px solid #cbd5e1',
                            padding: '2px 6px',
                            fontSize: 11,
                            borderRadius: 4,
                          }}
                          title="Ampliar prévia"
                        >
                          🔍
                        </button>
                      </div>

                      {/* Card Info */}
                      <div>
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: 13,
                            color: '#0f172a',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                          title={item.name}
                        >
                          {item.name}
                        </div>
                        {item.detail && (
                          <div
                            style={{
                              fontSize: 11,
                              color: '#64748b',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              marginTop: 2,
                            }}
                          >
                            {item.detail}
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                          <span style={{ fontWeight: 800, fontSize: 14, color: '#1e3a8a' }}>
                            {item.price ? `R$ ${item.price}` : '—'}
                          </span>
                          <span style={{ fontSize: 11, color: '#64748b' }}>{item.unit || 'UN'}</span>
                        </div>
                      </div>

                      {/* Path tooltip */}
                      <div
                        style={{
                          fontSize: 10,
                          color: '#64748b',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                        title={item.sourcePath}
                      >
                        {isNetwork ? '🌐 ' : '📁 '}
                        {compactPath(item.sourcePath)}
                      </div>

                      {/* Copies & Reorder row */}
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginTop: 'auto',
                          paddingTop: 6,
                          borderTop: '1px solid #f1f5f9',
                        }}
                        onClick={e => e.stopPropagation()}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <button
                            type="button"
                            className="subtle"
                            disabled={item.copies <= 1}
                            style={{ padding: '2px 6px', fontSize: 11 }}
                            onClick={() =>
                              setQueue(q => updateQueueItemCopies(q, item.id, item.copies - 1))
                            }
                          >
                            -
                          </button>
                          <span style={{ fontSize: 12, fontWeight: 700, minWidth: 20, textAlign: 'center' }}>
                            {item.copies}
                          </span>
                          <button
                            type="button"
                            className="subtle"
                            style={{ padding: '2px 6px', fontSize: 11 }}
                            onClick={() =>
                              setQueue(q => updateQueueItemCopies(q, item.id, item.copies + 1))
                            }
                          >
                            +
                          </button>
                        </div>

                        <div style={{ display: 'flex', gap: 2 }}>
                          <button
                            type="button"
                            className="subtle"
                            disabled={index === 0}
                            style={{ padding: '2px 5px', fontSize: 10 }}
                            title="Mover para esquerda"
                            onClick={() => setQueue(q => moveQueueItem(q, index, index - 1))}
                          >
                            ◀
                          </button>
                          <button
                            type="button"
                            className="subtle"
                            disabled={index === queue.length - 1}
                            style={{ padding: '2px 5px', fontSize: 10 }}
                            title="Mover para direita"
                            onClick={() => setQueue(q => moveQueueItem(q, index, index + 1))}
                          >
                            ▶
                          </button>
                          <button
                            type="button"
                            className="remove"
                            style={{ marginLeft: 4 }}
                            title="Remover"
                            onClick={() => setQueue(q => removeQueueItem(q, item.id))}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          {/* Side Preview Panel (in List Mode) */}
          {viewMode === 'list' && (
            <div className="offer-preview-box" style={{ position: 'sticky', top: 14 }}>
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
                    {selectedPoster ? (
                      <PosterView poster={selectedPoster} />
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
                              const reloaded = await loadConductorItem(selectedItem, undefined, { keepFullPoster: true });
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
          )}
        </div>
      )}

      {/* Enlarged Modal Preview */}
      {enlargedItem && (
        <div className="modal-backdrop" onClick={handleCloseEnlarged}>
          <div
            className="panel modal"
            role="dialog"
            aria-modal="true"
            aria-label="Prévia ampliada do cartaz"
            style={{ maxWidth: 580, maxHeight: '92vh', overflowY: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Prévia Ampliada — {enlargedItem.name}</h2>
              <button type="button" className="subtle" onClick={handleCloseEnlarged}>
                ✕ Fechar
              </button>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                background: '#f8fafc',
                padding: 16,
                borderRadius: 8,
                marginBottom: 16,
              }}
            >
              {loadingEnlarged ? (
                <p style={{ color: '#64748b', padding: 40 }}>Carregando composição em alta fidelidade…</p>
              ) : enlargedPoster ? (
                <div style={{ maxWidth: 300, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
                  <PosterView poster={enlargedPoster} />
                </div>
              ) : enlargedItem.thumbnailUrl ? (
                <img
                  src={enlargedItem.thumbnailUrl}
                  alt={enlargedItem.name}
                  style={{ maxWidth: 280, borderRadius: 4, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}
                />
              ) : (
                <p style={{ color: '#ef4444' }}>Não foi possível carregar a prévia deste cartaz.</p>
              )}
            </div>

            <div
              style={{
                fontSize: 13,
                color: '#334155',
                display: 'grid',
                gridTemplateColumns: '120px 1fr',
                gap: '6px 12px',
                background: '#f1f5f9',
                padding: 12,
                borderRadius: 6,
              }}
            >
              <strong>Arquivo:</strong>
              <span style={{ wordBreak: 'break-all', fontSize: 12 }}>{enlargedItem.sourcePath}</span>
              <strong>Formato:</strong>
              <span>{enlargedItem.fileFormat.toUpperCase()}</span>
              <strong>Preço:</strong>
              <span>R$ {enlargedItem.price || '—'} / {enlargedItem.unit || 'UN'}</span>
              {enlargedItem.f7 && (
                <>
                  <strong>Código F7:</strong>
                  <span>{enlargedItem.f7}</span>
                </>
              )}
              {enlargedItem.validityText && (
                <>
                  <strong>Validade:</strong>
                  <span>{enlargedItem.validityText}</span>
                </>
              )}
              <strong>Cópias na fila:</strong>
              <span>{enlargedItem.copies} folha(s) A5</span>
            </div>

            <div className="toolbar" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
              <button type="button" onClick={handleCloseEnlarged}>
                Fechar
              </button>
            </div>
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
