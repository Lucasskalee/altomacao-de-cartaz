import { useMemo, useState } from 'react';
import type { Cartaz, ImportedTextRole } from '../../features/cartazes/types';
import { posterFromDocument } from '../../features/cartazes/presentation';
import { prepareLinkedArtwork, type EditablePsdTexts } from '../../features/psd/editLinkedArtwork';
import { analyzePsd, type PsdAnalysis, type PsdTemplateRoleMap } from '../../features/psd/importer';
import { selectPsd } from '../../features/psd/service';
import { PosterView } from '../editor/PosterView';

const textRoles: { role: ImportedTextRole; label: string; maxLength: number }[] = [
  { role: 'category', label: 'Categoria', maxLength: 32 },
  { role: 'title', label: 'Nome / marca', maxLength: 32 },
  { role: 'complement', label: 'Complemento / sabor', maxLength: 28 },
  { role: 'packaging', label: 'Embalagem', maxLength: 12 },
];

type Props = {
  document: Cartaz;
  scheduledPriceCents: number;
  close: () => void;
  save: (document: Cartaz) => Promise<void>;
};

export function EditLinkedPsd({ document, scheduledPriceCents, close, save }: Props) {
  const [analysis, setAnalysis] = useState<PsdAnalysis | null>(null);
  const [roles, setRoles] = useState<PsdTemplateRoleMap>({});
  const [texts, setTexts] = useState<EditablePsdTexts>({ category: '', title: '', complement: '', packaging: '' });
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const preview = useMemo(() => {
    if (!analysis) return null;
    try {
      return { document: prepareLinkedArtwork(document, analysis, roles, texts), error: '' };
    } catch (ex) {
      return { document: null, error: ex instanceof Error ? ex.message : String(ex) };
    }
  }, [analysis, document, roles, texts]);

  const select = async () => {
    setBusy(true);
    setError('');
    setConfirmed(false);
    try {
      const selected = await selectPsd();
      if (!selected) return;
      const result = await analyzePsd(selected.buffer, selected.name, selected.path);
      if (document.layout.template !== 'imported-psd' || result.hash !== document.layout.artwork.source.sha256) {
        throw new Error('O arquivo selecionado não corresponde ao PSD original deste cartaz.');
      }
      const nextRoles: PsdTemplateRoleMap = {};
      const nextTexts: EditablePsdTexts = { category: '', title: '', complement: '', packaging: '' };
      for (const part of document.layout.artwork.templateParts ?? []) {
        if (part.role === 'category' || part.role === 'title' || part.role === 'complement' || part.role === 'packaging') {
          nextRoles[part.role] = part.layerId;
          if (part.role === 'category') nextTexts.category = typeof document.product.category === 'string' ? document.product.category : part.originalText ?? '';
          if (part.role === 'title') nextTexts.title = document.product.name;
          if (part.role === 'complement') nextTexts.complement = document.product.complement;
          if (part.role === 'packaging') nextTexts.packaging = document.product.unit;
        }
      }
      setAnalysis(result);
      setRoles(nextRoles);
      setTexts(nextTexts);
      setConfirmed(false);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const updateRole = (role: ImportedTextRole, id: string) => {
    setRoles(previous => ({ ...previous, [role]: id || undefined }));
    setTexts(previous => ({
      ...previous,
      [role]: analysis?.layers.find(layer => layer.id === id)?.text?.trim() ?? '',
    }));
    setConfirmed(false);
  };

  const submit = async () => {
    if (!preview?.document || !confirmed) return;
    setBusy(true);
    setError('');
    try {
      await save(preview.document);
      close();
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const originalArtwork = document.layout.template === 'imported-psd' ? document.layout.artwork : null;
  return (
    <div className="modal-backdrop psd-backdrop">
      <section className="panel psd-import" role="dialog" aria-modal="true" aria-label="Editar textos da arte PSD">
        <div className="psd-title">
          <div>
            <h2>Editar textos da arte PSD</h2>
            <p>
              Selecione o PSD original, escolha as camadas a editar e confira a prévia.
              O PSD não será alterado. O cartaz da biblioteca será atualizado para todas as ofertas que o utilizam.
            </p>
          </div>
          <button type="button" className="subtle" disabled={busy} onClick={close}>Cancelar</button>
        </div>
        <p>PSD esperado: <strong>{originalArtwork?.source.fileName}</strong></p>
        <button type="button" disabled={busy} onClick={() => void select()}>
          {busy ? 'Aguarde…' : analysis ? 'Selecionar outro PSD' : 'Selecionar PSD original'}
        </button>
        {analysis && (
          <>
            <div className="psd-fields">
              {textRoles.map(({ role, label, maxLength }) => (
                <div key={role}>
                  <label>
                    Camada: {label}
                    <select
                      value={roles[role] ?? ''}
                      onChange={event => updateRole(role, event.target.value)}
                      style={{ display: 'block', width: '100%', marginTop: 6, padding: 8 }}
                    >
                      <option value="">Não editar</option>
                      {analysis.layers.filter(layer => layer.visible && layer.type === 'text' && layer.text).map(layer => (
                        <option key={layer.id} value={layer.id}>{layer.name} — {layer.text}</option>
                      ))}
                    </select>
                  </label>
                  {roles[role] && (
                    <label>
                      Novo texto: {label}
                      <input
                        maxLength={maxLength}
                        value={texts[role]}
                        onChange={event => {
                          setTexts(previous => ({ ...previous, [role]: event.target.value.toUpperCase() }));
                          setConfirmed(false);
                        }}
                      />
                    </label>
                  )}
                </div>
              ))}
            </div>
            {preview?.error && <p className="import-warning" role="alert">{preview.error}</p>}
            {preview?.document && (
              <>
                <div className="psd-workspace">
                  <div>
                    <h3>PSD original</h3>
                    <img className="psd-original" src={analysis.originalPreview} alt="Arte original do PSD" />
                  </div>
                  <div>
                    <h3>Prévia com preço da oferta</h3>
                    <PosterView poster={posterFromDocument({
                      ...preview.document,
                      product: { ...preview.document.product, priceCents: scheduledPriceCents },
                    })} />
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                  <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
                  Revisei as camadas e a prévia. Quero atualizar este cartaz na biblioteca.
                </label>
                <button type="button" disabled={busy || !confirmed} onClick={() => void submit()}>
                  Salvar correção do cartaz
                </button>
              </>
            )}
          </>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
    </div>
  );
}
