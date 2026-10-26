import { useMemo, useRef, useState } from 'react';
import { analyzePsd, buildArtwork, extractPriceFromRoles, type PsdAnalysis, type PsdRoleMap } from '../../features/psd/importer';
import { selectPsd } from '../../features/psd/service';
import { createDocument } from '../../features/cartazes/serialization';
import { chooseSave, saveDocument } from '../../features/cartazes/storage';
import { digitsOnly } from '../../features/cartazes/f7';
import { fileName, priceToCents } from '../../features/cartazes/validation';
import { PosterView } from '../editor/PosterView';
import { importedPriceWarning } from '../editor/importedRenderer';
import type { Cartaz, ImportedPriceRole } from '../../features/cartazes/types';
import type { PsdImportOfferContext } from '../../features/ofertas/types';
import { suggestFromExcelDescription } from '../../features/ofertas/service';

type Props = {
  close: () => void;
  saved: (path: string, document: Cartaz) => Promise<void>;
  offerContext?: PsdImportOfferContext | null;
};

const roleLabels: Record<ImportedPriceRole, string> = {
  whole: 'Reais',
  fraction: 'Centavos',
  decimal: 'Vírgula',
  fractionRule: 'Linha dos centavos',
};

const centsToBr = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

export function PsdImport({ close, saved, offerContext = null }: Props) {
  const excelSuggestion = useMemo(
    () => (offerContext ? suggestFromExcelDescription(offerContext.description) : null),
    [offerContext]
  );

  const [analysis, setAnalysis] = useState<PsdAnalysis | null>(null);
  const [roles, setRoles] = useState<PsdRoleMap>({});
  const [name, setName] = useState(excelSuggestion?.name ?? '');
  const [complement, setComplement] = useState(excelSuggestion?.complement ?? '');
  const [unit, setUnit] = useState(excelSuggestion?.unit ?? '');
  const [f7, setF7] = useState(offerContext ? offerContext.productCode : '');
  const [price, setPrice] = useState(offerContext ? centsToBr(offerContext.futurePriceCents) : '');
  const [psdBasePrice, setPsdBasePrice] = useState('');
  const [confirmF7Override, setConfirmF7Override] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);

  const artwork = useMemo(() => {
    if (!analysis) return null;
    try {
      return buildArtwork(analysis, roles);
    } catch {
      return null;
    }
  }, [analysis, roles]);

  const validPrice = useMemo(() => {
    try {
      priceToCents(price);
      return true;
    } catch {
      return false;
    }
  }, [price]);

  const priceWarning = artwork && validPrice ? importedPriceWarning(artwork, price) : '';

  const f7Missing = !f7.trim();
  const f7Divergent = Boolean(offerContext && f7.trim() && f7.trim() !== offerContext.productCode);
  const requiresF7Confirmation = f7Missing || f7Divergent;

  const select = async () => {
    setBusy(true);
    setError('');
    try {
      const selected = await selectPsd();
      if (!selected) return;
      const result = await analyzePsd(selected.buffer, selected.name);
      setAnalysis(result);
      setRoles(result.suggested);
      // Preserva textos artísticos reais do PSD; usa descrição do Excel apenas como fallback se o PSD não tiver camada reconhecida
      setName(result.metadata.name || excelSuggestion?.name || '');
      setComplement(
        result.metadata.name
          ? result.metadata.complement
          : excelSuggestion?.complement || result.metadata.complement || ''
      );
      setUnit(result.metadata.unit || excelSuggestion?.unit || '');
      setPsdBasePrice(result.metadata.price);
      if (offerContext) {
        setF7(offerContext.productCode);
        setPrice(centsToBr(offerContext.futurePriceCents));
      } else {
        setPrice(result.metadata.price);
      }
      setConfirmF7Override(false);
    } catch (ex) {
      setError(String(ex));
      setAnalysis(null);
    } finally {
      setBusy(false);
    }
  };

  const applyExcelSuggestion = () => {
    if (!excelSuggestion) return;
    setName(excelSuggestion.name);
    setComplement(excelSuggestion.complement);
    setUnit(excelSuggestion.unit);
  };

  const save = async () => {
    if (savingRef.current) return;
    if (!analysis || !artwork) throw new Error('Conclua o mapeamento das camadas do preço.');
    if (artwork.compatibility !== 'ready')
      throw new Error('A arte requer preparação e não pode ser salva como editável.');
    if (!price.trim()) throw new Error('Informe ou confirme o preço do cartaz.');
    if (priceWarning) throw new Error(priceWarning);
    if (f7Missing && !confirmF7Override) {
      throw new Error('O código F7 está em branco. Informe o F7 ou confirme manualmente que deseja salvar sem F7.');
    }
    if (f7Divergent && !confirmF7Override) {
      throw new Error(
        `O código F7 informado (${f7}) difere do F7 da oferta (${offerContext?.productCode}). Corrija o F7 ou confirme manualmente a divergência antes de salvar.`
      );
    }

    savingRef.current = true;
    try {
      const document = createDocument();
      const now = new Date().toISOString();
      // Preserva a separação entre Preço base da biblioteca (extraído da arte PSD quando existente) e Preço futuro da oferta
      let libraryPriceCents = priceToCents(price);
      if (offerContext && psdBasePrice.trim()) {
        try {
          libraryPriceCents = priceToCents(psdBasePrice);
        } catch {
          libraryPriceCents = priceToCents(price);
        }
      }
      document.product = {
        ...document.product,
        name: name.trim().toUpperCase(),
        complement: complement.trim().toUpperCase(),
        unit: unit.trim().toUpperCase(),
        productCode: f7.trim() || null,
        priceCents: libraryPriceCents,
      };
      document.layout = { template: 'imported-psd', paper: 'A5', orientation: 'portrait', artwork };
      document.metadata = { ...document.metadata, createdAt: now, updatedAt: now };

      const path = await chooseSave(fileName(`${name}-${complement}`));
      if (!path) return;
      await saveDocument(path, document);
      await saved(path, document);
      close();
    } finally {
      savingRef.current = false;
    }
  };

  const setRole = (role: ImportedPriceRole, id: string) => {
    setRoles(previous => {
      const next = { ...previous, [role]: id || undefined };
      if (analysis && (role === 'whole' || role === 'fraction')) {
        const extracted = extractPriceFromRoles(analysis.layers, next);
        if (extracted) {
          setPsdBasePrice(extracted);
          if (!offerContext) setPrice(extracted);
        }
      }
      return next;
    });
  };

  return (
    <div className="modal-backdrop psd-backdrop">
      <section className="panel psd-import" role="dialog" aria-modal="true" aria-labelledby="psd-title">
        <div className="psd-title">
          <div>
            <h2 id="psd-title">
              {offerContext ? 'Importar arte PSD para Pasta de Ofertas' : 'Importar arte PSD'}
            </h2>
            <p>O arquivo original será apenas lido. A arte salva ficará independente dele.</p>
          </div>
          <button className="subtle" disabled={busy} onClick={close}>
            Fechar
          </button>
        </div>

        {offerContext && (
          <div className="import-warning" role="region" aria-label="Contexto da oferta programada">
            <strong>Vinculando ao item da oferta:</strong> F7 <code>{offerContext.productCode}</code> ·{' '}
            <strong>{offerContext.description}</strong> · Preço programado na campanha:{' '}
            <strong>R$ {centsToBr(offerContext.futurePriceCents)}</strong>
            {psdBasePrice && (
              <span>
                {' '}
                · Preço base original no PSD: <strong>R$ {psdBasePrice}</strong> (mantido como preço base na biblioteca)
              </span>
            )}
            <div style={{ marginTop: 6, fontSize: 12 }}>
              Sugestão do Excel: <strong>{excelSuggestion?.name}</strong>{' '}
              {excelSuggestion?.complement ? `(${excelSuggestion.complement})` : ''} · {excelSuggestion?.unit}{' '}
              <button
                type="button"
                className="subtle"
                style={{ padding: '3px 8px', fontSize: 11, marginLeft: 8 }}
                onClick={applyExcelSuggestion}
              >
                Usar descrição do Excel nos metadados
              </button>
            </div>
          </div>
        )}

        {!analysis ? (
          <div className="psd-empty">
            <button disabled={busy} onClick={() => void select()}>
              {busy ? 'Analisando…' : 'Selecionar arquivo PSD'}
            </button>
            <p>Piloto: um arquivo RGB, 8 bits, até 25 MB e 300 camadas.</p>
          </div>
        ) : (
          <>
            <div className="psd-summary">
              <div>
                <strong>{analysis.fileName}</strong>
                <small>
                  {analysis.width} × {analysis.height}px · {analysis.resolutionPpi} PPI · {analysis.layers.length} camadas
                </small>
                <small>SHA-256: {analysis.hash}</small>
              </div>
              <button className="subtle" disabled={busy} onClick={() => void select()}>
                Escolher outro
              </button>
            </div>

            {(artwork?.warnings ?? analysis.warnings).map(warning => (
              <p className="import-warning" key={warning}>
                {warning}
              </p>
            ))}

            <div className="psd-workspace">
              <div>
                <h3>Composição original {psdBasePrice ? `(PSD: R$ ${psdBasePrice})` : ''}</h3>
                <img
                  className="psd-original"
                  src={analysis.originalPreview}
                  alt="Prévia original incorporada ao PSD"
                />
              </div>
              <div>
                <h3>{offerContext ? `Prévia da oferta (R$ ${price})` : 'Teste do preço'}</h3>
                {artwork && validPrice ? (
                  <PosterView poster={{ name, detail: complement, unit, price, artwork }} />
                ) : (
                  <p className="empty">
                    Mapeie reais e centavos e informe um preço válido para gerar a prévia editável.
                  </p>
                )}
                {artwork && (
                  <p className={artwork.compatibility === 'ready' ? 'success' : 'error-text'}>
                    {artwork.compatibility === 'ready'
                      ? 'Compatível com edição de preço'
                      : 'Requer preparação antes de salvar'}
                  </p>
                )}
                {priceWarning && (
                  <p className="error-text" role="alert">
                    {priceWarning}
                  </p>
                )}
              </div>
            </div>

            <fieldset className="psd-fields">
              <legend>Dados do cartaz</legend>
              <label>
                Nome
                <input
                  maxLength={32}
                  placeholder="Extraído das camadas ou informe…"
                  value={name}
                  onChange={event => setName(event.target.value.toUpperCase())}
                />
              </label>
              <label>
                Complemento
                <input
                  maxLength={28}
                  placeholder="Opcional"
                  value={complement}
                  onChange={event => setComplement(event.target.value.toUpperCase())}
                />
              </label>
              <label>
                {offerContext ? 'Preço programado na prévia (R$)' : 'Preço de teste'}
                <input
                  inputMode="decimal"
                  placeholder="Ex.: 2,99"
                  value={price}
                  onChange={event => setPrice(event.target.value)}
                />
              </label>
              <label>
                Unidade
                <input
                  maxLength={12}
                  placeholder="Ex.: KG, UN"
                  value={unit}
                  onChange={event => setUnit(event.target.value.toUpperCase())}
                />
              </label>
              <label>
                Código F7
                <input
                  inputMode="numeric"
                  value={f7}
                  onChange={event => {
                    setF7(digitsOnly(event.target.value));
                    setConfirmF7Override(false);
                  }}
                />
              </label>
            </fieldset>

            {requiresF7Confirmation && (
              <div className="import-warning" role="alert">
                {f7Missing ? (
                  <p style={{ margin: '0 0 8px' }}>
                    <strong>Atenção:</strong> O campo Código F7 está vazio. Sem F7 o cartaz não será localizado automaticamente por código.
                  </p>
                ) : (
                  <p style={{ margin: '0 0 8px' }}>
                    <strong>Atenção (F7 divergente):</strong> O F7 informado (<code>{f7}</code>) é diferente do F7 do produto na oferta (<code>{offerContext?.productCode}</code>).
                  </p>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={confirmF7Override}
                    onChange={e => setConfirmF7Override(e.target.checked)}
                  />
                  Confirmo manualmente que desejo salvar este cartaz {f7Missing ? 'sem código F7' : `com o F7 ${f7}`}.
                </label>
              </div>
            )}

            <h3>Mapeamento do preço</h3>
            <div className="psd-role-grid">
              {(Object.keys(roleLabels) as ImportedPriceRole[]).map(role => (
                <label key={role}>
                  {roleLabels[role]}
                  <select value={roles[role] ?? ''} onChange={event => setRole(role, event.target.value)}>
                    <option value="">Não mapeada</option>
                    {analysis.layers
                      .filter(layer => layer.visible && layer.type !== 'group' && layer.type !== 'empty')
                      .map(layer => (
                        <option value={layer.id} key={layer.id}>
                          {layer.name}
                          {layer.text ? ` — “${layer.text}”` : ''}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
            </div>

            <details className="psd-layers">
              <summary>Camadas detectadas ({analysis.layers.length})</summary>
              <div className="psd-layer-list">
                {analysis.layers.map(layer => (
                  <div key={layer.id} style={{ paddingLeft: layer.depth * 16 }}>
                    <strong>
                      {layer.visible ? '●' : '○'} {layer.name}
                    </strong>
                    <span>
                      {layer.type}
                      {layer.text ? ` · “${layer.text}”` : ''}
                      {layer.font ? ` · ${layer.font}` : ''} · {layer.bounds.left},{layer.bounds.top}–
                      {layer.bounds.right},{layer.bounds.bottom}
                    </span>
                  </div>
                ))}
              </div>
            </details>

            <div className="toolbar">
              <button
                disabled={
                  busy ||
                  !artwork ||
                  artwork.compatibility !== 'ready' ||
                  !validPrice ||
                  Boolean(priceWarning) ||
                  !name.trim() ||
                  !unit.trim()
                }
                onClick={() => {
                  setBusy(true);
                  setError('');
                  void save()
                    .catch(ex => setError(String(ex)))
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? 'Salvando…' : 'Salvar cartaz importado'}
              </button>
              <button className="subtle" disabled={busy} onClick={close}>
                Cancelar
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
