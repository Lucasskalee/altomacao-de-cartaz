import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { PosterView } from '../editor/PosterView';
import { repairInvertedPsdArtwork } from '../editor/importedRenderer';
import { formatCentsBr } from '../../features/cartazes/presentation';
import { indexCartazes } from '../../features/cartazes/f7';
import { saveDocument } from '../../features/cartazes/storage';
import type { Cartaz, ImportedArtwork, ImportedLayerInfo, Library as LibraryData } from '../../features/cartazes/types';
import {
  applyValidityDateToLayerText,
  columnLetter,
  extractCampaignItemsFromSheet,
  formatIsoDateShortBr,
  parseExcelDateToIso,
  parseExcelPriceToCents,
  parseXlsx,
  suggestColumnMapping,
  type ColumnMapping,
  type ExcelWorkbook,
} from '../../features/ofertas/excel';
import { selectExcel } from '../../features/ofertas/service';
import type { PsdImportOfferContext } from '../../features/ofertas/types';
import { analyzePsd, buildArtwork, type PsdRoleMap } from '../../features/psd/importer';
import { readPsdByPath, selectPsd } from '../../features/psd/service';
import {
  applyExcelToScantechCampaign,
  buildOutputPsdPath,
  buildScantechItemViews,
  chooseScantechExportFolder,
  chooseScantechPsdFolder,
  createScantechCampaign,
  detectPhotoshop,
  duplicateScantechCampaign,
  exportScantechPsds,
  linkCartazAndPsdToScantechItem,
  listScantechCampaigns,
  saveScantechCampaign,
  scanScantechPsdFolder,
  updateScantechCampaignSettings,
  updateScantechItemFields,
} from '../../features/scantech/service';
import type {
  PhotoshopStatus,
  ScannedPsdEntry,
  ScantechCampaign,
  ScantechExportBatchResult,
  ScantechExportJob,
  ScantechItemStatus,
  ScantechItemView,
} from '../../features/scantech/types';

const PsdImport = lazy(() =>
  import('../library/PsdImport').then(module => ({ default: module.PsdImport }))
);

type Props = {
  libraryData: LibraryData | null;
  run: (action: () => Promise<void>) => void;
  onRefreshLibrary?: () => Promise<void>;
};

const money = (cents: number | null) =>
  cents === null || cents <= 0 ? '—' : `R$ ${formatCentsBr(cents)}`;

const nextWeekIso = () => {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return d.toISOString().slice(0, 10);
};

export function ScantechCreator({ libraryData, run, onRefreshLibrary }: Props) {
  const [campaigns, setCampaigns] = useState<ScantechCampaign[]>([]);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const [photoshop, setPhotoshop] = useState<PhotoshopStatus | null>(null);
  const [scannedPsds, setScannedPsds] = useState<ScannedPsdEntry[]>([]);
  const [extraArtworks, setExtraArtworks] = useState<Map<string, ImportedArtwork>>(new Map());

  // Nova pasta Scantech
  const [newFolderName, setNewFolderName] = useState('');
  const [newGlobalStart, setNewGlobalStart] = useState('');
  const [newGlobalEnd, setNewGlobalEnd] = useState(nextWeekIso);

  // Importação Excel
  const [workbook, setWorkbook] = useState<ExcelWorkbook | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping>({
    f7Col: 0,
    descriptionCol: 1,
    priceCol: 2,
    startDateCol: null,
    endDateCol: null,
  });

  // Importação / Mapeamento PSD
  const [psdOfferContext, setPsdOfferContext] = useState<PsdImportOfferContext | null>(null);
  const [mappingModalView, setMappingModalView] = useState<ScantechItemView | null>(null);
  const [manualLayers, setManualLayers] = useState<ImportedLayerInfo[]>([]);
  const [manualRoles, setManualRoles] = useState<PsdRoleMap>({});

  // Filtros e seleção na tabela
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'todos' | 'encontrados' | 'sem-psd' | 'inconsistentes' | 'exportados'>('todos');
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);

  // Edição inline de preço e data individual
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editPriceInput, setEditPriceInput] = useState('');
  const [editEndDateInput, setEditEndDateInput] = useState('');
  const [editCustomValidity, setEditCustomValidity] = useState('');

  // Relatório de exportação
  const [exportReport, setExportReport] = useState<ScantechExportBatchResult | null>(null);

  const libraryIndex = useMemo(() => indexCartazes(libraryData?.entries ?? []), [libraryData]);

  useEffect(() => {
    let mounted = true;
    detectPhotoshop()
      .then(status => {
        if (mounted) setPhotoshop(status);
      })
      .catch(err => {
        if (mounted) setLoadErrors(prev => [...prev, String(err)]);
      });
    listScantechCampaigns()
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

  // Carrega PSDs da pasta de referência quando ativa
  useEffect(() => {
    if (!activeCampaign?.psdSourceFolder) {
      setScannedPsds([]);
      return;
    }
    let mounted = true;
    scanScantechPsdFolder(activeCampaign.psdSourceFolder)
      .then(entries => {
        if (mounted) setScannedPsds(entries);
      })
      .catch(() => {
        if (mounted) setScannedPsds([]);
      });
    return () => {
      mounted = false;
    };
  }, [activeCampaign?.psdSourceFolder]);

  const persistUpdate = async (updated: ScantechCampaign) => {
    const saved = await saveScantechCampaign(updated);
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
    const created = createScantechCampaign(
      newFolderName || 'Ofertas Scantech',
      newGlobalEnd,
      newGlobalStart || null
    );
    const saved = await persistUpdate(created);
    setActiveId(saved.id);
    setNewFolderName('');
  };

  const handleDuplicateCampaign = async () => {
    if (!activeCampaign) return;
    const copy = duplicateScantechCampaign(activeCampaign);
    const saved = await persistUpdate(copy);
    setActiveId(saved.id);
  };

  const handleChoosePsdSourceFolder = async () => {
    if (!activeCampaign) return;
    const folder = await chooseScantechPsdFolder();
    if (!folder) return;
    const entries = await scanScantechPsdFolder(folder);
    setScannedPsds(entries);
    const updated = updateScantechCampaignSettings(activeCampaign, { psdSourceFolder: folder });
    await persistUpdate(updated);
  };

  const handleChooseExportFolder = async () => {
    if (!activeCampaign) return;
    const folder = await chooseScantechExportFolder();
    if (!folder) return;
    const updated = updateScantechCampaignSettings(activeCampaign, { exportFolder: folder });
    await persistUpdate(updated);
  };

  const handleOpenExcel = async () => {
    const selected = await selectExcel();
    if (!selected) return;
    const wb = parseXlsx(selected.buffer, selected.name);
    setWorkbook(wb);
    setSheetIdx(0);
    setHeaderRow(0);
    const headers = wb.sheets[0]?.rows[0] ?? [];
    setMapping(suggestColumnMapping(headers));
  };

  const activeSheet = workbook?.sheets[sheetIdx] ?? null;

  const extractionPreview = useMemo(() => {
    if (!activeSheet) return null;
    return extractCampaignItemsFromSheet(activeSheet, headerRow, mapping);
  }, [activeSheet, headerRow, mapping]);

  const handleConfirmExcelImport = async () => {
    if (!activeCampaign || !workbook || !activeSheet || !extractionPreview) return;
    const updated = applyExcelToScantechCampaign(
      activeCampaign,
      extractionPreview,
      libraryIndex,
      scannedPsds,
      {
        fileName: workbook.fileName,
        sheetName: activeSheet.name,
        headerRowIndex: headerRow,
        mapping,
      }
    );
    await persistUpdate(updated);
    setWorkbook(null);
  };

  const itemViews = useMemo(() => {
    if (!activeCampaign) return [];
    return buildScantechItemViews(activeCampaign, libraryIndex, extraArtworks);
  }, [activeCampaign, libraryIndex, extraArtworks]);

  const filteredViews = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase('pt-BR');
    return itemViews.filter(v => {
      if (q && !`${v.item.f7} ${v.item.description}`.toLocaleLowerCase('pt-BR').includes(q)) {
        return false;
      }
      if (statusFilter === 'encontrados') return v.canExport || v.item.status === 'exportado';
      if (statusFilter === 'sem-psd') return v.item.status === 'sem-psd' || !v.item.sourcePsdPath;
      if (statusFilter === 'inconsistentes') {
        return v.item.status === 'inconsistente' || v.item.status === 'erro-exportacao' || v.blockingReasons.length > 0;
      }
      if (statusFilter === 'exportados') return v.item.status === 'exportado';
      return true;
    });
  }, [itemViews, searchQuery, statusFilter]);

  const selectedView = useMemo(() => {
    if (previewItemId) {
      const found = itemViews.find(v => v.item.id === previewItemId);
      if (found) return found;
    }
    return itemViews.find(v => v.artwork) ?? itemViews[0] ?? null;
  }, [itemViews, previewItemId]);

  const counts = useMemo(() => {
    const total = itemViews.length;
    const ready = itemViews.filter(v => v.canExport).length;
    const missingPsd = itemViews.filter(v => !v.item.sourcePsdPath || !v.item.wholeLayerId || !v.item.fractionLayerId).length;
    const inconsistent = itemViews.filter(v => v.item.issues.length > 0 || v.hasInvertedLayers || v.item.status === 'erro-exportacao').length;
    const exported = itemViews.filter(v => v.item.status === 'exportado').length;
    return { total, ready, missingPsd, inconsistent, exported };
  }, [itemViews]);

  const handleSelectDirectPsdForItem = async (view: ScantechItemView) => {
    if (!activeCampaign) return;
    const selected = await selectPsd();
    if (!selected) return;
    const analysis = await analyzePsd(selected.buffer, selected.name, selected.path);
    const roles = analysis.suggested;
    let builtArtwork: ImportedArtwork | null = null;
    if (roles.whole && roles.fraction) {
      try {
        builtArtwork = buildArtwork(analysis, roles);
      } catch {
        builtArtwork = null;
      }
    }
    if (builtArtwork) {
      setExtraArtworks(prev => {
        const next = new Map(prev);
        next.set(view.item.id, builtArtwork!);
        return next;
      });
    }
    const updated = updateScantechItemFields(activeCampaign, view.item.id, {
      sourcePsdPath: selected.path,
      sourcePsdName: selected.name,
      wholeLayerId: roles.whole ?? null,
      fractionLayerId: roles.fraction ?? null,
      decimalLayerId: roles.decimal ?? null,
      fractionRuleLayerId: roles.fractionRule ?? null,
      validityLayerId: roles.validity ?? null,
      originalValidityText: analysis.metadata.validityText || null,
    });
    await persistUpdate(updated);
    setPreviewItemId(view.item.id);
  };

  const handleOpenManualMapping = async (view: ScantechItemView) => {
    let layers = view.artwork?.layers ?? [];
    if (layers.length === 0 && view.item.sourcePsdPath) {
      const psdData = await readPsdByPath(view.item.sourcePsdPath);
      const analysis = await analyzePsd(psdData.buffer, psdData.name, psdData.path);
      layers = analysis.layers;
    }
    setManualLayers(layers);
    setManualRoles({
      whole: view.item.wholeLayerId ?? undefined,
      fraction: view.item.fractionLayerId ?? undefined,
      decimal: view.item.decimalLayerId ?? undefined,
      fractionRule: view.item.fractionRuleLayerId ?? undefined,
      validity: view.item.validityLayerId ?? undefined,
    });
    setMappingModalView(view);
  };

  const handleSaveManualMapping = async () => {
    if (!activeCampaign || !mappingModalView) return;
    const valLayer = manualLayers.find(l => l.id === manualRoles.validity);
    const updated = updateScantechItemFields(activeCampaign, mappingModalView.item.id, {
      wholeLayerId: manualRoles.whole ?? null,
      fractionLayerId: manualRoles.fraction ?? null,
      decimalLayerId: manualRoles.decimal ?? null,
      fractionRuleLayerId: manualRoles.fractionRule ?? null,
      validityLayerId: manualRoles.validity ?? null,
      originalValidityText: valLayer?.text ?? mappingModalView.item.originalValidityText,
    });
    await persistUpdate(updated);
    setMappingModalView(null);
  };

  const handleInvertReaisCentavos = async (view: ScantechItemView) => {
    if (!activeCampaign) return;
    if (view.item.cartazPath) {
      const libEntry = libraryIndex.find(
        e => e.path.toLowerCase() === view.item.cartazPath?.toLowerCase()
      );
      if (libEntry && libEntry.document.layout.template === 'imported-psd') {
        const { artwork, correctedPriceCents } = repairInvertedPsdArtwork(
          libEntry.document.layout.artwork
        );
        const fixedDoc: Cartaz = {
          ...libEntry.document,
          product: {
            ...libEntry.document.product,
            priceCents: correctedPriceCents ?? libEntry.document.product.priceCents,
          },
          layout: {
            ...libEntry.document.layout,
            artwork,
          },
          metadata: {
            ...libEntry.document.metadata,
            updatedAt: new Date().toISOString(),
          },
        };
        await saveDocument(libEntry.path, fixedDoc, true);
        if (onRefreshLibrary) await onRefreshLibrary();
      }
    }
    const updated = updateScantechItemFields(activeCampaign, view.item.id, {
      wholeLayerId: view.item.fractionLayerId,
      fractionLayerId: view.item.wholeLayerId,
    });
    await persistUpdate(updated);
  };

  const handlePsdImportedFromModal = async (path: string, savedDocument: Cartaz) => {
    if (!activeCampaign || !psdOfferContext) return;
    const sourcePsdPath =
      savedDocument.layout.template === 'imported-psd'
        ? savedDocument.layout.artwork.source.sourcePath ?? null
        : null;
    const updated = linkCartazAndPsdToScantechItem(
      activeCampaign,
      psdOfferContext.offerItemId,
      path,
      savedDocument,
      sourcePsdPath
    );
    await persistUpdate(updated);
    if (onRefreshLibrary) await onRefreshLibrary();
    setPreviewItemId(psdOfferContext.offerItemId);
  };

  const handleStartEditRow = (view: ScantechItemView) => {
    setEditingItemId(view.item.id);
    setEditPriceInput(formatCentsBr(view.item.priceCents));
    setEditEndDateInput(view.item.endDateIso ?? '');
    setEditCustomValidity(view.item.customValidityText ?? '');
  };

  const handleSaveRowEdits = async (itemId: string) => {
    if (!activeCampaign) return;
    const priceCents = parseExcelPriceToCents(editPriceInput);
    const endDateIso = editEndDateInput.trim() ? parseExcelDateToIso(editEndDateInput.trim()) : null;
    const updated = updateScantechItemFields(activeCampaign, itemId, {
      priceCents,
      endDateIso,
      customValidityText: editCustomValidity.trim() || null,
    });
    await persistUpdate(updated);
    setEditingItemId(null);
  };

  const runPhotoshopExport = async (targetViews: ScantechItemView[]) => {
    if (!activeCampaign) return;
    if (!photoshop?.available) {
      throw new Error(
        'O Adobe Photoshop não foi detectado no Windows. Instale ou configure o Photoshop antes de exportar arquivos PSD editáveis.'
      );
    }
    let exportFolder = activeCampaign.exportFolder;
    if (!exportFolder) {
      exportFolder = await chooseScantechExportFolder();
      if (!exportFolder) return;
    }

    const blocked = targetViews.filter(v => !v.canExport);
    if (blocked.length > 0 && blocked.length === targetViews.length) {
      const sampleReason = blocked[0].blockingReasons.join('; ');
      throw new Error(
        `Exportação bloqueada: todos os itens selecionados possuem inconsistências (Ex.: F7 ${blocked[0].item.f7}: ${sampleReason}).`
      );
    }

    const readyViews = targetViews.filter(v => v.canExport);
    const jobs: ScantechExportJob[] = readyViews.map(v => ({
      itemId: v.item.id,
      f7: v.item.f7,
      description: v.item.description,
      sourcePsdPath: v.item.sourcePsdPath!,
      outputPsdPath: buildOutputPsdPath(exportFolder!, v.item),
      wholeLayerId: v.item.wholeLayerId!,
      fractionLayerId: v.item.fractionLayerId!,
      validityLayerId: v.item.validityLayerId,
      wholeValue: v.wholeValue,
      fractionValue: v.fractionValue,
      validityText: v.resolvedValidityText,
    }));

    const batchResult = await exportScantechPsds(jobs);
    setExportReport(batchResult);

    const resultById = new Map(batchResult.results.map(r => [r.itemId, r]));
    const now = new Date().toISOString();
    const updatedCampaign: ScantechCampaign = {
      ...activeCampaign,
      exportFolder,
      updatedAt: now,
      items: activeCampaign.items.map(item => {
        const res = resultById.get(item.id);
        if (!res) return item;
        if (res.ok) {
          return {
            ...item,
            status: 'exportado' as ScantechItemStatus,
            exportedPsdPath: res.outputPsdPath,
            exportedAt: now,
            exportError: null,
          };
        }
        return {
          ...item,
          status: 'erro-exportacao' as ScantechItemStatus,
          exportError: res.error ?? 'Erro ao exportar PSD no Photoshop.',
        };
      }),
    };
    await persistUpdate(updatedCampaign);
  };

  const visibleCampaigns = campaigns.filter(c => (showArchived ? true : !c.archived));

  return (
    <div className="offers-module scantech-module">
      {/* Banner de Status do Photoshop */}
      <div
        className={photoshop?.available ? 'import-warning' : 'error-text'}
        style={{
          marginBottom: 14,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
        }}
        role="status"
      >
        <div>
          <strong>Integração Adobe Photoshop (Exportação PSD Editável):</strong>{' '}
          {photoshop ? (
            photoshop.available ? (
              <span>
                ● Conectado a <strong>{photoshop.productName}</strong> (v{photoshop.version}) · Modo:{' '}
                <code>{photoshop.automationMode}</code> · <code>{photoshop.exePath}</code>
              </span>
            ) : (
              <span>○ Indisponível — {photoshop.details}</span>
            )
          ) : (
            <span>Verificando instalação do Adobe Photoshop no Windows…</span>
          )}
        </div>
        <button
          type="button"
          className="subtle"
          onClick={() =>
            run(async () => {
              const st = await detectPhotoshop();
              setPhotoshop(st);
            })
          }
        >
          Reverificar Photoshop
        </button>
      </div>

      {loadErrors.map((err, idx) => (
        <p key={idx} className="error-text" role="alert">
          {err}
        </p>
      ))}

      <div className="offers-layout">
        {/* Coluna Esquerda: Pastas de Ofertas Scantech */}
        <aside className="panel offers-sidebar">
          <h2>Pastas Scantech</h2>
          <p>Campanhas para atualização de preço, validade e exportação PSD editável.</p>

          <div className="offers-create-box">
            <label>
              Nome da campanha Scantech
              <input
                maxLength={80}
                placeholder="Ex.: Oferta Scantech Fim de Semana"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
              />
            </label>
            <label>
              Validade global (ATÉ)
              <input
                type="date"
                value={newGlobalEnd}
                onChange={e => setNewGlobalEnd(e.target.value)}
              />
            </label>
            <label>
              Data inicial global (opcional)
              <input
                type="date"
                value={newGlobalStart}
                onChange={e => setNewGlobalStart(e.target.value)}
              />
            </label>
            <button onClick={() => run(handleCreateCampaign)}>+ Criar pasta Scantech</button>
          </div>

          <div className="offers-filter-bar">
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={e => setShowArchived(e.target.checked)}
              />
              Mostrar arquivadas
            </label>
          </div>

          <div className="offers-folder-list" role="list">
            {visibleCampaigns.length === 0 ? (
              <p className="empty">Nenhuma pasta Scantech criada ainda.</p>
            ) : (
              visibleCampaigns.map(c => (
                <button
                  key={c.id}
                  type="button"
                  className={`offers-folder-card ${c.id === activeId ? 'active' : ''}`}
                  onClick={() => setActiveId(c.id)}
                >
                  <div>
                    <strong>{c.name}</strong>
                    <small>
                      Validade até {formatIsoDateShortBr(c.globalEndDate)} · {c.items.length} itens
                    </small>
                  </div>
                  {c.archived && <span className="badge">Arquivada</span>}
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Área Principal da Campanha Scantech */}
        <section className="panel offers-main">
          {!activeCampaign ? (
            <div className="empty-state">
              <h2>Criar Cartaz Scantech</h2>
              <p>
                Crie ou selecione uma pasta Scantech à esquerda para importar planilhas Excel, localizar artes PSD e exportar novos arquivos .psd editáveis pelo Photoshop.
              </p>
            </div>
          ) : (
            <>
              <div className="offers-header">
                <div>
                  <h2>{activeCampaign.name}</h2>
                  <p>
                    Validade global:{' '}
                    <strong>
                      OFERTA VÁLIDA ATÉ {formatIsoDateShortBr(activeCampaign.globalEndDate)}
                    </strong>{' '}
                    ({activeCampaign.globalEndDate})
                    {activeCampaign.sourceExcel && (
                      <span>
                        {' '}
                        · Planilha: <code>{activeCampaign.sourceExcel.fileName}</code> (
                        {activeCampaign.sourceExcel.sheetName})
                      </span>
                    )}
                  </p>
                </div>
                <div className="toolbar">
                  <button onClick={() => run(handleOpenExcel)}>Importar Excel (.xlsx)</button>
                  <button className="subtle" onClick={() => run(handleChoosePsdSourceFolder)}>
                    Pasta PSDs ({scannedPsds.length})
                  </button>
                  <button className="subtle" onClick={() => run(handleChooseExportFolder)}>
                    Pasta de Saída
                  </button>
                  <button className="subtle" onClick={() => run(handleDuplicateCampaign)}>
                    Duplicar
                  </button>
                </div>
              </div>

              {/* Barra de Configuração Global de Validade e Pastas */}
              <div
                className="import-warning"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                  gap: 12,
                  alignItems: 'end',
                  marginBottom: 14,
                }}
              >
                <label style={{ margin: 0 }}>
                  Validade global da campanha (ATÉ)
                  <input
                    type="date"
                    value={activeCampaign.globalEndDate}
                    onChange={e => {
                      const val = e.target.value;
                      if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
                        run(async () => {
                          await persistUpdate(
                            updateScantechCampaignSettings(activeCampaign, { globalEndDate: val })
                          );
                        });
                      }
                    }}
                  />
                </label>
                <div>
                  <small style={{ display: 'block', fontWeight: 600 }}>Pasta de PSDs de origem:</small>
                  <code style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {activeCampaign.psdSourceFolder || 'Biblioteca local (.skcartaz) / Seleção manual'}
                  </code>
                </div>
                <div>
                  <small style={{ display: 'block', fontWeight: 600 }}>Pasta de exportação PSD:</small>
                  <code style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {activeCampaign.exportFolder || 'Solicitar ao exportar'}
                  </code>
                </div>
              </div>

              {/* Resumo de Indicadores */}
              <div className="offers-stats">
                <div className="stat-card">
                  <span>Total na planilha</span>
                  <strong>{counts.total}</strong>
                </div>
                <div className="stat-card">
                  <span>Prontos p/ exportar</span>
                  <strong className="success">{counts.ready}</strong>
                </div>
                <div className="stat-card">
                  <span>Sem PSD / Camadas</span>
                  <strong className={counts.missingPsd > 0 ? 'error-text' : ''}>{counts.missingPsd}</strong>
                </div>
                <div className="stat-card">
                  <span>Com inconsistências</span>
                  <strong className={counts.inconsistent > 0 ? 'error-text' : ''}>
                    {counts.inconsistent}
                  </strong>
                </div>
                <div className="stat-card">
                  <span>PSDs exportados</span>
                  <strong>{counts.exported}</strong>
                </div>
              </div>

              {/* Barra de Filtros e Exportação em Lote */}
              <div
                className="offers-controls-row"
                style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '12px 0' }}
              >
                <input
                  type="search"
                  placeholder="Buscar por código F7 ou descrição…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  style={{ flex: '1 1 220px' }}
                />
                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
                >
                  <option value="todos">Todos os produtos ({counts.total})</option>
                  <option value="encontrados">Encontrados / Prontos ({counts.ready})</option>
                  <option value="sem-psd">Não encontrados / Sem PSD ({counts.missingPsd})</option>
                  <option value="inconsistentes">Com inconsistências ({counts.inconsistent})</option>
                  <option value="exportados">Exportados ({counts.exported})</option>
                </select>
                <button
                  disabled={!photoshop?.available || counts.ready === 0}
                  onClick={() =>
                    run(async () => {
                      const selectedReady = itemViews.filter(v => v.item.selected && v.canExport);
                      const targets = selectedReady.length > 0 ? selectedReady : itemViews.filter(v => v.canExport);
                      await runPhotoshopExport(targets);
                    })
                  }
                >
                  Exportar PSDs em Lote no Photoshop ({itemViews.filter(v => v.item.selected && v.canExport).length || counts.ready})
                </button>
              </div>

              {/* Relatório de Exportação em Lote */}
              {exportReport && (
                <div className="import-warning" role="region" aria-label="Relatório de exportação PSD">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>
                      Relatório de Exportação Photoshop (v{exportReport.photoshopVersion ?? 'CS6'}):{' '}
                      {exportReport.results.filter(r => r.ok).length} concluído(s),{' '}
                      {exportReport.results.filter(r => !r.ok).length} falha(s)
                    </strong>
                    <button type="button" className="subtle" onClick={() => setExportReport(null)}>
                      Fechar relatório
                    </button>
                  </div>
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
                    {exportReport.results.map(r => (
                      <li key={r.itemId} className={r.ok ? 'success' : 'error-text'}>
                        <strong>F7 {r.f7 || '—'}:</strong>{' '}
                        {r.ok ? (
                          <span>
                            PSD editável validado (8BPS + TySh) salvo em <code>{r.outputPsdPath}</code> · Reais:{' '}
                            <code>{r.wholeApplied}</code>, Centavos: <code>{r.fractionApplied}</code>
                            {r.validityApplied ? `, Validade: “${r.validityApplied}”` : ''}
                          </span>
                        ) : (
                          <span>Bloqueado / Erro: {r.error}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Área Dividida: Tabela de Produtos + Prévia Visual A5 */}
              <div className="offers-workspace">
                <div className="offers-table-wrap">
                  {filteredViews.length === 0 ? (
                    <p className="empty">
                      Nenhum produto listado neste filtro. Importe uma planilha Excel (.xlsx) para começar.
                    </p>
                  ) : (
                    <table className="offers-table">
                      <thead>
                        <tr>
                          <th>Sel.</th>
                          <th>F7</th>
                          <th>Produto / Arte PSD</th>
                          <th>Preço (Reais / Cent.)</th>
                          <th>Texto de Validade</th>
                          <th>Status / Ações</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredViews.map(v => {
                          const isEditing = editingItemId === v.item.id;
                          const isSelectedPreview = selectedView?.item.id === v.item.id;
                          return (
                            <tr
                              key={v.item.id}
                              className={isSelectedPreview ? 'selected-row' : ''}
                              onClick={() => setPreviewItemId(v.item.id)}
                            >
                              <td onClick={e => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={v.item.selected}
                                  disabled={!v.canExport}
                                  onChange={e =>
                                    run(async () => {
                                      await persistUpdate(
                                        updateScantechItemFields(activeCampaign, v.item.id, {
                                          selected: e.target.checked,
                                        })
                                      );
                                    })
                                  }
                                />
                              </td>
                              <td>
                                <code>{v.item.f7 || 'SEM F7'}</code>
                              </td>
                              <td>
                                <strong>{v.item.description}</strong>
                                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
                                  {v.item.sourcePsdName ? (
                                    <span>
                                      PSD: <code>{v.item.sourcePsdName}</code>
                                    </span>
                                  ) : (
                                    <span className="error-text">Sem arquivo .psd associado</span>
                                  )}
                                </div>
                                {v.blockingReasons.length > 0 && (
                                  <div className="error-text" style={{ fontSize: 11, marginTop: 4 }} role="alert">
                                    {v.blockingReasons.map((reason, i) => (
                                      <div key={i}>⚠ {reason}</div>
                                    ))}
                                  </div>
                                )}
                                {v.item.exportedPsdPath && (
                                  <div className="success" style={{ fontSize: 11, marginTop: 4 }}>
                                    ✓ Exportado: <code>{v.item.exportedPsdPath}</code>
                                  </div>
                                )}
                                {v.item.exportError && (
                                  <div className="error-text" style={{ fontSize: 11, marginTop: 4 }}>
                                    ✕ Erro: {v.item.exportError}
                                  </div>
                                )}
                              </td>
                              <td onClick={e => e.stopPropagation()}>
                                {isEditing ? (
                                  <input
                                    inputMode="decimal"
                                    value={editPriceInput}
                                    onChange={e => setEditPriceInput(e.target.value)}
                                    style={{ width: 90 }}
                                  />
                                ) : (
                                  <div>
                                    <strong>{money(v.item.priceCents)}</strong>
                                    <small style={{ display: 'block', fontSize: 11 }}>
                                      Reais: <code>{v.wholeValue}</code> | Cent: <code>{v.fractionValue}</code>
                                    </small>
                                  </div>
                                )}
                              </td>
                              <td onClick={e => e.stopPropagation()}>
                                {isEditing ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    <input
                                      type="date"
                                      value={editEndDateInput}
                                      onChange={e => setEditEndDateInput(e.target.value)}
                                      title="Data final individual (opcional)"
                                    />
                                    <input
                                      placeholder="Texto customizado (opcional)"
                                      value={editCustomValidity}
                                      onChange={e => setEditCustomValidity(e.target.value.toUpperCase())}
                                    />
                                  </div>
                                ) : (
                                  <div>
                                    <code>{v.resolvedValidityText}</code>
                                    <small style={{ display: 'block', fontSize: 11 }}>
                                      {v.item.endDateIso
                                        ? `Validade individual: ${formatIsoDateShortBr(v.item.endDateIso)}`
                                        : `Validade global: ${formatIsoDateShortBr(v.effectiveEndDate)}`}
                                    </small>
                                  </div>
                                )}
                              </td>
                              <td onClick={e => e.stopPropagation()}>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                  {isEditing ? (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => run(() => handleSaveRowEdits(v.item.id))}
                                      >
                                        Salvar
                                      </button>
                                      <button
                                        type="button"
                                        className="subtle"
                                        onClick={() => setEditingItemId(null)}
                                      >
                                        Cancelar
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        className="subtle"
                                        onClick={() => handleStartEditRow(v)}
                                      >
                                        Revisar
                                      </button>
                                      <button
                                        type="button"
                                        className="subtle"
                                        onClick={() => run(() => handleSelectDirectPsdForItem(v))}
                                      >
                                        Vincular .PSD
                                      </button>
                                      {v.item.f7 && (
                                        <button
                                          type="button"
                                          className="subtle"
                                          onClick={() =>
                                            setPsdOfferContext({
                                              folderId: activeCampaign.id,
                                              offerItemId: v.item.id,
                                              productCode: v.item.f7,
                                              description: v.item.description,
                                              futurePriceCents: v.item.priceCents || 100,
                                            })
                                          }
                                        >
                                          Importar p/ Biblioteca
                                        </button>
                                      )}
                                      {(v.artwork || v.item.sourcePsdPath) && (
                                        <button
                                          type="button"
                                          className="subtle"
                                          onClick={() => run(() => handleOpenManualMapping(v))}
                                        >
                                          Camadas
                                        </button>
                                      )}
                                      {v.hasInvertedLayers && (
                                        <button
                                          type="button"
                                          onClick={() => run(() => handleInvertReaisCentavos(v))}
                                        >
                                          Corrigir Inversão Reais/Centavos
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        disabled={!photoshop?.available || !v.canExport}
                                        onClick={() => run(() => runPhotoshopExport([v]))}
                                      >
                                        Exportar PSD
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Painel de Prévia antes da Exportação */}
                <div className="offers-preview-pane">
                  <h3>Prévia antes da exportação</h3>
                  {selectedView ? (
                    <>
                      <p style={{ fontSize: 12, margin: '4px 0 8px' }}>
                        <strong>{selectedView.item.description}</strong> (F7{' '}
                        <code>{selectedView.item.f7 || '—'}</code>)<br />
                        Preço: <strong>{money(selectedView.item.priceCents)}</strong> · Validade:{' '}
                        <code>{selectedView.resolvedValidityText}</code>
                      </p>
                      {selectedView.artwork ? (
                        <div className="paper-wrap">
                          <PosterView
                            poster={{
                              name: selectedView.item.description.slice(0, 32),
                              detail: '',
                              unit: 'UN',
                              price: formatCentsBr(selectedView.item.priceCents),
                              artwork: selectedView.artwork,
                              validityText: selectedView.resolvedValidityText,
                            }}
                          />
                        </div>
                      ) : (
                        <p className="empty">
                          Vincule ou importe a arte PSD deste produto para visualizar a prévia das camadas antes da exportação.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="empty">Selecione um produto na tabela para ver a prévia.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {/* Modal de Importação Excel com Mapeamento de F7, Descrição, Preço, Data Inicial e Data Final */}
      {workbook && activeSheet && (
        <div className="modal-backdrop">
          <section className="panel modal-panel" role="dialog" aria-modal="true">
            <div className="psd-title">
              <div>
                <h2>Importar Planilha Excel Scantech — {workbook.fileName}</h2>
                <p>Mapeie F7, descrição, preço e opcionalmente data inicial e data final da oferta.</p>
              </div>
              <button className="subtle" onClick={() => setWorkbook(null)}>
                Fechar
              </button>
            </div>

            <div className="psd-fields" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
              <label>
                Aba da planilha
                <select
                  value={sheetIdx}
                  onChange={e => {
                    const idx = Number(e.target.value);
                    setSheetIdx(idx);
                    const headers = workbook.sheets[idx]?.rows[headerRow] ?? [];
                    setMapping(suggestColumnMapping(headers));
                  }}
                >
                  {workbook.sheets.map((s, i) => (
                    <option key={s.name} value={i}>
                      {s.name} ({s.rows.length} linhas)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Linha de cabeçalho
                <select
                  value={headerRow}
                  onChange={e => {
                    const r = Number(e.target.value);
                    setHeaderRow(r);
                    setMapping(suggestColumnMapping(activeSheet.rows[r] ?? []));
                  }}
                >
                  {activeSheet.rows.slice(0, 15).map((r, i) => (
                    <option key={i} value={i}>
                      Linha {i + 1}: {r.filter(Boolean).slice(0, 3).join(' | ') || '(vazia)'}
                    </option>
                  ))}
                </select>
              </label>

              {(['f7Col', 'descriptionCol', 'priceCol'] as const).map(colKey => (
                <label key={colKey}>
                  {colKey === 'f7Col'
                    ? 'Coluna F7'
                    : colKey === 'descriptionCol'
                      ? 'Coluna Descrição'
                      : 'Coluna Preço'}
                  <select
                    value={mapping[colKey]}
                    onChange={e => setMapping(prev => ({ ...prev, [colKey]: Number(e.target.value) }))}
                  >
                    {(activeSheet.rows[headerRow] ?? []).map((h, i) => (
                      <option key={i} value={i}>
                        Coluna {columnLetter(i)} — {h || '(sem título)'}
                      </option>
                    ))}
                  </select>
                </label>
              ))}

              <label>
                Coluna Data Inicial (opcional)
                <select
                  value={mapping.startDateCol ?? -1}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setMapping(prev => ({ ...prev, startDateCol: v >= 0 ? v : null }));
                  }}
                >
                  <option value={-1}>Não usar (usar global)</option>
                  {(activeSheet.rows[headerRow] ?? []).map((h, i) => (
                    <option key={i} value={i}>
                      Coluna {columnLetter(i)} — {h || '(sem título)'}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Coluna Data Final / Validade (opcional)
                <select
                  value={mapping.endDateCol ?? -1}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setMapping(prev => ({ ...prev, endDateCol: v >= 0 ? v : null }));
                  }}
                >
                  <option value={-1}>Não usar (usar validade global)</option>
                  {(activeSheet.rows[headerRow] ?? []).map((h, i) => (
                    <option key={i} value={i}>
                      Coluna {columnLetter(i)} — {h || '(sem título)'}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {extractionPreview && (
              <div style={{ marginTop: 12 }}>
                <p>
                  <strong>Prévia da validação:</strong> {extractionPreview.validCount} válido(s) ·{' '}
                  {extractionPreview.invalidCount} com alertas/inconsistências
                </p>
                <div style={{ maxHeight: 240, overflow: 'auto' }}>
                  <table className="offers-table">
                    <thead>
                      <tr>
                        <th>Linha</th>
                        <th>F7</th>
                        <th>Descrição</th>
                        <th>Preço</th>
                        <th>Validade</th>
                        <th>Validação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {extractionPreview.items.slice(0, 50).map(item => (
                        <tr key={item.rowNumber}>
                          <td>{item.rowNumber}</td>
                          <td>
                            <code>{item.f7 ?? item.f7Raw}</code>
                          </td>
                          <td>{item.description}</td>
                          <td>{item.priceCents !== null ? money(item.priceCents) : item.priceRaw}</td>
                          <td>
                            {item.endDateIso
                              ? formatIsoDateShortBr(item.endDateIso)
                              : activeCampaign
                                ? `${formatIsoDateShortBr(activeCampaign.globalEndDate)} (global)`
                                : '—'}
                          </td>
                          <td>
                            {item.issues.length === 0 ? (
                              <span className="success">OK</span>
                            ) : (
                              <span className="error-text">{item.issues.join(', ')}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="toolbar" style={{ marginTop: 14 }}>
              <button onClick={() => run(handleConfirmExcelImport)}>
                Confirmar importação para pasta Scantech
              </button>
              <button className="subtle" onClick={() => setWorkbook(null)}>
                Cancelar
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Modal de Mapeamento Manual das Camadas PSD (Reais, Centavos e Validade) */}
      {mappingModalView && (
        <div className="modal-backdrop">
          <section className="panel modal-panel" role="dialog" aria-modal="true">
            <div className="psd-title">
              <div>
                <h2>Mapeamento de Camadas PSD — {mappingModalView.item.description}</h2>
                <p>Revise ou ajuste manualmente as camadas de Reais, Centavos e Validade da oferta.</p>
              </div>
              <button className="subtle" onClick={() => setMappingModalView(null)}>
                Fechar
              </button>
            </div>

            <div className="psd-role-grid" style={{ marginTop: 12 }}>
              {(
                [
                  ['whole', 'Reais (parte inteira — esquerda)'],
                  ['fraction', 'Centavos (2 dígitos — direita)'],
                  ['validity', 'Validade da oferta (Ex.: OFERTA VÁLIDA ATÉ 25/10)'],
                  ['decimal', 'Vírgula (opcional)'],
                  ['fractionRule', 'Linha dos centavos (opcional)'],
                ] as const
              ).map(([roleKey, label]) => (
                <label key={roleKey}>
                  {label}
                  <select
                    value={manualRoles[roleKey] ?? ''}
                    onChange={e =>
                      setManualRoles(prev => ({
                        ...prev,
                        [roleKey]: e.target.value || undefined,
                      }))
                    }
                  >
                    <option value="">Não mapeada</option>
                    {manualLayers
                      .filter(l => l.visible && l.type !== 'group' && l.type !== 'empty')
                      .map(layer => (
                        <option key={layer.id} value={layer.id}>
                          [{layer.id}] {layer.name}
                          {layer.text ? ` — “${layer.text}”` : ''} (left={layer.bounds.left})
                        </option>
                      ))}
                  </select>
                </label>
              ))}
            </div>

            <div className="toolbar" style={{ marginTop: 16 }}>
              <button onClick={() => run(handleSaveManualMapping)}>Salvar mapeamento de camadas</button>
              <button className="subtle" onClick={() => setMappingModalView(null)}>
                Cancelar
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Reutilização do Modal PsdImport existente */}
      {psdOfferContext && (
        <Suspense fallback={<div className="modal-backdrop"><section className="panel">Carregando importador PSD…</section></div>}>
          <PsdImport
            offerContext={psdOfferContext}
            close={() => setPsdOfferContext(null)}
            saved={handlePsdImportedFromModal}
          />
        </Suspense>
      )}
    </div>
  );
}

