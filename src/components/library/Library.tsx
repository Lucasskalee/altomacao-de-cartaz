import { lazy, Suspense, useMemo, useState } from 'react';
import type { Cartaz, Entry, Library as LibraryData } from '../../features/cartazes/types';
import { duplicate } from '../../features/cartazes/serialization';
import * as storage from '../../features/cartazes/storage';
import { PosterView } from '../editor/PosterView';
import { getF7, indexCartazes, matchesCartazSearch, withoutF7 } from '../../features/cartazes/f7';
import { posterFromDocument } from '../../features/cartazes/presentation';

const PsdImport = lazy(() => import('./PsdImport').then(module => ({ default: module.PsdImport })));

type Props = {
  data: LibraryData;
  open: (path: string) => Promise<void>;
  newDocument: () => Promise<void>;
  run: (action: () => Promise<void>) => void;
  refresh: () => Promise<void>;
  relocated: (old: string, next: string) => void;
  removed: (path: string) => void;
  onAddToConductor?: (cartaz: Cartaz, path: string) => void;
};

export function Library({
  data,
  open,
  newDocument,
  run,
  refresh,
  relocated,
  removed,
  onAddToConductor,
}: Props) {
  const [folder, setFolder] = useState(() => {
    if (typeof window !== 'undefined') {
      const f = new URLSearchParams(window.location.search).get('folder');
      if (f) {
        const found = data.entries.find(e => e.folder && (e.name === f || e.path.endsWith(f)));
        if (found) return found.path;
      }
    }
    return data.root;
  });
  const [query, setQuery] = useState('');
  const [onlyWithoutF7, setOnlyWithoutF7] = useState(false);
  const [fileFormat, setFileFormat] = useState<'all' | 'skcartaz' | 'psd'>('all');
  const [sort, setSort] = useState('date');
  const [view, setView] = useState<'grid' | 'list'>(() => {
    if (typeof window !== 'undefined') {
      const v = new URLSearchParams(window.location.search).get('view');
      if (v === 'list' || v === 'grid') return v;
    }
    return 'grid';
  });
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<Entry | null>(null);
  const [renameName, setRenameName] = useState('');
  const [deleting, setDeleting] = useState<{ entry: Entry; isFolder: boolean } | null>(null);
  const [importingPsd, setImportingPsd] = useState(false);

  const indexed = useMemo(() => indexCartazes(data.entries), [data.entries]);
  const byPath = useMemo(() => new Map(indexed.map(item => [item.path, item])), [indexed]);
  const uncodedPaths = useMemo(() => new Set(withoutF7(indexed).map(item => item.path)), [indexed]);
  const globalSearch = Boolean(query.trim() || onlyWithoutF7 || fileFormat !== 'all');

  const folders = useMemo(
    () => data.entries.filter(e => e.folder).sort((a, b) => a.path.localeCompare(b.path, 'pt-BR')),
    [data.entries]
  );

  // Contagem real de cartazes por pasta
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of data.entries) {
      if (!e.folder) {
        const parent = storage.parent(e.path);
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
      }
    }
    return counts;
  }, [data.entries]);

  const totalCartazesCount = useMemo(
    () => data.entries.filter(e => !e.folder).length,
    [data.entries]
  );

  const active = folder === data.root || folders.some(e => e.path === folder) ? folder : data.root;

  const rows = useMemo(() => {
    return data.entries
      .filter(e => !e.folder && (globalSearch || storage.parent(e.path) === active))
      .filter(e => {
        if (onlyWithoutF7 && !uncodedPaths.has(e.path)) return false;
        
        // Filtro por formato de arquivo
        if (fileFormat === 'psd') {
          const isPsd = e.name.toLowerCase().endsWith('.psd') || byPath.get(e.path)?.document.layout.template === 'imported-psd';
          if (!isPsd) return false;
        } else if (fileFormat === 'skcartaz') {
          const isPsd = e.name.toLowerCase().endsWith('.psd') || byPath.get(e.path)?.document.layout.template === 'imported-psd';
          if (isPsd) return false;
        }

        if (!query.trim()) return true;

        const item = byPath.get(e.path);
        if (item) {
          return matchesCartazSearch(item, query);
        }
        return e.name.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR'));
      })
      .sort((a, b) => {
        if (sort === 'date' || sort === 'date_desc') {
          return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
        }
        if (sort === 'date_asc') {
          return (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0);
        }
        if (sort === 'name_desc') {
          return label(b).localeCompare(label(a), 'pt-BR');
        }
        return label(a).localeCompare(label(b), 'pt-BR');
      });
  }, [data.entries, globalSearch, active, onlyWithoutF7, uncodedPaths, fileFormat, query, byPath, sort]);

  function label(e: Entry) {
    return byPath.get(e.path)?.document.product.name ?? e.name;
  }

  const renameEntry = async () => {
    if (!editing) return;
    const next = await storage.rename(editing.path, renameName);
    relocated(editing.path, next);
    setEditing(null);
    await refresh();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const target = deleting.entry;
    setDeleting(null);
    if (await storage.remove(target.path)) {
      removed(target.path);
      await refresh();
    }
  };

  const handleDuplicate = async (e: Entry) => {
    const doc = duplicate(await storage.openDocument(e.path));
    const dest = await storage.chooseSave('copia-' + e.name);
    if (dest) {
      await storage.saveDocument(dest, doc);
      await refresh();
    }
  };

  const handleMove = async (e: Entry) => {
    const dest = await storage.chooseFolder();
    if (dest) {
      const next = await storage.move(e.path, dest);
      relocated(e.path, next);
      await refresh();
    }
  };

  const activeFolderName = active === data.root ? 'Pasta Principal' : active.split(/[\\/]/).pop() || active;

  return (
    <section className="library panel sk-library-container" aria-label="Biblioteca de Cartazes">
      {/* 1. Header da Biblioteca */}
      <div className="library-heading sk-lib-header">
        <div>
          <h2>Meus Cartazes</h2>
          <p>Biblioteca local no computador · Operação 100% offline</p>
          <div className="sk-lib-root-pill" title={data.root}>
            <span className="sk-lib-root-icon">📁</span>
            <span className="sk-lib-root-text">{data.root}</span>
            <span className="sk-lib-root-badge">{totalCartazesCount} cartazes</span>
          </div>
        </div>
        <div className="toolbar sk-lib-top-actions">
          <button
            type="button"
            className="editor-btn subtle"
            onClick={() => setImportingPsd(true)}
            title="Importar arquivo PSD do Photoshop"
          >
            🎨 Importar Arte PSD
          </button>
          <button
            type="button"
            className="editor-btn primary"
            onClick={() => run(newDocument)}
            title="Criar novo cartaz promocional no editor"
          >
            + Novo Cartaz
          </button>
        </div>
      </div>

      <p className="library-path sr-only">{data.root}</p>

      {/* 2. Layout Principal: Lateral (Pastas) + Conteúdo (Cartazes) */}
      <div className="library-layout sk-lib-layout">
        {/* Painel Lateral: Pastas */}
        <aside className="sk-lib-sidebar" aria-label="Pastas da biblioteca">
          <div className="sk-lib-sidebar-title">
            <span>Pastas da Biblioteca</span>
            <span className="sk-lib-sidebar-count">{folders.length + 1}</span>
          </div>

          <div className="sk-lib-folders-list">
            {/* Pasta Raiz / Principal */}
            <button
              type="button"
              className={active === data.root ? 'folder selected sk-lib-folder-btn' : 'folder sk-lib-folder-btn'}
              onClick={() => setFolder(data.root)}
              title="Exibir todos os cartazes na pasta raiz"
            >
              <span className="sk-lib-folder-icon">▣</span>
              <span className="sk-lib-folder-name">Todos na pasta principal</span>
              <span className="sk-lib-folder-badge">{folderCounts.get(data.root) ?? 0}</span>
            </button>

            {/* Subpastas com hierarquia */}
            {folders.map(e => {
              const depth = Math.min(5, Math.max(0, e.path.slice(data.root.length).split(/[\\/]/).length - 2));
              const count = folderCounts.get(e.path) ?? 0;
              const isSelected = active === e.path;

              return (
                <div key={e.path} className="sk-lib-folder-item" style={{ paddingLeft: depth * 14 }}>
                  <button
                    type="button"
                    className={isSelected ? 'folder selected sk-lib-folder-btn' : 'folder sk-lib-folder-btn'}
                    onClick={() => setFolder(e.path)}
                    title={e.path}
                  >
                    <span className="sk-lib-folder-icon">📁</span>
                    <span className="sk-lib-folder-name">{e.name}</span>
                    <span className="sk-lib-folder-badge">{count}</span>
                  </button>

                  {/* Ações da pasta ativa selecionada */}
                  {isSelected && (
                    <div className="folder-actions sk-lib-folder-actions">
                      <button
                        type="button"
                        className="editor-btn subtle"
                        style={{ fontSize: 11, padding: '4px 8px' }}
                        onClick={() => {
                          setEditing(e);
                          setRenameName(e.name);
                        }}
                      >
                        Renomear
                      </button>
                      <button
                        type="button"
                        className="editor-btn subtle danger"
                        style={{ fontSize: 11, padding: '4px 8px' }}
                        onClick={() => setDeleting({ entry: e, isFolder: true })}
                      >
                        Excluir pasta
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Criação de Nova Pasta */}
          <form
            className="sk-lib-new-folder-form"
            onSubmit={e => {
              e.preventDefault();
              if (!newName.trim()) return;
              run(async () => {
                await storage.createFolder(active, newName.trim());
                setNewName('');
                await refresh();
              });
            }}
          >
            <label className="sk-lib-new-folder-label">
              <span>Nova subpasta em <strong>{activeFolderName}</strong>:</span>
              <div className="sk-lib-new-folder-row">
                <input
                  aria-label="Nome da nova pasta"
                  placeholder="Nome da pasta..."
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  required
                  maxLength={100}
                />
                <button type="submit" className="editor-btn subtle">
                  Criar
                </button>
              </div>
            </label>
          </form>
        </aside>

        {/* Conteúdo Principal da Biblioteca */}
        <div className="sk-lib-main">
          {/* Barra de Filtros, Busca e Exibição */}
          <div className="library-toolbar sk-lib-toolbar">
            {/* Campo de Busca por Nome, F7 e Arquivo */}
            <div className="sk-lib-search-box">
              <span className="sk-lib-search-icon">🔍</span>
              <input
                aria-label="Pesquisar por nome ou F7 em todas as pastas"
                placeholder="Pesquisar por nome ou F7 em todas as pastas…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className="sk-lib-search-clear"
                  onClick={() => setQuery('')}
                  title="Limpar pesquisa"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Filtro por Formato */}
            <select
              aria-label="Filtrar por formato de arquivo"
              value={fileFormat}
              onChange={e => setFileFormat(e.target.value as 'all' | 'skcartaz' | 'psd')}
              className="sk-lib-select"
            >
              <option value="all">Todos os formatos</option>
              <option value="skcartaz">Somente .skcartaz</option>
              <option value="psd">Somente PSD (Photoshop)</option>
            </select>

            {/* Ordenação */}
            <select
              aria-label="Ordenar"
              value={sort}
              onChange={e => setSort(e.target.value)}
              className="sk-lib-select"
            >
              <option value="date">Mais recentes</option>
              <option value="date_asc">Mais antigos</option>
              <option value="name">Nome do produto (A-Z)</option>
              <option value="name_desc">Nome do produto (Z-A)</option>
            </select>

            {/* Alternância Grade / Lista */}
            <div className="sk-view-mode-toggle" role="group" aria-label="Visualização">
              <button
                type="button"
                className={`sk-view-toggle-btn ${view === 'grid' ? 'active' : ''}`}
                onClick={() => setView('grid')}
                title="Visualização em Grade de Cartazes"
              >
                ☷ Grade
              </button>
              <button
                type="button"
                className={`sk-view-toggle-btn ${view === 'list' ? 'active' : ''}`}
                onClick={() => setView('list')}
                title="Visualização em Lista Detalhada"
              >
                ☰ Lista
              </button>
            </div>

            <button
              type="button"
              className="editor-btn subtle"
              onClick={() => run(refresh)}
              title="Recarregar biblioteca de arquivos"
            >
              ↻ Atualizar
            </button>
          </div>

          {/* Filtro Somente sem F7 e Status da Pasta */}
          <div className="sk-lib-meta-bar">
            <label className="f7-filter sk-lib-checkbox-label">
              <input
                type="checkbox"
                checked={onlyWithoutF7}
                onChange={e => setOnlyWithoutF7(e.target.checked)}
              />
              <span>Somente cartazes sem F7 (todas as pastas)</span>
            </label>

            <div className="sk-lib-status-info">
              <p className="library-path" style={{ margin: 0 }}>
                {globalSearch ? (
                  <span><strong>Pesquisa Global:</strong> {rows.length} cartaz(es) encontrados</span>
                ) : (
                  <span>Pasta: <strong>{activeFolderName}</strong> · {rows.length} cartaz(es)</span>
                )}
              </p>
            </div>
          </div>

          {/* Estado Vazio */}
          {rows.length === 0 && (
            <div className="empty sk-lib-empty-state">
              <div className="sk-lib-empty-icon">🏷️</div>
              <h3>Nenhum cartaz encontrado</h3>
              <p>
                {globalSearch
                  ? 'Nenhum cartaz corresponde aos critérios de pesquisa ou filtros aplicados.'
                  : `A pasta "${activeFolderName}" está vazia no momento.`}
              </p>
              <div className="sk-lib-empty-actions">
                <button
                  type="button"
                  className="editor-btn primary"
                  onClick={() => run(newDocument)}
                >
                  Criar Novo Cartaz no Editor
                </button>
                <button
                  type="button"
                  className="editor-btn subtle"
                  onClick={() => setImportingPsd(true)}
                >
                  Importar Arte PSD
                </button>
              </div>
            </div>
          )}

          {/* Modo Grade de Cartazes */}
          {rows.length > 0 && view === 'grid' && (
            <div className="cards grid sk-lib-grid-cards">
              {rows.map(e => {
                const d = byPath.get(e.path)?.document;
                const error = e.error || (!d ? 'Documento inválido ou incompatível.' : undefined);
                const f7 = getF7(d?.product.productCode);
                const isPsd = d?.layout.template === 'imported-psd' || e.name.toLowerCase().endsWith('.psd');
                const priceFormatted = d
                  ? (d.product.priceCents / 100).toFixed(2).replace('.', ',')
                  : null;

                return (
                  <article className="cartaz-card sk-lib-card" key={e.path}>
                    {/* Miniatura A5 Proporcional */}
                    {d ? (
                      <button
                        type="button"
                        className="thumbnail sk-lib-card-thumb"
                        aria-label={'Abrir ' + d.product.name}
                        onClick={() => run(() => open(e.path))}
                        title="Clique para abrir no editor"
                      >
                        <PosterView poster={posterFromDocument(d)} />
                      </button>
                    ) : (
                      <div className="sk-lib-card-thumb-error">
                        <span>Arquivo corrompido ou inacessível</span>
                      </div>
                    )}

                    {/* Detalhes do Cartaz */}
                    <div className="card-info sk-lib-card-body">
                      {/* Badges superiores: Tipo e F7 */}
                      <div className="sk-lib-card-badges">
                        <span className={`sk-lib-type-pill ${isPsd ? 'psd' : 'skcartaz'}`}>
                          {isPsd ? 'PSD' : 'SKCARTAZ'}
                        </span>
                        {d && (
                          <span className={f7 ? 'f7-code sk-lib-f7-pill active' : 'f7-missing sk-lib-f7-pill missing'}>
                            {f7 ? `F7: ${f7}` : 'Sem F7'}
                          </span>
                        )}
                      </div>

                      {/* Título e Complemento */}
                      <strong className="sk-lib-card-title" title={d?.product.name ?? e.name}>
                        {d?.product.name ?? e.name}
                      </strong>
                      <div className="sk-lib-card-complement">
                        {d?.product.complement || '\u00a0'}
                      </div>

                      {/* Preço em destaque */}
                      {d && (
                        <div className="sk-lib-card-price-row">
                          <span className="sk-lib-card-price-symbol">R$</span>
                          <span className="sk-lib-card-price-val">{priceFormatted}</span>
                          <span className="sk-lib-card-price-unit">/ {d.product.unit || 'UN'}</span>
                        </div>
                      )}

                      {/* Metadados: Data e Arquivo */}
                      <div className="sk-lib-card-meta">
                        <small>{e.modifiedAt ? new Date(e.modifiedAt).toLocaleDateString('pt-BR') : ''}</small>
                        <small title={e.path} className="sk-lib-filename">{e.name}</small>
                      </div>

                      {error && <p className="error-text sk-lib-error-text">{error}</p>}

                      {/* Barra de Ações Rápidas */}
                      <div className="sk-lib-card-actions">
                        <button
                          type="button"
                          className="editor-btn primary"
                          style={{ flex: 1, justifyContent: 'center' }}
                          onClick={() => run(() => open(e.path))}
                          title="Abrir no Editor"
                        >
                          Abrir
                        </button>
                        {d && onAddToConductor && (
                          <button
                            type="button"
                            className="editor-btn outline-blue"
                            title="Adicionar à fila do Condutor de Impressão"
                            onClick={() => onAddToConductor(d, e.path)}
                          >
                            + Condutor
                          </button>
                        )}
                        <details className="sk-lib-dropdown-actions">
                          <summary className="editor-btn subtle" title="Mais opções">
                            •••
                          </summary>
                          <div className="file-actions sk-lib-dropdown-menu">
                            <button
                              type="button"
                              className="editor-btn subtle"
                              onClick={() => {
                                setEditing(e);
                                setRenameName(e.name);
                              }}
                            >
                              Renomear
                            </button>
                            <button
                              type="button"
                              className="editor-btn subtle"
                              onClick={() => run(() => handleMove(e))}
                            >
                              Mover para…
                            </button>
                            {d && (
                              <button
                                type="button"
                                className="editor-btn subtle"
                                onClick={() => run(() => handleDuplicate(e))}
                              >
                                Duplicar…
                              </button>
                            )}
                            <button
                              type="button"
                              className="editor-btn subtle danger"
                              onClick={() => setDeleting({ entry: e, isFolder: false })}
                            >
                              Excluir
                            </button>
                          </div>
                        </details>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {/* Modo Lista Detalhada */}
          {rows.length > 0 && view === 'list' && (
            <div className="sk-lib-table-wrap">
              <table className="sk-lib-table" aria-label="Lista de cartazes">
                <thead>
                  <tr>
                    <th style={{ width: 68 }}>Prévia</th>
                    <th>Produto & Detalhe</th>
                    <th style={{ width: 110 }}>Código F7</th>
                    <th style={{ width: 130 }}>Preço / Unidade</th>
                    <th style={{ width: 100 }}>Formato</th>
                    <th style={{ width: 130 }}>Modificado</th>
                    <th style={{ width: 220, textAlign: 'right' }}>Ações Rápidas</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(e => {
                    const d = byPath.get(e.path)?.document;
                    const error = e.error || (!d ? 'Documento inválido ou incompatível.' : undefined);
                    const f7 = getF7(d?.product.productCode);
                    const isPsd = d?.layout.template === 'imported-psd' || e.name.toLowerCase().endsWith('.psd');
                    const priceFormatted = d
                      ? (d.product.priceCents / 100).toFixed(2).replace('.', ',')
                      : '-';

                    return (
                      <tr key={e.path} className="sk-lib-table-row">
                        {/* Miniatura A5 Proporcional */}
                        <td>
                          {d ? (
                            <button
                              type="button"
                              className="sk-lib-table-thumb-btn"
                              aria-label={'Abrir ' + d.product.name}
                              onClick={() => run(() => open(e.path))}
                              title="Clique para abrir"
                            >
                              <div className="sk-lib-table-thumb-inner">
                                <PosterView poster={posterFromDocument(d)} />
                              </div>
                            </button>
                          ) : (
                            <div className="sk-lib-table-thumb-empty">✕</div>
                          )}
                        </td>

                        {/* Nome do Produto & Complemento */}
                        <td>
                          <div className="sk-lib-table-product-name" title={d?.product.name ?? e.name}>
                            {d?.product.name ?? e.name}
                          </div>
                          {d?.product.complement && (
                            <div className="sk-lib-table-product-detail">{d.product.complement}</div>
                          )}
                          <small className="sk-lib-table-file-name" title={e.path}>{e.name}</small>
                          {error && <div className="error-text" style={{ fontSize: 11 }}>{error}</div>}
                        </td>

                        {/* Código F7 */}
                        <td>
                          {d ? (
                            <span className={f7 ? 'f7-code sk-lib-f7-pill active' : 'f7-missing sk-lib-f7-pill missing'}>
                              {f7 ? `F7: ${f7}` : 'Sem F7'}
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>

                        {/* Preço / Unidade */}
                        <td>
                          {d ? (
                            <div className="sk-lib-table-price-val">
                              <strong>R$ {priceFormatted}</strong>
                              <small> / {d.product.unit || 'UN'}</small>
                            </div>
                          ) : (
                            '-'
                          )}
                        </td>

                        {/* Tipo de Formato */}
                        <td>
                          <span className={`sk-lib-type-pill ${isPsd ? 'psd' : 'skcartaz'}`}>
                            {isPsd ? 'PSD' : 'SKCARTAZ'}
                          </span>
                        </td>

                        {/* Data de Modificação */}
                        <td style={{ fontSize: 12, color: '#64748b' }}>
                          {e.modifiedAt ? new Date(e.modifiedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '-'}
                        </td>

                        {/* Botões de Ação */}
                        <td style={{ textAlign: 'right' }}>
                          <div className="sk-lib-table-actions">
                            <button
                              type="button"
                              className="editor-btn primary"
                              style={{ padding: '6px 10px', fontSize: 11.5 }}
                              onClick={() => run(() => open(e.path))}
                              title="Abrir no editor"
                            >
                              Abrir
                            </button>
                            {d && onAddToConductor && (
                              <button
                                type="button"
                                className="editor-btn outline-blue"
                                style={{ padding: '6px 8px', fontSize: 11.5 }}
                                title="Adicionar à fila do Condutor de Impressão"
                                onClick={() => onAddToConductor(d, e.path)}
                              >
                                + Condutor
                              </button>
                            )}
                            <details className="sk-lib-dropdown-actions">
                              <summary className="editor-btn subtle" style={{ padding: '6px 8px', fontSize: 11.5 }}>
                                •••
                              </summary>
                              <div className="file-actions sk-lib-dropdown-menu">
                                <button
                                  type="button"
                                  className="editor-btn subtle"
                                  onClick={() => {
                                    setEditing(e);
                                    setRenameName(e.name);
                                  }}
                                >
                                  Renomear
                                </button>
                                <button
                                  type="button"
                                  className="editor-btn subtle"
                                  onClick={() => run(() => handleMove(e))}
                                >
                                  Mover para…
                                </button>
                                {d && (
                                  <button
                                    type="button"
                                    className="editor-btn subtle"
                                    onClick={() => run(() => handleDuplicate(e))}
                                  >
                                    Duplicar…
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="editor-btn subtle danger"
                                  onClick={() => setDeleting({ entry: e, isFolder: false })}
                                >
                                  Excluir
                                </button>
                              </div>
                            </details>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Modal de Renomear */}
      {editing && (
        <div className="modal-backdrop">
          <form
            className="panel modal sk-lib-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Renomear"
            onSubmit={e => {
              e.preventDefault();
              run(renameEntry);
            }}
          >
            <h2>Renomear {editing.folder ? 'pasta' : 'cartaz'}</h2>
            <p style={{ margin: '4px 0 16px', fontSize: 12.5, color: '#64748b' }}>
              Digite o novo nome para o item no disco.
            </p>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#334155' }}>
              Novo nome
              <input
                autoFocus
                required
                className="editor-input"
                style={{ marginTop: 6 }}
                value={renameName}
                onChange={e => setRenameName(e.target.value)}
              />
            </label>
            <div className="toolbar" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
              <button type="button" className="editor-btn subtle" onClick={() => setEditing(null)}>
                Cancelar
              </button>
              <button type="submit" className="editor-btn primary">
                Salvar Nome
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal de Confirmação de Exclusão */}
      {deleting && (
        <div className="modal-backdrop">
          <div
            className="panel modal sk-lib-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Confirmar exclusão"
          >
            <h2 style={{ color: '#dc2626' }}>
              Excluir {deleting.isFolder ? 'Pasta' : 'Cartaz'} Definitivamente?
            </h2>
            <p style={{ margin: '10px 0 16px', fontSize: 13, lineHeight: 1.5, color: '#334155' }}>
              Tem certeza de que deseja excluir permanentemente{' '}
              <strong>"{deleting.entry.name}"</strong>?
              <br />
              <span style={{ fontSize: 12, color: '#64748b' }}>
                Esta ação removerá o arquivo diretamente do seu computador e não poderá ser desfeita.
              </span>
            </p>
            <div className="toolbar" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="editor-btn subtle"
                onClick={() => setDeleting(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="editor-btn subtle danger"
                style={{ background: '#dc2626', color: '#ffffff', borderColor: '#b91c1c' }}
                onClick={() => run(confirmDelete)}
              >
                Excluir Definitivamente
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Importação PSD */}
      {importingPsd && (
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
            close={() => setImportingPsd(false)}
            saved={async path => {
              await refresh();
              await open(path);
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
