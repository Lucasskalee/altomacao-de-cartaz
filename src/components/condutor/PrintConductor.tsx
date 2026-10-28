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
  extractFileBaseName,
  findDuplicateInQueue,
  inferFormatFromPath,
  loadConductorItem,
  loadQueueConcurrently,
  moveQueueItem,
  relocateQueueItem,
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
  const [showSidePreview, setShowSidePreview] = useState(true);
  const [showLibraryModal, setShowLibraryModal] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [selectedLibraryPaths, setSelectedLibraryPaths] = useState<Set<string>>(new Set());
  const [notification, setNotification] = useState<string | null>(null);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);

  // Modal de prévia ampliada
  const [enlargedItem, setEnlargedItem] = useState<ConductorQueueItem | null>(null);
  const [enlargedPoster, setEnlargedPoster] = useState<Poster | null>(null);
  const [loadingEnlarged, setLoadingEnlarged] = useState(false);

  // Estado de execução de impressão em lotes
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

  // Seleciona automaticamente o primeiro item se nenhum estiver selecionado
  useEffect(() => {
    if (queue.length > 0 && (!selectedId || !queue.some(i => i.id === selectedId))) {
      setSelectedId(queue[0].id);
    } else if (queue.length === 0) {
      setSelectedId(null);
    }
  }, [queue, selectedId]);

  // Carregador em segundo plano com keepFullPoster: false para proteger o consumo de memória
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

  // Prévia sob demanda do cartaz selecionado
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

  // Resumo de contadores
  const summary = useMemo(() => {
    let totalCopies = 0;
    let readyCopies = 0;
    let readyCount = 0;
    let errorCount = 0;
    let loadingCount = 0;

    for (const item of queue) {
      const copies = Math.max(1, item.copies || 1);
      totalCopies += copies;
      if (item.status === 'ready') {
        readyCount++;
        readyCopies += copies;
      } else if (item.status === 'error') {
        errorCount++;
      } else {
        loadingCount++;
      }
    }

    return {
      totalDistinct: queue.length,
      totalCopies,
      readyCopies,
      readyCount,
      errorCount,
      loadingCount,
    };
  }, [queue]);

  // Manipulador: Localizar ou atualizar caminho de um arquivo específico sem perder a fila
  const handleRelocateItem = async (itemId: string) => {
    const paths = await chooseConductorFiles();
    if (!paths || paths.length === 0) return;
    const newPath = paths[0];

    const targetItem = queue.find(it => it.id === itemId);
    if (!targetItem) return;

    const fileName = extractFileBaseName(newPath);
    const cleanTitle = fileName.replace(/\.(skcartaz|psd)$/i, '');

    setQueue(prev => relocateQueueItem(prev, itemId, newPath));
    setNotification(`Localizando arquivo para "${cleanTitle.toUpperCase()}"…`);

    try {
      const interimItem = relocateQueueItem(queue, itemId, newPath).find(it => it.id === itemId);
      if (!interimItem) return;
      const loaded = await loadConductorItem(interimItem, undefined, { keepFullPoster: false });
      setQueue(prev => prev.map(it => (it.id === itemId ? loaded : it)));
      if (loaded.status === 'ready') {
        setNotification(`Arquivo atualizado com sucesso: "${cleanTitle.toUpperCase()}" pronto para impressão.`);
      } else {
        setNotification(`Falha ao ler novo arquivo: ${loaded.errorMessage || 'Arquivo inválido'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setQueue(prev =>
        prev.map(it => (it.id === itemId ? { ...it, status: 'error', errorMessage: msg } : it))
      );
      setNotification(`Erro ao atualizar arquivo: ${msg}`);
    }
  };

  // Manipulador: Tentar recarregar arquivo individual (em caso de restauração de rede ou disco)
  const handleReloadItem = async (itemId: string) => {
    const targetItem = queue.find(it => it.id === itemId);
    if (!targetItem) return;

    setQueue(prev =>
      prev.map(it => (it.id === itemId ? { ...it, status: 'loading', errorMessage: undefined } : it))
    );
    setNotification(`Recarregando "${targetItem.name}"…`);

    try {
      const loaded = await loadConductorItem(
        { ...targetItem, status: 'loading', errorMessage: undefined },
        undefined,
        { keepFullPoster: false }
      );
      setQueue(prev => prev.map(it => (it.id === itemId ? loaded : it)));
      if (loaded.status === 'ready') {
        setNotification(`Cartaz "${loaded.name}" recarregado com sucesso.`);
      } else {
        setNotification(`Falha ao recarregar: ${loaded.errorMessage || 'Arquivo inacessível'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setQueue(prev =>
        prev.map(it => (it.id === itemId ? { ...it, status: 'error', errorMessage: msg } : it))
      );
      setNotification(`Erro ao recarregar: ${msg}`);
    }
  };

  // Abertura do modal de prévia ampliada
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

  // Manipulador: Adicionar arquivos avulsos
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
      setNotification(`${addedCount} arquivo(s) adicionado(s). ${duplicateCount} já constavam na fila.`);
    } else if (duplicateCount > 0 && addedCount === 0) {
      setNotification(`Todos os ${duplicateCount} arquivo(s) selecionados já estão na fila de impressão.`);
    } else {
      setNotification(`${addedCount} cartaz(es) adicionado(s) à fila.`);
    }
  };

  // Manipulador: Adicionar pasta inteira
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
        `Pasta varrida: ${addedCount} arquivo(s) adicionado(s). ${duplicateCount} já constavam na fila.`
      );
    } else {
      setNotification(`Pasta varrida: ${addedCount} cartaz(es) adicionado(s) à fila.`);
    }
  };

  // Manipulador: Adicionar de Meus Cartazes
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
      setNotification(`${addedCount} cartaz(es) da biblioteca adicionados. ${duplicateCount} já constavam na fila.`);
    } else {
      setNotification(`${addedCount} cartaz(es) da biblioteca adicionados à fila.`);
    }
  };

  // Manipulador: Iniciar impressão com controle de lotes
  const handlePrintConductor = async () => {
    if (queue.length === 0) return;

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
        : `Preparando lote de ${totalCopies} folha(s) A5…`
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
      currentQueue,
      undefined,
      (failedItem, errMsg) => {
        setQueue(q => q.map(it => (it.id === failedItem.id ? { ...it, status: 'error', errorMessage: errMsg } : it)));
      }
    );

    if (firstBatchPosters.length === 0) {
      setBatchExecution(null);
      setNotification('Nenhum cartaz pôde ser preparado neste lote. Verifique os erros individuais na fila.');
      return;
    }

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

    if (nextIndex >= batchExecution.allPlans.length) {
      await onPrintBatch(null);
      releaseBatchMemory();
      setBatchExecution(null);
      setNotification(
        `Todos os ${batchExecution.allPlans.length} lotes foram confirmados com sucesso! (${newPrintedCount} folhas A5 concluídas).`
      );
      return;
    }

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
      queue,
      undefined,
      (failedItem, errMsg) => {
        setQueue(q => q.map(it => (it.id === failedItem.id ? { ...it, status: 'error', errorMessage: errMsg } : it)));
      }
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

  // Filtragem da biblioteca de Meus Cartazes
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
      {/* Cabeçalho Principal */}
      <div className="library-heading">
        <div>
          <h2>Condutor de Impressão</h2>
          <p>
            Monte filas personalizadas com arquivos locais ou de rede (UNC), ajuste cópias, reordene e imprima em formato A5.
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

      {/* Notificação Temporária */}
      {notification && (
        <div className="import-warning" style={{ margin: '0 0 16px 0' }} role="status">
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

      {/* Banner de Execução em Lotes */}
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
                : '#eff6ff',
            border:
              batchExecution.status === 'dialog_open'
                ? '2px solid #ca8a04'
                : batchExecution.status === 'waiting_confirmation'
                ? '2px solid #d97706'
                : batchExecution.status === 'ready'
                ? '2px solid #16a34a'
                : '2px solid #2563eb',
            borderRadius: 10,
            padding: '16px 20px',
            margin: '0 0 16px 0',
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
                  <span>Carregando composições em alta resolução e renderizando canvas…</span>
                )}
                {batchExecution.status === 'ready' && (
                  <span>Páginas e fontes renderizadas. Abrindo diálogo do Windows…</span>
                )}
                {batchExecution.status === 'dialog_open' && (
                  <span>O diálogo de impressão do Windows está ativo. Selecione a impressora e confirme.</span>
                )}
                {batchExecution.status === 'waiting_confirmation' && (
                  <span>
                    O diálogo foi concluído. <strong>Confira as folhas na bandeja da impressora.</strong> Só confirme o lote quando as impressões saírem corretamente.
                  </span>
                )}
              </p>

              <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
                Folhas confirmadas até agora: <strong>{batchExecution.printedPagesCount}</strong> de{' '}
                <strong>{summary.totalCopies}</strong> folhas totais. Memória do lote anterior descartada.
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
                title="Reenviar este lote se houve atolamento ou falha no driver"
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

      {/* Estado Vazio */}
      {queue.length === 0 ? (
        <div className="empty" style={{ textAlign: 'center', padding: '64px 20px', background: '#ffffff' }}>
          <p style={{ fontSize: 16, fontWeight: 700, color: '#1e293b', marginBottom: 8 }}>
            A fila do Condutor de Impressão está vazia.
          </p>
          <p style={{ color: '#64748b', maxWidth: 540, margin: '0 auto 24px', fontSize: 14 }}>
            Adicione arquivos (.skcartaz ou .psd) de qualquer pasta do Windows, selecione uma pasta inteira ou escolha cartazes salvos em <strong>Meus Cartazes</strong>.
          </p>
          <div className="toolbar" style={{ justifyContent: 'center' }}>
            <button onClick={() => run(handleAddFiles)}>+ Adicionar Arquivos</button>
            <button className="subtle" onClick={() => run(handleAddFolder)}>
              + Adicionar Pasta Inteira
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Barra de Ferramentas Fixa (Sticky Toolbar) */}
          <div className="conductor-toolbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Alternador Lista / Grade */}
              <div className="conductor-view-toggle" role="group" aria-label="Modo de visualização">
                <button
                  type="button"
                  className={viewMode === 'list' ? 'active' : ''}
                  onClick={() => setViewMode('list')}
                  title="Visualização em Lista compacta e detalhada"
                >
                  ☰ Lista
                </button>
                <button
                  type="button"
                  className={viewMode === 'grid' ? 'active' : ''}
                  onClick={() => setViewMode('grid')}
                  title="Visualização em Grade de cartões"
                >
                  ☷ Grade
                </button>
              </div>

              {/* Botão de alternar prévia lateral */}
              {viewMode === 'list' && (
                <button
                  type="button"
                  className="conductor-action-btn"
                  onClick={() => setShowSidePreview(prev => !prev)}
                  title={showSidePreview ? 'Ocultar painel de prévia lateral para expandir a tabela' : 'Exibir painel de prévia lateral'}
                >
                  {showSidePreview ? '◨ Ocultar Prévia' : '◧ Ver Prévia'}
                </button>
              )}
            </div>

            {/* Resumo Rápido */}
            <div className="conductor-quick-stats">
              <span className="stat-pill">
                <strong>{summary.totalDistinct}</strong> cartazes na fila
              </span>
              <span className="stat-pill">
                <strong>{summary.readyCopies}</strong> de <strong>{summary.totalCopies}</strong> folhas A5 prontas
              </span>
              <span className="stat-pill">
                <strong style={{ color: '#16a34a' }}>{summary.readyCount}</strong> prontos
              </span>
              {summary.errorCount > 0 && (
                <span className="stat-pill error" title="Cartazes com arquivo ausente ou corrompido">
                  <strong>{summary.errorCount}</strong> inacessíveis
                </span>
              )}
              {isProcessingQueue && (
                <span className="stat-pill">
                  <strong>{summary.loadingCount}</strong> carregando…
                </span>
              )}
            </div>

            {/* Configuração de Lote e Botão de Impressão */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label className="conductor-batch-control" title="Quantidade máxima de páginas A5 renderizadas por lote para proteger a memória">
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
                />
                <span>págs</span>
              </label>

              <button
                type="button"
                className="conductor-btn-print"
                disabled={summary.readyCount === 0 || !!batchExecution}
                onClick={() => run(handlePrintConductor)}
              >
                {summary.readyCopies > batchSize
                  ? `Imprimir em Lotes (${Math.ceil(summary.readyCopies / batchSize)} lotes · ${summary.readyCopies} folhas)`
                  : `Imprimir Condutor (${summary.readyCopies} folha${summary.readyCopies === 1 ? '' : 's'} A5)`}
              </button>
            </div>
          </div>

          {/* Área Principal de Trabalho */}
          <div
            className="conductor-workspace"
            style={{
              gridTemplateColumns: showSidePreview && viewMode === 'list' ? 'minmax(0, 1fr) 350px' : '1fr',
            }}
          >
            {/* Modo Lista Profissional */}
            {viewMode === 'list' && (
              <div className="conductor-table-wrap">
                <table className="conductor-table">
                  <thead>
                    <tr>
                      <th style={{ width: 62, textAlign: 'center' }}>#</th>
                      <th style={{ width: 50, textAlign: 'center' }}>Prévia</th>
                      <th style={{ minWidth: 200 }}>Produto / Descrição</th>
                      <th style={{ width: 110 }}>Categoria</th>
                      <th style={{ width: 90, textAlign: 'right' }}>Preço</th>
                      <th style={{ width: 60, textAlign: 'center' }}>Unidade</th>
                      <th style={{ minWidth: 160 }}>Arquivo / Origem</th>
                      <th style={{ width: 105, textAlign: 'center' }}>Cópias</th>
                      <th style={{ width: 75, textAlign: 'center' }}>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.map((item, index) => {
                      const isSelected = item.id === selectedId;
                      const isNetwork = item.sourcePath.startsWith('\\\\');
                      return (
                        <tr
                          key={item.id}
                          className={isSelected ? 'selected' : ''}
                          onClick={() => setSelectedId(item.id)}
                          style={{ cursor: 'pointer' }}
                        >
                          {/* 1. Ordem e controles de reordenação */}
                          <td onClick={e => e.stopPropagation()}>
                            <div className="conductor-order-cell">
                              <button
                                type="button"
                                className="conductor-arrow-btn"
                                disabled={index === 0}
                                onClick={() => setQueue(q => moveQueueItem(q, index, index - 1))}
                                title="Mover para cima"
                              >
                                ▲
                              </button>
                              <span className="conductor-order-num">#{index + 1}</span>
                              <button
                                type="button"
                                className="conductor-arrow-btn"
                                disabled={index === queue.length - 1}
                                onClick={() => setQueue(q => moveQueueItem(q, index, index + 1))}
                                title="Mover para baixo"
                              >
                                ▼
                              </button>
                            </div>
                          </td>

                          {/* 2. Miniatura proporcional do cartaz */}
                          <td onClick={e => e.stopPropagation()}>
                            <div
                              className="conductor-thumb-wrap"
                              onClick={() => handleOpenEnlarged(item)}
                              title="Clique para ver prévia ampliada"
                            >
                              {item.thumbnailUrl ? (
                                <img src={item.thumbnailUrl} alt={item.name} />
                              ) : item.status === 'error' ? (
                                <span style={{ color: '#ef4444', fontSize: 13 }}>⚠</span>
                              ) : item.status === 'loading' ? (
                                <span style={{ fontSize: 10, color: '#94a3b8' }}>…</span>
                              ) : (
                                <span style={{ fontSize: 9, color: '#94a3b8' }}>A5</span>
                              )}
                            </div>
                          </td>

                          {/* 3. Nome e descrição do produto (horizontal sem quebra) */}
                          <td>
                            <div className="conductor-product-name" title={item.name}>
                              {item.name}
                            </div>
                            {item.detail && (
                              <div className="conductor-product-detail" title={item.detail}>
                                {item.detail}
                              </div>
                            )}
                            {item.status === 'error' && (
                              <div style={{ marginTop: 4 }}>
                                <small style={{ color: '#dc2626', fontWeight: 600, display: 'block', fontSize: 10 }}>
                                  ⚠ {item.errorMessage || 'Falha de leitura'}
                                </small>
                                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                                  <button
                                    type="button"
                                    className="subtle"
                                    style={{ fontSize: 10, padding: '2px 6px' }}
                                    onClick={e => {
                                      e.stopPropagation();
                                      run(() => handleRelocateItem(item.id));
                                    }}
                                    title="Localizar outro arquivo para este item mantendo a posição e cópias"
                                  >
                                    📁 Localizar arquivo…
                                  </button>
                                  <button
                                    type="button"
                                    className="subtle"
                                    style={{ fontSize: 10, padding: '2px 6px' }}
                                    onClick={e => {
                                      e.stopPropagation();
                                      run(() => handleReloadItem(item.id));
                                    }}
                                    title="Tentar ler novamente do mesmo caminho"
                                  >
                                    ↻ Tentar novamente
                                  </button>
                                </div>
                              </div>
                            )}
                          </td>

                          {/* 4. Categoria, quando disponível (não inventa se ausente) */}
                          <td>
                            {item.category ? (
                              <span className="conductor-badge category" title={`Categoria: ${item.category}`}>
                                {item.category}
                              </span>
                            ) : (
                              <span style={{ color: '#cbd5e1', fontSize: 12 }}>—</span>
                            )}
                          </td>

                          {/* 5. Preço horizontal */}
                          <td style={{ textAlign: 'right' }}>
                            <span className="conductor-price">
                              {item.price ? `R$ ${item.price}` : '—'}
                            </span>
                          </td>

                          {/* 6. Tamanho ou unidade do produto */}
                          <td style={{ textAlign: 'center' }}>
                            <span className="conductor-unit">{item.unit || 'UN'}</span>
                          </td>

                          {/* 7. Arquivo e caminho de origem com tooltip */}
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                              <span className={`conductor-badge ${item.fileFormat}`}>
                                .{item.fileFormat}
                              </span>
                              {isNetwork && (
                                <span className="conductor-badge network">
                                  Rede UNC
                                </span>
                              )}
                              {item.f7 && (
                                <span className="code-cell" style={{ fontSize: 10, padding: '1px 4px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 3 }}>
                                  F7: {item.f7}
                                </span>
                              )}
                            </div>
                            <span
                              style={{
                                fontSize: 11,
                                color: '#64748b',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                display: 'block',
                                maxWidth: 220,
                              }}
                              title={item.sourcePath}
                            >
                              {compactPath(item.sourcePath)}
                            </span>
                          </td>

                          {/* 8. Quantidade de cópias */}
                          <td onClick={e => e.stopPropagation()}>
                            <div className="conductor-copies-stepper">
                              <button
                                type="button"
                                disabled={item.copies <= 1}
                                onClick={() => setQueue(q => updateQueueItemCopies(q, item.id, item.copies - 1))}
                                title="Diminuir cópias"
                              >
                                −
                              </button>
                              <input
                                type="number"
                                min={1}
                                max={999}
                                value={item.copies}
                                onChange={e =>
                                  setQueue(q => updateQueueItemCopies(q, item.id, parseInt(e.target.value, 10) || 1))
                                }
                                title="Quantidade de cópias"
                              />
                              <button
                                type="button"
                                onClick={() => setQueue(q => updateQueueItemCopies(q, item.id, item.copies + 1))}
                                title="Aumentar cópias"
                              >
                                +
                              </button>
                            </div>
                          </td>

                          {/* 9. Botões de visualizar e remover */}
                          <td onClick={e => e.stopPropagation()}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                              <button
                                type="button"
                                className="conductor-action-btn"
                                title="Ver prévia ampliada"
                                onClick={() => handleOpenEnlarged(item)}
                              >
                                🔍
                              </button>
                              <button
                                type="button"
                                className="conductor-action-btn danger"
                                title="Remover da fila"
                                onClick={() => setQueue(q => removeQueueItem(q, item.id))}
                              >
                                ✕
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

            {/* Modo Grade Modernizado */}
            {viewMode === 'grid' && (
              <div className="conductor-grid">
                {queue.map((item, index) => {
                  const isSelected = item.id === selectedId;
                  const isNetwork = item.sourcePath.startsWith('\\\\');
                  return (
                    <article
                      key={item.id}
                      className={`conductor-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedId(item.id)}
                    >
                      {/* Moldura de Prévia Centralizada */}
                      <div
                        className="conductor-card-preview"
                        onClick={e => {
                          e.stopPropagation();
                          handleOpenEnlarged(item);
                        }}
                        title="Clique para ver prévia ampliada"
                      >
                        {item.thumbnailUrl ? (
                          <img src={item.thumbnailUrl} alt={item.name} />
                        ) : item.status === 'error' ? (
                          <span style={{ color: '#ef4444', fontSize: 22 }}>⚠</span>
                        ) : item.status === 'loading' ? (
                          <span style={{ fontSize: 11, color: '#94a3b8' }}>Carregando…</span>
                        ) : (
                          <span style={{ fontSize: 11, color: '#94a3b8' }}>A5</span>
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
                            padding: '2px 5px',
                            fontSize: 11,
                            borderRadius: 4,
                          }}
                          title="Ampliar prévia"
                        >
                          🔍
                        </button>
                      </div>

                      {/* Informações do Produto */}
                      <div>
                        <div className="conductor-product-name" title={item.name}>
                          {item.name}
                        </div>
                        {item.detail && (
                          <div className="conductor-product-detail" title={item.detail}>
                            {item.detail}
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                          <span className="conductor-price">
                            {item.price ? `R$ ${item.price}` : '—'}
                          </span>
                          <span className="conductor-unit">{item.unit || 'UN'}</span>
                        </div>
                      </div>

                      {/* Categoria e Origem */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        {item.category && (
                          <span className="conductor-badge category">{item.category}</span>
                        )}
                        <span className={`conductor-badge ${item.fileFormat}`}>.{item.fileFormat}</span>
                        {isNetwork && <span className="conductor-badge network">Rede</span>}
                      </div>

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
                        {compactPath(item.sourcePath)}
                      </div>

                      {item.status === 'error' && (
                        <div style={{ margin: '4px 0', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '6px 8px' }}>
                          <small style={{ color: '#dc2626', fontWeight: 600, display: 'block', fontSize: 10, lineHeight: 1.3 }}>
                            ⚠ {item.errorMessage || 'Falha de leitura'}
                          </small>
                          <div style={{ display: 'flex', gap: 4, marginTop: 6 }} onClick={e => e.stopPropagation()}>
                            <button
                              type="button"
                              className="subtle"
                              style={{ fontSize: 10, padding: '2px 5px', flex: 1 }}
                              onClick={() => run(() => handleRelocateItem(item.id))}
                              title="Localizar outro arquivo para este item mantendo a posição e cópias"
                            >
                              📁 Localizar…
                            </button>
                            <button
                              type="button"
                              className="subtle"
                              style={{ fontSize: 10, padding: '2px 5px' }}
                              onClick={() => run(() => handleReloadItem(item.id))}
                              title="Tentar ler novamente do mesmo caminho"
                            >
                              ↻
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Rodapé: Cópias e Reordenação */}
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginTop: 'auto',
                          paddingTop: 8,
                          borderTop: '1px solid #f1f5f9',
                        }}
                        onClick={e => e.stopPropagation()}
                      >
                        <div className="conductor-copies-stepper">
                          <button
                            type="button"
                            disabled={item.copies <= 1}
                            onClick={() => setQueue(q => updateQueueItemCopies(q, item.id, item.copies - 1))}
                          >
                            −
                          </button>
                          <input
                            type="number"
                            min={1}
                            max={999}
                            value={item.copies}
                            onChange={e =>
                              setQueue(q => updateQueueItemCopies(q, item.id, parseInt(e.target.value, 10) || 1))
                            }
                          />
                          <button
                            type="button"
                            onClick={() => setQueue(q => updateQueueItemCopies(q, item.id, item.copies + 1))}
                          >
                            +
                          </button>
                        </div>

                        <div style={{ display: 'flex', gap: 3 }}>
                          <button
                            type="button"
                            className="conductor-arrow-btn"
                            disabled={index === 0}
                            style={{ padding: '3px 6px' }}
                            title="Mover para esquerda"
                            onClick={() => setQueue(q => moveQueueItem(q, index, index - 1))}
                          >
                            ◀
                          </button>
                          <button
                            type="button"
                            className="conductor-arrow-btn"
                            disabled={index === queue.length - 1}
                            style={{ padding: '3px 6px' }}
                            title="Mover para direita"
                            onClick={() => setQueue(q => moveQueueItem(q, index, index + 1))}
                          >
                            ▶
                          </button>
                          <button
                            type="button"
                            className="conductor-action-btn danger"
                            style={{ marginLeft: 2 }}
                            title="Remover"
                            onClick={() => setQueue(q => removeQueueItem(q, item.id))}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {/* Painel de Prévia Lateral (em Modo Lista) */}
            {showSidePreview && viewMode === 'list' && (
              <aside className="conductor-side-panel" aria-label="Prévia do cartaz selecionado">
                <h3>
                  <span>Prévia do Cartaz</span>
                  {selectedItem && (
                    <button
                      type="button"
                      className="conductor-action-btn"
                      onClick={() => handleOpenEnlarged(selectedItem)}
                      title="Ver prévia ampliada"
                    >
                      🔍 Ampliar
                    </button>
                  )}
                </h3>

                {selectedItem ? (
                  <>
                    <div style={{ marginBottom: 10, fontSize: 12 }}>
                      <strong style={{ color: '#0f172a' }}>{selectedItem.name}</strong>
                      {selectedItem.detail && <span style={{ color: '#64748b' }}> · {selectedItem.detail}</span>}
                    </div>

                    <div className="paper-wrap">
                      {selectedPoster ? (
                        <PosterView poster={selectedPoster} />
                      ) : selectedItem.status === 'loading' ? (
                        <div style={{ textAlign: 'center', padding: 30, color: '#64748b' }}>
                          <p>Carregando arte…</p>
                        </div>
                      ) : selectedItem.status === 'error' ? (
                        <div style={{ textAlign: 'center', padding: 20, color: '#dc2626' }}>
                          <p style={{ fontWeight: 700, fontSize: 12 }}>Erro ao carregar:</p>
                          <p style={{ fontSize: 11 }}>{selectedItem.errorMessage}</p>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="subtle"
                              onClick={() => run(() => handleReloadItem(selectedItem.id))}
                            >
                              ↻ Tentar recarregar
                            </button>
                            <button
                              type="button"
                              className="subtle"
                              onClick={() => run(() => handleRelocateItem(selectedItem.id))}
                            >
                              📁 Localizar arquivo…
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ textAlign: 'center', padding: 30, color: '#64748b' }}>
                          <p>Aguardando leitura…</p>
                        </div>
                      )}
                    </div>

                    {/* Dados Reais do Arquivo */}
                    <dl className="conductor-side-details">
                      <dt>Arquivo:</dt>
                      <dd title={selectedItem.sourcePath} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{compactPath(selectedItem.sourcePath)}</span>
                        <button
                          type="button"
                          className="subtle"
                          style={{ fontSize: 10, padding: '1px 6px', flexShrink: 0 }}
                          onClick={() => run(() => handleRelocateItem(selectedItem.id))}
                          title="Localizar outro arquivo para este item mantendo a fila"
                        >
                          Alterar…
                        </button>
                      </dd>
                      <dt>Formato:</dt>
                      <dd>{selectedItem.fileFormat.toUpperCase()}</dd>
                      {selectedItem.fileSize ? (
                        <>
                          <dt>Tamanho:</dt>
                          <dd>
                            {selectedItem.fileSize > 1024 * 1024
                              ? `${(selectedItem.fileSize / (1024 * 1024)).toFixed(1)} MB`
                              : `${(selectedItem.fileSize / 1024).toFixed(0)} KB`}
                          </dd>
                        </>
                      ) : null}
                      {selectedPoster?.artwork?.canvas ? (
                        <>
                          <dt>Resolução:</dt>
                          <dd>
                            {selectedPoster.artwork.canvas.width} × {selectedPoster.artwork.canvas.height} px
                            {selectedPoster.artwork.canvas.resolutionPpi ? ` (${selectedPoster.artwork.canvas.resolutionPpi} DPI)` : ''}
                          </dd>
                        </>
                      ) : null}
                      {selectedItem.category && (
                        <>
                          <dt>Categoria:</dt>
                          <dd>{selectedItem.category}</dd>
                        </>
                      )}
                      <dt>Preço:</dt>
                      <dd>R$ {selectedItem.price || '—'} / {selectedItem.unit || 'UN'}</dd>
                      {selectedItem.f7 && (
                        <>
                          <dt>Código F7:</dt>
                          <dd>{selectedItem.f7}</dd>
                        </>
                      )}
                      {selectedItem.validityText && (
                        <>
                          <dt>Validade:</dt>
                          <dd>{selectedItem.validityText}</dd>
                        </>
                      )}
                      <dt>Cópias:</dt>
                      <dd><strong>{selectedItem.copies}</strong> folha(s) A5</dd>
                    </dl>
                  </>
                ) : (
                  <p className="empty" style={{ padding: '30px 10px', fontSize: 12 }}>
                    Selecione um cartaz na tabela para inspecionar a prévia.
                  </p>
                )}
              </aside>
            )}
          </div>
        </>
      )}

      {/* Modal de Prévia Ampliada sob Demanda */}
      {enlargedItem && (
        <div className="modal-backdrop" onClick={handleCloseEnlarged}>
          <div
            className="panel modal"
            role="dialog"
            aria-modal="true"
            aria-label="Prévia ampliada do cartaz"
            style={{ maxWidth: 580, maxHeight: '92vh', overflowY: 'auto', background: '#ffffff' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 17, color: '#0f172a' }}>Prévia Ampliada — {enlargedItem.name}</h2>
              <button type="button" className="subtle" onClick={handleCloseEnlarged}>
                ✕ Fechar
              </button>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                padding: 16,
                borderRadius: 8,
                marginBottom: 16,
              }}
            >
              {loadingEnlarged ? (
                <p style={{ color: '#64748b', padding: 40 }}>Carregando composição em alta resolução…</p>
              ) : enlargedPoster ? (
                <div style={{ maxWidth: 300, boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}>
                  <PosterView poster={enlargedPoster} />
                </div>
              ) : enlargedItem.thumbnailUrl ? (
                <img
                  src={enlargedItem.thumbnailUrl}
                  alt={enlargedItem.name}
                  style={{ maxWidth: 280, borderRadius: 4, boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}
                />
              ) : (
                <p style={{ color: '#dc2626' }}>Não foi possível renderizar a prévia deste cartaz.</p>
              )}
            </div>

            <dl
              className="conductor-side-details"
              style={{ gridTemplateColumns: '90px 1fr', fontSize: 12 }}
            >
              <dt>Caminho:</dt>
              <dd>{enlargedItem.sourcePath}</dd>
              <dt>Formato:</dt>
              <dd>{enlargedItem.fileFormat.toUpperCase()}</dd>
              {enlargedItem.fileSize ? (
                <>
                  <dt>Tamanho:</dt>
                  <dd>
                    {enlargedItem.fileSize > 1024 * 1024
                      ? `${(enlargedItem.fileSize / (1024 * 1024)).toFixed(1)} MB`
                      : `${(enlargedItem.fileSize / 1024).toFixed(0)} KB`}
                  </dd>
                </>
              ) : null}
              {enlargedPoster?.artwork?.canvas ? (
                <>
                  <dt>Resolução:</dt>
                  <dd>
                    {enlargedPoster.artwork.canvas.width} × {enlargedPoster.artwork.canvas.height} px
                    {enlargedPoster.artwork.canvas.resolutionPpi ? ` (${enlargedPoster.artwork.canvas.resolutionPpi} DPI)` : ''}
                  </dd>
                </>
              ) : null}
              {enlargedItem.category && (
                <>
                  <dt>Categoria:</dt>
                  <dd>{enlargedItem.category}</dd>
                </>
              )}
              <dt>Preço:</dt>
              <dd>R$ {enlargedItem.price || '—'} / {enlargedItem.unit || 'UN'}</dd>
              {enlargedItem.f7 && (
                <>
                  <dt>Código F7:</dt>
                  <dd>{enlargedItem.f7}</dd>
                </>
              )}
              {enlargedItem.validityText && (
                <>
                  <dt>Validade:</dt>
                  <dd>{enlargedItem.validityText}</dd>
                </>
              )}
              <dt>Cópias:</dt>
              <dd>{enlargedItem.copies} folha(s) A5</dd>
            </dl>

            <div className="toolbar" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
              <button type="button" onClick={handleCloseEnlarged}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Adicionar da Biblioteca */}
      {showLibraryModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="lib-modal-title">
          <div className="modal price-confirmation" style={{ width: 'min(760px, 94vw)', background: '#ffffff' }}>
            <h3 id="lib-modal-title" style={{ color: '#0f172a' }}>Adicionar Cartazes de "Meus Cartazes"</h3>
            <p style={{ color: '#64748b', margin: '4px 0 16px' }}>
              Selecione os cartazes salvos na biblioteca local para incluir na fila de impressão.
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

            <div className="import-table-wrap" style={{ maxHeight: '45vh', background: '#ffffff' }}>
              <table className="conductor-table">
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
                        className={isChecked ? 'selected' : ''}
                        style={{ cursor: 'pointer' }}
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
                            onChange={() => {}}
                          />
                        </td>
                        <td>
                          <strong>{doc?.product.name || entry.name}</strong>
                          {doc?.product.complement && (
                            <small style={{ color: '#64748b', display: 'block' }}>{doc.product.complement}</small>
                          )}
                        </td>
                        <td className="code-cell">{doc?.product.productCode || '—'}</td>
                        <td>{doc ? `R$ ${formatCentsBr(doc.product.priceCents)}` : '—'}</td>
                      </tr>
                    );
                  })}
                  {filteredLibraryEntries.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', padding: 24, color: '#64748b' }}>
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
