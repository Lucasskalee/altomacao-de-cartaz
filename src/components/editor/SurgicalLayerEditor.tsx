import React, { useState, useRef, useMemo } from 'react';
import type { Cartaz } from '../../features/cartazes/types';
import type { PosterFormatConfig } from '../../features/formatos/types';
import { posterFromDocument } from '../../features/cartazes/presentation';
import { PosterView, type Poster } from './PosterView';
import './SurgicalLayerEditor.css';

type Props = {
  document: Cartaz;
  activeFormat: PosterFormatConfig;
  onChangeField: (key: string, value: any) => void;
  onExportPsd: (openPhotoshop?: boolean) => Promise<void>;
  onClose: () => void;
  isBusy?: boolean;
};

export function SurgicalLayerEditor({
  document,
  activeFormat,
  onChangeField,
  onExportPsd,
  onClose,
  isBusy = false,
}: Props) {
  const [zoom, setZoom] = useState(78);
  const [showGuides, setShowGuides] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const product = document.product as any;
  const artwork = document.layout.template === 'imported-psd' ? document.layout.artwork : undefined;
  const canvasW = artwork?.canvas?.width ?? 1080;
  const canvasH = artwork?.canvas?.height ?? 1350;

  const basePoster = useMemo(() => posterFromDocument(document), [document]);
  const poster: Poster = useMemo(() => ({
    ...basePoster,
    showSurgicalGuides: showGuides,
    productImage: product.productImage,
    hasBoxPrice: Boolean(product.hasBoxPrice),
    boxQuantity: Number(product.boxQuantity) || 12,
    boxUnitLabel: product.boxUnitLabel || 'UND.',
    boxPrice: product.hasBoxPrice && product.boxPriceCents
      ? (product.boxPriceCents / 100).toFixed(2).replace('.', ',')
      : undefined,
  }), [basePoster, showGuides, product.productImage, product.hasBoxPrice, product.boxQuantity, product.boxUnitLabel, product.boxPriceCents]);

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

  const priceValue = (product.priceCents / 100).toFixed(2).replace('.', ',');

  return (
    <div className="sk-surgical-container" role="dialog" aria-label="Editor Cirúrgico de Camadas">
      {/* 1. Barra de Topo */}
      <header className="sk-surgical-topbar">
        <div className="sk-surgical-topbar-left">
          <span className="sk-surgical-breadcrumb">
            Projetos / <strong>{product.name || 'Encarte_Semanal_Modelo_PSD'}</strong>
          </span>
          <span className="sk-surgical-badge-local">Salvo no Computador (PSD)</span>
        </div>

        <div className="sk-surgical-guide-pill" title="Indicação visual de camadas editáveis vs travadas">
          <span>📐 Padrão: {canvasW}x{canvasH}px</span>
          <span>|</span>
          <span className="green-text">Zonas Verdes = Editáveis</span>
          <span>|</span>
          <span className="red-text">Vermelhas = Travadas</span>
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
            onClick={onClose}
            title="Voltar ao Editor Convencional"
          >
            ✕ Fechar
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
                maxLength={32}
                onChange={e => onChangeField('name', e.target.value.toUpperCase())}
                placeholder="Ex: OFERTA ESPECIAL DA SEMANA"
              />
              <span className="sk-surgical-char-counter">
                ({(product.name || '').length}/32)
              </span>
            </div>

            {/* Complemento / Detalhe */}
            <div className="sk-surgical-input-wrap" style={{ marginTop: 6 }}>
              <input
                type="text"
                className="sk-surgical-input"
                value={product.complement || ''}
                maxLength={28}
                onChange={e => onChangeField('complement', e.target.value.toUpperCase())}
                placeholder="Complemento / Sabor / Marca (Opcional)"
              />
              <span className="sk-surgical-char-counter">
                ({(product.complement || '').length}/28)
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
                  className="sk-surgical-input"
                  value={priceValue}
                  onChange={e => {
                    const raw = e.target.value.replace(/[^\d,]/g, '');
                    const [w = '0', f = '00'] = raw.split(',');
                    const cents = (parseInt(w, 10) || 0) * 100 + (parseInt(f.padEnd(2, '0').slice(0, 2), 10) || 0);
                    onChangeField('priceCents', cents);
                  }}
                  placeholder="0,00"
                />
                <span className="sk-surgical-char-counter">2/$</span>
              </div>

              <select
                className="sk-surgical-select"
                value={product.unit || 'UN'}
                onChange={e => onChangeField('unit', e.target.value)}
              >
                <option value="UN">UN</option>
                <option value="KG">KG</option>
                <option value="L">L</option>
                <option value="PCT">PCT</option>
                <option value="CX">CX</option>
              </select>
            </div>
          </div>

          {/* Card 5: Caixa Fechada (Atacado) se ativo */}
          <div className="sk-surgical-card editable">
            <div className="sk-surgical-card-head">
              <span className="sk-surgical-card-title">
                ✏️ EDIT_Caixa_Atacado — Texto PSD
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer', color: '#cbd5e1' }}>
                <input
                  type="checkbox"
                  checked={Boolean(product.hasBoxPrice)}
                  onChange={e => onChangeField('hasBoxPrice', e.target.checked)}
                />
                Ativar
              </label>
            </div>

            {Boolean(product.hasBoxPrice) && (
              <div style={{ display: 'grid', gridTemplateColumns: '80px 80px 1fr', gap: 8, marginTop: 4 }}>
                <input
                  type="number"
                  className="sk-surgical-input"
                  style={{ padding: '8px' }}
                  value={product.boxQuantity || 12}
                  min={1}
                  onChange={e => onChangeField('boxQuantity', parseInt(e.target.value, 10) || 1)}
                  placeholder="Qtd"
                />
                <input
                  type="text"
                  className="sk-surgical-input"
                  style={{ padding: '8px' }}
                  value={product.boxUnitLabel || 'UND.'}
                  onChange={e => onChangeField('boxUnitLabel', e.target.value.toUpperCase())}
                  placeholder="UND."
                />
                <input
                  type="text"
                  className="sk-surgical-input"
                  style={{ padding: '8px' }}
                  value={product.boxPriceCents ? (product.boxPriceCents / 100).toFixed(2).replace('.', ',') : ''}
                  onChange={e => {
                    const raw = e.target.value.replace(/[^\d,]/g, '');
                    const [w = '0', f = '00'] = raw.split(',');
                    const cents = (parseInt(w, 10) || 0) * 100 + (parseInt(f.padEnd(2, '0').slice(0, 2), 10) || 0);
                    onChangeField('boxPriceCents', cents);
                  }}
                  placeholder="Total Caixa"
                />
              </div>
            )}
          </div>

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
