import React, { useState, useRef, useMemo, useEffect } from 'react';
import type { Cartaz, PosterTemplateModel } from '../../features/cartazes/types';
import type { PosterFormatConfig } from '../../features/formatos/types';
import { formatCentsBr, posterFromDocument } from '../../features/cartazes/presentation';
import { priceToCents } from '../../features/cartazes/validation';
import { PosterView, type Poster } from './PosterView';
import './SurgicalLayerEditor.css';

type Props = {
  document: Cartaz;
  price?: string;
  activeFormat: PosterFormatConfig;
  onChangeField: (key: string, value: unknown) => void;
  onExportPsd: (openPhotoshop?: boolean) => Promise<void>;
  onSwitchModel?: (targetModel: PosterTemplateModel) => Promise<boolean>;
  onClose: () => void;
  isBusy?: boolean;
};

export function SurgicalLayerEditor({
  document,
  price,
  activeFormat,
  onChangeField,
  onExportPsd,
  onSwitchModel,
  onClose,
  isBusy = false,
}: Props) {
  const [zoom, setZoom] = useState(78);
  const [showGuides, setShowGuides] = useState(true);
  const [boxPriceDraft, setBoxPriceDraft] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const product = document.product;
  const artwork = document.layout.template === 'imported-psd' ? document.layout.artwork : undefined;
  const canvasW = artwork?.canvas?.width ?? 1080;
  const canvasH = artwork?.canvas?.height ?? 1350;

  const effectivePrice = price ?? formatCentsBr(product.priceCents);
  const effectiveUnitCents = useMemo(() => {
    try {
      return priceToCents(effectivePrice);
    } catch {
      return product.priceCents;
    }
  }, [effectivePrice, product.priceCents]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isBusy, onClose]);

  const basePoster = useMemo(() => posterFromDocument(document, effectivePrice), [document, effectivePrice]);
  const poster: Poster = useMemo(() => ({
    ...basePoster,
    showSurgicalGuides: showGuides,
  }), [basePoster, showGuides]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onChangeField('productImage', {
          dataUrl: reader.result,
          fileName: file.name,
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleRemoveImage = () => {
    onChangeField('productImage', undefined);
  };

  const boxQuantity = Number(product.boxQuantity) || 12;
  const boxPriceDisplay =
    boxPriceDraft !== null
      ? boxPriceDraft
      : product.boxPriceCents
        ? formatCentsBr(product.boxPriceCents)
        : formatCentsBr(effectiveUnitCents * boxQuantity);

  return (
    <div className="sk-surgical-container" role="dialog" aria-label="Editor Cirúrgico de Camadas">
      {/* 1. Barra de Topo */}
      <header className="sk-surgical-topbar">
        <div className="sk-surgical-topbar-left">
          <span className="sk-surgical-breadcrumb">
            Editor / <strong>{product.name || 'Cartaz PSD'}</strong>
          </span>
          <span className="sk-surgical-meta-sep" aria-hidden="true">·</span>
          <span className="sk-surgical-meta-text">
            {canvasW}×{canvasH}px
          </span>
        </div>

        <div className="sk-surgical-guide-legend" title="Indicação visual de camadas editáveis vs travadas">
          <span className="green-text">Editáveis</span>
          <span aria-hidden="true">·</span>
          <span className="red-text">Travadas</span>
        </div>

        <div className="sk-surgical-topbar-right">
          <div className="sk-surgical-zoom-controls">
            <button
              type="button"
              className="sk-surgical-zoom-btn"
              onClick={() => setZoom(z => Math.max(40, z - 10))}
              title="Reduzir Zoom"
            >
              −
            </button>
            <span className="sk-surgical-zoom-val">{zoom}%</span>
            <button
              type="button"
              className="sk-surgical-zoom-btn"
              onClick={() => setZoom(z => Math.min(150, z + 10))}
              title="Aumentar Zoom"
            >
              +
            </button>
          </div>

          <button
            type="button"
            className="sk-surgical-btn-close"
            disabled={isBusy}
            onClick={onClose}
            title="Voltar ao Editor Principal (Esc)"
          >
            ✕ Voltar ao Editor
          </button>
        </div>
      </header>

      {/* 2. Workspace Principal */}
      <div className="sk-surgical-workspace">
        {/* Viewport Central com Zoom */}
        <div className="sk-surgical-viewport">
          <div
            className="sk-surgical-canvas-wrap"
            style={{
              transform: `scale(${zoom / 100})`,
              transformOrigin: 'center center',
            }}
          >
            <PosterView poster={poster} formatConfig={activeFormat} />
          </div>
        </div>

        {/* Painel Lateral Cirúrgico */}
        <aside className="sk-surgical-sidebar">
          <div className="sk-surgical-sidebar-header">
            <h2 className="sk-surgical-sidebar-title">Padronização de Arte</h2>
            <p className="sk-surgical-sidebar-subtitle">Editor de Camadas Cirúrgicas</p>
          </div>

          {/* Card 1: Fundo / Marca Travada */}
          <div className="sk-surgical-card locked">
            <div className="sk-surgical-card-head">
              <span className="sk-surgical-card-title">
                🔒 LOCK_Fundo_Marca — Bloqueado
              </span>
              <span title="Camada protegida contra edições acidentais">🔒</span>
            </div>
            <p className="sk-surgical-card-desc">
              Identidade visual fixa. Não editável pelo operador.
            </p>
          </div>

          {/* Card 2: Foto do Produto (Máscara Fixa) */}
          <div className="sk-surgical-card editable">
            <div className="sk-surgical-card-head">
              <span className="sk-surgical-card-title">
                ✏️ EDIT_Foto_Produto — Máscara Fixa
              </span>
            </div>
            <p className="sk-surgical-card-desc">
              Substituir Imagem (Auto-Fit na grade):
            </p>
            <div className="sk-surgical-photo-row">
              {product.productImage?.dataUrl ? (
                <img
                  src={product.productImage.dataUrl}
                  alt="Packshot do produto"
                  className="sk-surgical-photo-thumb"
                />
              ) : (
                <div className="sk-surgical-photo-placeholder" title="Sem imagem específica">
                  🖼️
                </div>
              )}
              <div className="sk-surgical-photo-meta">
                <div className="sk-surgical-photo-name" title={product.productImage?.fileName || 'Arte original do PSD'}>
                  {product.productImage?.fileName || 'Arte original do PSD'}
                </div>
                <div className="sk-surgical-photo-hint">PNG transparente recomendado</div>
              </div>
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: 'none' }}
                accept="image/png,image/jpeg,image/webp"
                onChange={handleImageSelect}
              />
              <button
                type="button"
                className="sk-surgical-btn-alter"
                onClick={() => fileInputRef.current?.click()}
              >
                Alterar
              </button>
              {product.productImage && (
                <button
                  type="button"
                  className="sk-surgical-btn-alter"
                  style={{ background: '#7f1d1d', borderColor: '#991b1b' }}
                  onClick={handleRemoveImage}
                  title="Remover imagem substituída"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Card 3: Título do Produto */}
          <div className="sk-surgical-card editable">
            <div className="sk-surgical-card-head">
              <span className="sk-surgical-card-title">
                ✏️ EDIT_Titulo_Produto — Texto PSD
              </span>
            </div>
            <div className="sk-surgical-input-wrap">
              <input
                type="text"
                className="sk-surgical-input"
                value={product.name || ''}
                maxLength={100}
                onChange={e => onChangeField('name', e.target.value.toUpperCase())}
                placeholder="Ex: OFERTA ESPECIAL DA SEMANA"
              />
              <span className="sk-surgical-char-counter">
                ({(product.name || '').length}/100)
              </span>
            </div>

            {/* Complemento / Detalhe */}
            <div className="sk-surgical-input-wrap" style={{ marginTop: 6 }}>
              <input
                type="text"
                className="sk-surgical-input"
                value={product.complement || ''}
                maxLength={100}
                onChange={e => onChangeField('complement', e.target.value.toUpperCase())}
                placeholder="Complemento / Sabor / Marca (Opcional)"
              />
              <span className="sk-surgical-char-counter">
                ({(product.complement || '').length}/100)
              </span>
            </div>
          </div>

          {/* Card 4: Preço do Produto */}
          <div className="sk-surgical-card editable">
            <div className="sk-surgical-card-head">
              <span className="sk-surgical-card-title">
                ✏️ EDIT_Preco — Texto PSD
              </span>
            </div>
            <div className="sk-surgical-price-row">
              <div className="sk-surgical-input-wrap">
                <input
                  type="text"
                  inputMode="decimal"
                  className="sk-surgical-input"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                  value={effectivePrice}
                  onChange={e => {
                    onChangeField('price', e.target.value);
                  }}
                  placeholder="0,00"
                />
                <span className="sk-surgical-char-counter">R$</span>
              </div>

              <select
                className="sk-surgical-select"
                value={product.unit || 'UN'}
                onChange={e => onChangeField('unit', e.target.value)}
              >
                {Array.from(new Set(['UN', 'KG', 'LT', 'L', 'PCT', 'CX', product.unit || 'UN'])).map(unit => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Card 5: Validade (modo Vencimento) ou Caixa Fechada (Oferta / Caixa) */}
          {artwork?.posterModel === 'vencimento' ? (
            <div className="sk-surgical-card editable">
              <div className="sk-surgical-card-head">
                <span className="sk-surgical-card-title">
                  Validade — Próximo ao Vencimento
                </span>
              </div>
              <input
                type="text"
                className="sk-surgical-input"
                style={{ fontVariantNumeric: 'tabular-nums' }}
                value={product.validityText || ''}
                onChange={e => onChangeField('validityText', e.target.value)}
                placeholder="Ex: 02/12 ou 28/10"
              />
              <div className="sk-surgical-meta" style={{ marginTop: 8 }}>
                <span>Rodapé oficial</span>
                <span>·</span>
                <span>Item próximo ao vencimento · Não efetuamos a troca</span>
              </div>
            </div>
          ) : (
          <div className="sk-surgical-card editable">
            <div className="sk-surgical-card-head">
              <span className="sk-surgical-card-title">
                📦 EDIT_Caixa_Atacado — Formato Caixa
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer', color: '#cbd5e1' }}>
                <input
                  type="checkbox"
                  checked={Boolean(product.hasBoxPrice)}
                  onChange={async e => {
                    const checked = e.target.checked;
                    onChangeField('hasBoxPrice', checked);
                    if (checked && !product.boxPriceCents) {
                      setBoxPriceDraft(null);
                      onChangeField('boxPriceCents', effectiveUnitCents * boxQuantity);
                    }
                    if (onSwitchModel) {
                      await onSwitchModel(checked ? 'caixa' : 'oferta');
                    }
                  }}
                />
                Ativar Formato Caixa
              </label>
            </div>

            {Boolean(product.hasBoxPrice) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>Tipo:</span>
                  <label style={{ fontSize: 11, color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="boxPackageType"
                      checked={product.boxPackageType !== 'fardo'}
                      onChange={() => onChangeField('boxPackageType', 'caixa')}
                    />
                    Caixa
                  </label>
                  <label style={{ fontSize: 11, color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="boxPackageType"
                      checked={product.boxPackageType === 'fardo'}
                      onChange={() => onChangeField('boxPackageType', 'fardo')}
                    />
                    Fardo
                  </label>
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>Selo Unitário:</span>
                  <select
                    className="sk-surgical-input"
                    style={{ padding: '4px 8px', fontSize: 11 }}
                    value={product.unitBadgeMode || 'auto'}
                    onChange={e => onChangeField('unitBadgeMode', e.target.value)}
                  >
                    <option value="auto">Automático (UN quando houver gramagem no topo)</option>
                    <option value="un">Forçar Selo (UN) Oval</option>
                    <option value="text">Forçar Gramagem / Texto (ex: 500G, UN)</option>
                  </select>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '80px 80px 1fr', gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 10, color: '#94a3b8', display: 'block', marginBottom: 2 }}>Quantidade</label>
                    <input
                      type="number"
                      className="sk-surgical-input"
                      style={{ padding: '8px', fontVariantNumeric: 'tabular-nums' }}
                      value={boxQuantity}
                      min={1}
                      onChange={e => {
                        const q = Math.max(1, parseInt(e.target.value, 10) || 1);
                        setBoxPriceDraft(null);
                        onChangeField('boxQuantity', q);
                        onChangeField('boxPriceCents', effectiveUnitCents * q);
                      }}
                      placeholder="Qtd"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#94a3b8', display: 'block', marginBottom: 2 }}>Embalagem</label>
                    <input
                      type="text"
                      className="sk-surgical-input"
                      style={{ padding: '8px' }}
                      value={product.boxUnitLabel || 'UND.'}
                      onChange={e => onChangeField('boxUnitLabel', e.target.value.toUpperCase())}
                      placeholder="UND."
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: '#94a3b8', display: 'block', marginBottom: 2 }}>Preço da Caixa (R$)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      className="sk-surgical-input"
                      style={{ padding: '8px', fontVariantNumeric: 'tabular-nums' }}
                      value={boxPriceDisplay}
                      onChange={e => {
                        const val = e.target.value;
                        setBoxPriceDraft(val);
                        try {
                          onChangeField('boxPriceCents', priceToCents(val));
                        } catch {
                          // Aguarda digitação completa
                        }
                      }}
                      onBlur={() => setBoxPriceDraft(null)}
                      placeholder="Total Caixa"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  style={{
                    background: '#1e293b',
                    border: '1px solid #334155',
                    color: '#cbd5e1',
                    fontSize: 11,
                    padding: '5px 10px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    alignSelf: 'flex-start',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                  onClick={() => {
                    setBoxPriceDraft(null);
                    onChangeField('boxPriceCents', effectiveUnitCents * boxQuantity);
                  }}
                  title="Recalcula Preço da Caixa = Preço Unitário × Quantidade"
                >
                  Recalcular Automático (R$ {formatCentsBr(effectiveUnitCents * boxQuantity)})
                </button>
              </div>
            )}
          </div>
          )}

          {/* Rodapé de Ações Cirúrgicas */}
          <footer className="sk-surgical-footer">
            <label className="sk-surgical-checkbox-row">
              <input
                type="checkbox"
                checked={showGuides}
                onChange={e => setShowGuides(e.target.checked)}
              />
              <span>Mostrar guias de corte cirúrgico</span>
            </label>

            <button
              type="button"
              className="sk-surgical-btn-export"
              disabled={isBusy}
              onClick={() => onExportPsd(false)}
            >
              📥 Exportar para Photoshop (.PSD)
            </button>

            <button
              type="button"
              className="sk-surgical-btn-ps"
              disabled={isBusy}
              onClick={() => onExportPsd(true)}
              title="Exporta o arquivo PSD e abre automaticamente no Photoshop"
            >
              👁️ Abrir no Photoshop
            </button>
          </footer>
        </aside>
      </div>
    </div>
  );
}
