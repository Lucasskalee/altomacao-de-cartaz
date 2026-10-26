import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { PosterView, type Poster } from '../editor/PosterView';
import { repairInvertedPsdArtwork } from '../editor/importedRenderer';
import { posterFromDocument } from '../../features/cartazes/presentation';
import { indexCartazes } from '../../features/cartazes/f7';
import { saveDocument } from '../../features/cartazes/storage';
import type { Cartaz, Library as LibraryData } from '../../features/cartazes/types';
import {
  columnLetter,
  extractCampaignItemsFromSheet,
  parseExcelPriceToCents,
  parseXlsx,
  suggestColumnMapping,
  type ColumnMapping,
  type ExcelWorkbook,
} from '../../features/ofertas/excel';
import {
  applyExcelToCampaign,
  archiveCampaign,
  buildCampaignMatchViews,
  confirmBatchPrinted,
  createCampaign,
  duplicateCampaign,
  linkSavedPosterToCampaignItem,
  listCampaigns,
  renameCampaign,
  saveCampaign,
  selectExcel,
  syncCampaignWithLibrary,
  updatePosterSelection,
  updateScheduledPrice,
} from '../../features/ofertas/service';
import type { OfferCampaign, PrintStatus, PsdImportOfferContext } from '../../features/ofertas/types';

const PsdImport = lazy(() =>
  import('../library/PsdImport').then(module => ({ default: module.PsdImport }))
);

type Props = {
  libraryData: LibraryData | null;
  run: (action: () => Promise<void>) => void;
  onPrintBatch: (posters: Poster[]) => void;
  onRefreshLibrary?: () => Promise<void>;
};

const money = (cents: number | null) =>
  cents === null ? '—' : `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

const tomorrowIso = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

export function OfferFolders({ libraryData, run, onPrintBatch, onRefreshLibrary }: Props) {
  const [campaigns, setCampaigns] = useState<OfferCampaign[]>([]);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderDate, setNewFolderDate] = useState(tomorrowIso);

  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [renameDate, setRenameDate] = useState('');

  // Excel import modal state
  const [workbook, setWorkbook] = useState<ExcelWorkbook | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping>({ f7Col: 0, descriptionCol: 1, priceCol: 2 });

  // PSD import modal state from "Sem cartaz" row
  const [psdOfferContext, setPsdOfferContext] = useState<PsdImportOfferContext | null>(null);

  // Filter & preview inside active campaign
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'todos' | 'com-cartaz' | 'sem-cartaz' | PrintStatus>('todos');
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [editingPriceValue, setEditingPriceValue] = useState('');

  // Batch print tracking
  const [batchSize, setBatchSize] = useState(10);
  const [awaitingPrintConfirm, setAwaitingPrintConfirm] = useState<{ keys: Set<string>; count: number } | null>(null);

  const libraryIndex = useMemo(() => indexCartazes(libraryData?.entries ?? []), [libraryData]);

  const reloadCampaigns = async () => {
    const res = await listCampaigns();
    setCampaigns(res.campaigns);
    setLoadErrors(res.errors);
    if (!activeId && res.campaigns.length > 0) {
      const firstActive = res.campaigns.find(c => !c.archived) ?? res.campaigns[0];
      setActiveId(firstActive.id);
    }
  };

  useEffect(() => {
    let mounted = true;
    listCampaigns()
      .then(res => {
        if (!mounted) return;
        setCampaigns(res.campaigns);
        setLoadErrors(res.errors);
        if (res.campaigns.length > 0) {
          const first = res.campaigns.find(c => !c.archived) ?? res.campaigns[0];
          setActiveId(first.id);
        }
      })
      .catch(err => {
        if (mounted) setLoadErrors([String(err)]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const activeCampaign = useMemo(
    () => campaigns.find(c => c.id === activeId) ?? null,
    [campaigns, activeId]
  );

  const persistUpdate = async (updated: OfferCampaign) => {
    const saved = await saveCampaign(updated);
    setCampaigns(prev => {
      const idx = prev.findIndex(c => c.id === saved.id);
      if (idx === -1) return [saved, ...prev];
      const next = [...prev];
      next[idx] = saved;
      return next;
    });
    return saved;
  };

  const handleCreateCampaign = async () => {
    const created = createCampaign(newFolderName || 'Ofertas de Amanhã', newFolderDate);
    const saved = await persistUpdate(created);
    setActiveId(saved.id);
    setNewFolderName('');
  };

  const handleRenameCampaign = async () => {
    if (!activeCampaign) return;
    const updated = renameCampaign(activeCampaign, renameText, renameDate);
    await persistUpdate(updated);
    setRenaming(false);
  };

  const handleDuplicateCampaign = async () => {
    if (!activeCampaign) return;
    const copy = duplicateCampaign(activeCampaign);
    const saved = await persistUpdate(copy);
    setActiveId(saved.id);
  };

  const handleArchiveToggle = async () => {
    if (!activeCampaign) return;
    const updated = archiveCampaign(activeCampaign, !activeCampaign.archived);
    await persistUpdate(updated);
  };

  const handleOpenExcel = async () => {
    const selected = await selectExcel();
    if (!selected) return;
    const wb = parseXlsx(selected.buffer, selected.name);
    setWorkbook(wb);
    setSheetIdx(0);
    const firstSheet = wb.sheets[0];
    setHeaderRow(0);
    const headers = firstSheet?.rows[0] ?? [];
    setMapping(suggestColumnMapping(headers));
  };

  const activeSheet = workbook?.sheets[sheetIdx] ?? null;

  const handleSheetChange = (idx: number) => {
    setSheetIdx(idx);
    const sheet = workbook?.sheets[idx];
    const row = sheet?.rows[headerRow] ?? sheet?.rows[0] ?? [];
    setMapping(suggestColumnMapping(row));
  };

  const handleHeaderRowChange = (rIdx: number) => {
    setHeaderRow(rIdx);
    const row = activeSheet?.rows[rIdx] ?? [];
    setMapping(suggestColumnMapping(row));
  };

  const extractionPreview = useMemo(() => {
    if (!activeSheet) return null;
    return extractCampaignItemsFromSheet(activeSheet, headerRow, mapping);
  }, [activeSheet, headerRow, mapping]);

  const handleConfirmExcelImport = async () => {
    if (!activeCampaign || !workbook || !activeSheet || !extractionPreview) return;
    const updated = applyExcelToCampaign(activeCampaign, extractionPreview, libraryIndex, {
      fileName: workbook.fileName,
      sheetName: activeSheet.name,
      headerRowIndex: headerRow,
      mapping,
    });
    await persistUpdate(updated);
    setWorkbook(null);
  };

  const handleSyncLibrary = async () => {
    if (!activeCampaign) return;
    if (onRefreshLibrary) await onRefreshLibrary();
    const synced = syncCampaignWithLibrary(activeCampaign, libraryIndex);
    await persistUpdate(synced);
  };

  const handlePsdSavedForOffer = async (path: string, savedDocument: Cartaz) => {
    if (!activeCampaign || !psdOfferContext) return;
    const linked = linkSavedPosterToCampaignItem(
      activeCampaign,
      psdOfferContext.offerItemId,
      path,
      savedDocument
    );
    await persistUpdate(linked);
    if (onRefreshLibrary) await onRefreshLibrary();
    setPreviewKey(`${psdOfferContext.offerItemId}::${path}`);
  };

  const handleRepairInvertedPoster = async (cartazPath: string, doc: Cartaz) => {
    if (doc.layout.template !== 'imported-psd') return;
    const { artwork, correctedPriceCents } = repairInvertedPsdArtwork(doc.layout.artwork);
    const now = new Date().toISOString();
    const updatedDoc: Cartaz = {
      ...doc,
      product: {
        ...doc.product,
        priceCents: correctedPriceCents ?? doc.product.priceCents,
      },
      layout: {
        ...doc.layout,
        artwork,
      },
      metadata: {
        ...doc.metadata,
        updatedAt: now,
      },
    };
    await saveDocument(cartazPath, updatedDoc, true);
    if (onRefreshLibrary) await onRefreshLibrary();
  };

  const matchViews = useMemo(() => {
    if (!activeCampaign) return [];
    return buildCampaignMatchViews(activeCampaign, libraryIndex);
  }, [activeCampaign, libraryIndex]);

  const filteredViews = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase('pt-BR');
    return matchViews.filter(v => {
      if (q && !`${v.item.f7} ${v.item.description}`.toLocaleLowerCase('pt-BR').includes(q)) {
        return false;
      }
      if (statusFilter === 'com-cartaz') return !v.missingPoster;
      if (statusFilter === 'sem-cartaz') return v.missingPoster;
      if (statusFilter === 'pendente' || statusFilter === 'preparado' || statusFilter === 'impresso') {
        return v.matchedPosters.some(m => m.state.status === statusFilter);
      }
      return true;
    });
  }, [matchViews, searchQuery, statusFilter]);

  const selectedPosterPreview = useMemo(() => {
    for (const v of matchViews) {
      for (const m of v.matchedPosters) {
        const key = `${v.item.id}::${m.state.cartazPath}`;
        if (key === previewKey && m.scheduledDocument) {
          return {
            item: v.item,
            posterState: m.state,
            currentPriceCents: m.currentPriceCents,
            priceMismatchReason: m.priceMismatchReason,
            poster: posterFromDocument(m.scheduledDocument),
          };
        }
      }
    }
    for (const v of matchViews) {
      for (const m of v.matchedPosters) {
        if (m.scheduledDocument) {
          return {
            item: v.item,
            posterState: m.state,
            currentPriceCents: m.currentPriceCents,
            priceMismatchReason: m.priceMismatchReason,
            poster: posterFromDocument(m.scheduledDocument),
          };
        }
      }
    }
    return null;
  }, [matchViews, previewKey]);

  const campaignStats = useMemo(() => {
    let totalItems = matchViews.length;
    let missing = 0;
    let pending = 0;
    let prepared = 0;
    let printed = 0;
    let divergent = 0;
    for (const v of matchViews) {
      if (v.missingPoster) missing++;
      for (const m of v.matchedPosters) {
        if (!m.libraryCartaz) continue;
        if (m.priceMismatchReason) divergent++;
        if (m.state.status === 'pendente') pending++;
        else if (m.state.status === 'preparado') prepared++;
        else if (m.state.status === 'impresso') printed++;
      }
    }
    return { totalItems, missing, pending, prepared, printed, divergent };
  }, [matchViews]);

  const handleTriggerPartialPrint = (reprintPrinted = false) => {
    if (!activeCampaign) return;
    const queue: Poster[] = [];
    const keys = new Set<string>();
    const blockedProducts: string[] = [];
    const limit = Math.max(1, Math.min(200, batchSize));
    let distinctPostersCount = 0;
    for (const v of matchViews) {
      for (const m of v.matchedPosters) {
        if (!m.state.selected || !m.scheduledDocument) continue;
        if (!reprintPrinted && m.state.status === 'impresso') continue;
        if (m.priceMismatchReason) {
          blockedProducts.push(`F7 ${v.item.f7} (${v.item.description}): ${m.priceMismatchReason}`);
          continue;
        }
        if (distinctPostersCount >= limit) break;
        const poster = posterFromDocument(m.scheduledDocument);
        for (let c = 0; c < m.state.copies; c++) {
          queue.push(poster);
        }
        const normPath = m.state.cartazPath.replace(/\//g, '\\').toLocaleLowerCase('en-US');
        keys.add(`${v.item.id}::${normPath}`);
        distinctPostersCount++;
      }
      if (distinctPostersCount >= limit) break;
    }
    if (blockedProducts.length > 0 && queue.length === 0) {
      throw new Error(
        `Impressão bloqueada por divergência de preço/camadas: ${blockedProducts[0]}`
      );
    }
    if (queue.length === 0) {
      throw new Error(
        reprintPrinted
          ? 'Selecione ao menos um cartaz válido para reimprimir.'
          : 'Não há cartazes selecionados com status Preparado/Pendente para imprimir.'
      );
    }
    setAwaitingPrintConfirm({ keys, count: distinctPostersCount });
    onPrintBatch(queue);
  };

  const handleConfirmPrinted = async () => {
    if (!activeCampaign || !awaitingPrintConfirm) return;
    const updated = confirmBatchPrinted(activeCampaign, awaitingPrintConfirm.keys);
    await persistUpdate(updated);
    setAwaitingPrintConfirm(null);
  };

  const visibleCampaigns = campaigns.filter(c => showArchived || !c.archived);

  return (
    <section className="panel offer-folders">
      <div className="library-heading">
        <div>
          <h2>Pastas de Ofertas</h2>
          <p>Programe ofertas futuras via Excel (.xlsx) e imprima cartazes sem alterar os preços vigentes da biblioteca.</p>
        </div>
        <div className="toolbar">
          <label className="f7-filter" style={{ marginTop: 0 }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
            />
            Mostrar arquivadas
          </label>
          <button className="subtle" onClick={() => run(reloadCampaigns)}>
            Atualizar pastas
          </button>
        </div>
      </div>

      {loadErrors.map(err => (
        <p className="error-text" role="alert" key={err}>
          {err}
        </p>
      ))}

      <div className="library-layout">
        <aside aria-label="Lista de pastas de ofertas">
          <form
            className="offer-create-form"
            onSubmit={e => {
              e.preventDefault();
              run(handleCreateCampaign);
            }}
          >
            <label>
              Nova pasta de ofertas
              <input
                placeholder="Ex.: Ofertas de Amanhã"
                maxLength={80}
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
              />
            </label>
            <label>
              Data da campanha
              <input
                type="date"
                required
                value={newFolderDate}
                onChange={e => setNewFolderDate(e.target.value)}
              />
            </label>
            <button type="submit" style={{ width: '100%' }}>
              + Criar Pasta de Ofertas
            </button>
          </form>

          <div className="offer-folder-list">
            {visibleCampaigns.map(c => (
              <button
                key={c.id}
                className={c.id === activeId ? 'folder selected' : 'folder'}
                onClick={() => {
                  setActiveId(c.id);
                  setRenaming(false);
                  setAwaitingPrintConfirm(null);
                }}
              >
                <strong>{c.name}</strong>
                <small style={{ display: 'block', fontSize: '11px', opacity: 0.8 }}>
                  Data: {c.campaignDate} · {c.items.length} produto(s)
                  {c.archived ? ' · [Arquivada]' : ''}
                </small>
              </button>
            ))}
            {visibleCampaigns.length === 0 && (
              <p className="empty" style={{ padding: '16px 8px' }}>
                Nenhuma pasta de ofertas encontrada. Crie uma acima para começar.
              </p>
            )}
          </div>
        </aside>

        <div>
          {!activeCampaign ? (
            <p className="empty">Selecione ou crie uma pasta de ofertas à esquerda.</p>
          ) : (
            <>
              <div className="offer-campaign-header">
                <div>
                  <h3>
                    {activeCampaign.name}{' '}
                    <span className="status">Campanha: {activeCampaign.campaignDate}</span>
                    {activeCampaign.archived && (
                      <span className="comparison-status conflict" style={{ marginLeft: 8 }}>
                        Arquivada
                      </span>
                    )}
                  </h3>
                  <small className="document-path">
                    ID: {activeCampaign.id}
                    {activeCampaign.sourceExcel
                      ? ` · Planilha: ${activeCampaign.sourceExcel.fileName} (${activeCampaign.sourceExcel.sheetName})`
                      : ' · Nenhuma planilha importada ainda'}
                  </small>
                </div>
                <div className="toolbar">
                  <button onClick={() => run(handleOpenExcel)}>Importar Excel (.xlsx)</button>
                  <button className="subtle" onClick={() => run(handleSyncLibrary)}>
                    Localizar cartazes na biblioteca
                  </button>
                  <button
                    className="subtle"
                    onClick={() => {
                      setRenameText(activeCampaign.name);
                      setRenameDate(activeCampaign.campaignDate);
                      setRenaming(true);
                    }}
                  >
                    Renomear / Data
                  </button>
                  <button className="subtle" onClick={() => run(handleDuplicateCampaign)}>
                    Duplicar pasta
                  </button>
                  <button className="subtle" onClick={() => run(handleArchiveToggle)}>
                    {activeCampaign.archived ? 'Desarquivar' : 'Arquivar'}
                  </button>
                </div>
              </div>

              {renaming && (
                <form
                  className="psd-fields"
                  onSubmit={e => {
                    e.preventDefault();
                    run(handleRenameCampaign);
                  }}
                >
                  <label>
                    Nome da campanha
                    <input
                      required
                      maxLength={80}
                      value={renameText}
                      onChange={e => setRenameText(e.target.value)}
                    />
                  </label>
                  <label>
                    Data programada
                    <input
                      type="date"
                      required
                      value={renameDate}
                      onChange={e => setRenameDate(e.target.value)}
                    />
                  </label>
                  <div className="toolbar" style={{ alignItems: 'end' }}>
                    <button type="submit">Salvar alterações</button>
                    <button type="button" className="subtle" onClick={() => setRenaming(false)}>
                      Cancelar
                    </button>
                  </div>
                </form>
              )}

              <div className="import-stats" aria-live="polite">
                <span>
                  <strong>{campaignStats.totalItems}</strong> produtos na pasta
                </span>
                <span>
                  <strong>{campaignStats.prepared}</strong> cartazes preparados
                </span>
                <span>
                  <strong>{campaignStats.printed}</strong> cartazes impressos
                </span>
                <span>
                  <strong>{campaignStats.pending}</strong> pendentes
                </span>
                <span>
                  <strong>{campaignStats.missing}</strong> produtos sem cartaz
                </span>
              </div>

              {awaitingPrintConfirm && (
                <div className="import-warning" role="region" aria-label="Confirmação de impressão">
                  <strong>
                    Impressão enviada ({awaitingPrintConfirm.count} cartaz(es) deste lote).
                  </strong>{' '}
                  Confirme abaixo se a impressão em A5 foi concluída corretamente para marcá-los como{' '}
                  <strong>Impresso</strong> e avançar para a próxima parte:
                  <div className="toolbar" style={{ marginTop: 10 }}>
                    <button onClick={() => run(handleConfirmPrinted)}>
                      Confirmar impressão concluída
                    </button>
                    <button className="subtle" onClick={() => setAwaitingPrintConfirm(null)}>
                      Manter como preparado (não confirmar ainda)
                    </button>
                  </div>
                </div>
              )}

              {activeCampaign.items.length > 0 && (
                <>
                  <div className="library-toolbar" style={{ marginBottom: 14 }}>
                    <input
                      aria-label="Pesquisar F7 ou descrição na pasta de ofertas"
                      placeholder="Pesquisar F7 ou descrição…"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                    />
                    <select
                      aria-label="Filtrar cartazes da campanha"
                      value={statusFilter}
                      onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
                    >
                      <option value="todos">Todos os itens</option>
                      <option value="com-cartaz">Com cartaz vinculado</option>
                      <option value="sem-cartaz">Sem cartaz na biblioteca</option>
                      <option value="preparado">Status: Preparado</option>
                      <option value="pendente">Status: Pendente</option>
                      <option value="impresso">Status: Impresso</option>
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                      Cartazes por parte:
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={batchSize}
                        onChange={e => setBatchSize(Math.max(1, parseInt(e.target.value, 10) || 10))}
                        style={{ width: 70 }}
                      />
                    </label>
                    <button
                      onClick={() =>
                        run(async () => {
                          handleTriggerPartialPrint(false);
                        })
                      }
                    >
                      Imprimir próxima parte (até {batchSize})
                    </button>
                    <button
                      className="subtle"
                      onClick={() =>
                        run(async () => {
                          handleTriggerPartialPrint(true);
                        })
                      }
                    >
                      Reimprimir selecionados
                    </button>
                  </div>

                  <div className="offer-workspace">
                    <div className="import-table-wrap">
                      <table className="import-table">
                        <thead>
                          <tr>
                            <th>F7</th>
                            <th>Produto (Excel)</th>
                            <th>Preço Programado</th>
                            <th>Cartazes da Biblioteca e Impressão</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredViews.map(v => (
                            <tr key={v.item.id}>
                              <td className="code-cell">{v.item.f7}</td>
                              <td>
                                <strong>{v.item.description}</strong>
                                <small>Linha Excel: {v.item.rowNumber}</small>
                              </td>
                              <td>
                                {editingPriceId === v.item.id ? (
                                  <div className="toolbar">
                                    <input
                                      inputMode="decimal"
                                      value={editingPriceValue}
                                      onChange={e => setEditingPriceValue(e.target.value)}
                                      style={{ width: 90, padding: 6 }}
                                    />
                                    <button
                                      className="subtle"
                                      onClick={() =>
                                        run(async () => {
                                          const cents = parseExcelPriceToCents(editingPriceValue);
                                          await persistUpdate(
                                            updateScheduledPrice(activeCampaign, v.item.id, cents)
                                          );
                                          setEditingPriceId(null);
                                        })
                                      }
                                    >
                                      OK
                                    </button>
                                  </div>
                                ) : (
                                  <div>
                                    <strong style={{ color: '#137b52', fontSize: 15 }}>
                                      {money(v.item.scheduledPriceCents)}
                                    </strong>
                                    <div>
                                      <button
                                        className="subtle"
                                        style={{ padding: '4px 8px', fontSize: 11, marginTop: 4 }}
                                        onClick={() => {
                                          setEditingPriceId(v.item.id);
                                          setEditingPriceValue(
                                            (v.item.scheduledPriceCents / 100)
                                              .toFixed(2)
                                              .replace('.', ',')
                                          );
                                        }}
                                      >
                                        Editar preço futuro
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </td>
                              <td>
                                {v.missingPoster ? (
                                  <div className="toolbar" style={{ alignItems: 'center' }}>
                                    <span className="comparison-status conflict">
                                      Sem cartaz (F7 {v.item.f7})
                                    </span>
                                    <button
                                      className="subtle"
                                      style={{ padding: '6px 10px', fontSize: 12 }}
                                      onClick={() =>
                                        setPsdOfferContext({
                                          folderId: activeCampaign.id,
                                          offerItemId: v.item.id,
                                          productCode: v.item.f7,
                                          description: v.item.description,
                                          futurePriceCents: v.item.scheduledPriceCents,
                                        })
                                      }
                                    >
                                      Importar arte PSD
                                    </button>
                                  </div>
                                ) : (
                                  <div className="offer-posters-cell">
                                    {v.matchedPosters.map(m => {
                                      const key = `${v.item.id}::${m.state.cartazPath}`;
                                      return (
                                        <div key={key} className="offer-poster-row">
                                          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <input
                                              type="checkbox"
                                              checked={m.state.selected}
                                              disabled={!m.libraryCartaz}
                                              onChange={e =>
                                                run(async () => {
                                                  await persistUpdate(
                                                    updatePosterSelection(
                                                      activeCampaign,
                                                      v.item.id,
                                                      m.state.cartazPath,
                                                      { selected: e.target.checked }
                                                    )
                                                  );
                                                })
                                              }
                                            />
                                            <span>
                                              <strong>
                                                {m.libraryCartaz?.document.product.name ?? 'Arquivo ausente'}{' '}
                                                {m.libraryCartaz?.document.product.complement ?? ''}
                                              </strong>
                                              <small>
                                                Preço atual na biblioteca:{' '}
                                                <strong>{money(m.currentPriceCents)}</strong> (intacto) ·{' '}
                                                {m.state.cartazPath}
                                              </small>
                                            </span>
                                          </label>
                                          {m.priceMismatchReason && (
                                            <div
                                              className="import-warning"
                                              role="alert"
                                              style={{ marginTop: 6, fontSize: 12 }}
                                            >
                                              <strong>Impressão bloqueada:</strong> {m.priceMismatchReason}
                                              {m.hasInvertedLayers && m.libraryCartaz && (
                                                <div style={{ marginTop: 6 }}>
                                                  <button
                                                    className="subtle"
                                                    style={{ padding: '4px 10px', fontSize: 12 }}
                                                    onClick={() =>
                                                      run(() =>
                                                        handleRepairInvertedPoster(
                                                          m.libraryCartaz!.path,
                                                          m.libraryCartaz!.document
                                                        )
                                                      )
                                                    }
                                                  >
                                                    Corrigir inversão Reais/Centavos neste cartaz
                                                  </button>
                                                </div>
                                              )}
                                            </div>
                                          )}
                                          <div className="toolbar" style={{ alignItems: 'center', marginTop: 6 }}>
                                            <label style={{ fontSize: 12 }}>
                                              Cópias:{' '}
                                              <input
                                                type="number"
                                                min={1}
                                                max={999}
                                                value={m.state.copies}
                                                onChange={e =>
                                                  run(async () => {
                                                    await persistUpdate(
                                                      updatePosterSelection(
                                                        activeCampaign,
                                                        v.item.id,
                                                        m.state.cartazPath,
                                                        { copies: parseInt(e.target.value, 10) || 1 }
                                                      )
                                                    );
                                                  })
                                                }
                                                style={{ width: 60, padding: '4px 6px' }}
                                              />
                                            </label>
                                            <select
                                              aria-label="Status de impressão"
                                              value={m.state.status}
                                              onChange={e =>
                                                run(async () => {
                                                  await persistUpdate(
                                                    updatePosterSelection(
                                                      activeCampaign,
                                                      v.item.id,
                                                      m.state.cartazPath,
                                                      { status: e.target.value as PrintStatus }
                                                    )
                                                  );
                                                })
                                              }
                                              style={{ padding: '4px 8px', fontSize: 12 }}
                                            >
                                              <option value="pendente">Pendente</option>
                                              <option value="preparado">Preparado</option>
                                              <option value="impresso">Impresso</option>
                                            </select>
                                            <button
                                              className="subtle"
                                              style={{ padding: '5px 10px', fontSize: 12 }}
                                              onClick={() => setPreviewKey(key)}
                                            >
                                              Ver prévia futura
                                            </button>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="offer-preview-box">
                      <h3>Prévia com Preço Programado</h3>
                      {selectedPosterPreview ? (
                        <>
                          <p style={{ marginBottom: 8 }}>
                            <strong>{selectedPosterPreview.item.description}</strong> (F7:{' '}
                            {selectedPosterPreview.item.f7})
                            <br />
                            Biblioteca: {money(selectedPosterPreview.currentPriceCents)} →{' '}
                            <strong>Programado: {money(selectedPosterPreview.item.scheduledPriceCents)}</strong>
                          </p>
                          <div className="paper-wrap">
                            <PosterView poster={selectedPosterPreview.poster} />
                          </div>
                        </>
                      ) : (
                        <p className="empty">
                          Vincule um cartaz da biblioteca pelo F7 para visualizar a prévia com o preço futuro.
                        </p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {workbook && activeSheet && extractionPreview && (
        <div className="modal-backdrop psd-backdrop">
          <section className="panel psd-import" role="dialog" aria-modal="true" aria-label="Importar planilha Excel">
            <div className="psd-title">
              <div>
                <h2>Importar Planilha de Ofertas (.xlsx)</h2>
                <p>
                  Arquivo: <strong>{workbook.fileName}</strong> · O arquivo Excel original é apenas lido e nunca modificado.
                </p>
              </div>
              <button className="subtle" onClick={() => setWorkbook(null)}>
                Cancelar
              </button>
            </div>

            <div className="psd-fields">
              <label>
                Aba da planilha
                <select value={sheetIdx} onChange={e => handleSheetChange(Number(e.target.value))}>
                  {workbook.sheets.map((s, idx) => (
                    <option key={s.name} value={idx}>
                      {s.name} ({s.rows.length} linhas)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Linha do cabeçalho
                <select value={headerRow} onChange={e => handleHeaderRowChange(Number(e.target.value))}>
                  {activeSheet.rows.slice(0, 15).map((r, idx) => (
                    <option key={idx} value={idx}>
                      Linha {idx + 1}: {r.filter(Boolean).slice(0, 4).join(' | ') || '(vazia)'}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Coluna do Código F7
                <select
                  value={mapping.f7Col}
                  onChange={e => setMapping(m => ({ ...m, f7Col: Number(e.target.value) }))}
                >
                  {(activeSheet.rows[headerRow] ?? []).map((col, idx) => (
                    <option key={idx} value={idx}>
                      Coluna {columnLetter(idx)} — {col || `(Sem título)`}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Coluna da Descrição
                <select
                  value={mapping.descriptionCol}
                  onChange={e => setMapping(m => ({ ...m, descriptionCol: Number(e.target.value) }))}
                >
                  {(activeSheet.rows[headerRow] ?? []).map((col, idx) => (
                    <option key={idx} value={idx}>
                      Coluna {columnLetter(idx)} — {col || `(Sem título)`}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Coluna do Preço Programado
                <select
                  value={mapping.priceCol}
                  onChange={e => setMapping(m => ({ ...m, priceCol: Number(e.target.value) }))}
                >
                  {(activeSheet.rows[headerRow] ?? []).map((col, idx) => (
                    <option key={idx} value={idx}>
                      Coluna {columnLetter(idx)} — {col || `(Sem título)`}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="import-stats">
              <span>
                <strong>{extractionPreview.validCount}</strong> itens válidos
              </span>
              <span>
                <strong>{extractionPreview.invalidCount}</strong> itens com problemas/conflitos
              </span>
              <span>
                <strong>{extractionPreview.duplicateF7s.length}</strong> F7 duplicados
              </span>
              <span>
                <strong>{extractionPreview.conflictingF7s.length}</strong> F7 com preços conflitantes
              </span>
            </div>

            <div className="import-table-wrap" style={{ maxHeight: '40vh' }}>
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Linha</th>
                    <th>F7 (String)</th>
                    <th>Descrição</th>
                    <th>Preço Planilha</th>
                    <th>Centavos</th>
                    <th>Validação</th>
                  </tr>
                </thead>
                <tbody>
                  {extractionPreview.items.slice(0, 100).map(item => (
                    <tr key={item.rowNumber}>
                      <td>{item.rowNumber}</td>
                      <td className="code-cell">{item.f7 ?? (item.f7Raw || '—')}</td>
                      <td>{item.description || '—'}</td>
                      <td>{item.priceRaw || '—'}</td>
                      <td>{item.priceCents !== null ? money(item.priceCents) : '—'}</td>
                      <td>
                        {item.issues.length === 0 ? (
                          <span className="comparison-status">Válido</span>
                        ) : (
                          item.issues.map(iss => (
                            <small className="error-text" key={iss}>
                              {iss}
                            </small>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="toolbar" style={{ marginTop: 16 }}>
              <button
                disabled={extractionPreview.validCount === 0}
                onClick={() => run(handleConfirmExcelImport)}
              >
                Confirmar importação ({extractionPreview.validCount} produto(s))
              </button>
              <button className="subtle" onClick={() => setWorkbook(null)}>
                Cancelar
              </button>
            </div>
          </section>
        </div>
      )}

      {psdOfferContext && (
        <Suspense
          fallback={
            <div className="modal-backdrop">
              <section className="panel modal" role="status">
                Carregando importador PSD…
              </section>
            </div>
          }
        >
          <PsdImport
            offerContext={psdOfferContext}
            close={() => setPsdOfferContext(null)}
            saved={handlePsdSavedForOffer}
          />
        </Suspense>
      )}
    </section>
  );
}
