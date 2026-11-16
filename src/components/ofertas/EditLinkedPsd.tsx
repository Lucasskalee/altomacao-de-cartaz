import { useEffect, useMemo, useState } from 'react';
import type { Cartaz, ImportedTextRole } from '../../features/cartazes/types';
import { posterFromDocument } from '../../features/cartazes/presentation';
import { prepareLinkedArtwork, suggestLinkedArtworkMapping, type EditablePsdTexts } from '../../features/psd/editLinkedArtwork';
import { analyzePsd, type PsdAnalysis, type PsdTemplateRoleMap } from '../../features/psd/importer';
import { readPsdByPath, selectPsd } from '../../features/psd/service';
import { PosterView } from '../editor/PosterView';

const textRoles: { role: ImportedTextRole; label: string; maxLength: number }[] = [
  { role: 'category', label: 'Categoria', maxLength: 32 },
  { role: 'title', label: 'Nome / marca', maxLength: 32 },
  { role: 'complement', label: 'Complemento / sabor', maxLength: 28 },
  { role: 'packaging', label: 'Embalagem', maxLength: 12 },
];

type Props = {
  document: Cartaz;
  close: () => void;
  save: (document: Cartaz) => Promise<void>;
};

export function EditLinkedPsd({ document, close, save }: Props) {
  const [analysis, setAnalysis] = useState<PsdAnalysis | null>(null);
  const [roles, setRoles] = useState<PsdTemplateRoleMap>({});
  const [texts, setTexts] = useState<EditablePsdTexts>({ category: '', title: '', complement: '', packaging: '' });
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadPsd = (result: PsdAnalysis) => {
    const mapping = suggestLinkedArtworkMapping(document, result);
    setAnalysis(result);
    setRoles(mapping.roles);
    setTexts(mapping.texts);
    setConfirmed(false);
  };

  useEffect(() => {
    if (document.layout.template !== 'imported-psd') return;
    const path = document.layout.artwork.source.sourcePath;
    if (!path) {
      setError('Este cartaz não tem o caminho do PSD original. Selecione o PSD manualmente para continuar.');
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError('');
    void readPsdByPath(path)
      .then(selected => analyzePsd(selected.buffer, selected.name, selected.path))
      .then(result => {
        if (!cancelled) loadPsd(result);
      })
      .catch(ex => {
        if (!cancelled) setError(`Não foi possível abrir o PSD vinculado automaticamente. ${ex instanceof Error ? ex.message : String(ex)}`);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, [document]);

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
    setAnalysis(null);
    try {
      const selected = await selectPsd();
      if (!selected) return;
      const result = await analyzePsd(selected.buffer, selected.name, selected.path);
      loadPsd(result);
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
      <section className="panel psd-import" role="dialog" aria-modal="true" aria-label="Revisar camadas do cartaz">
        <div className="psd-title">
          <div>
            <h2>Preparar textos do cartaz</h2>
            <p>
              Confira as camadas sugeridas e a prévia; só textos em camadas editáveis podem ser preparados.
              Ao continuar, você voltará ao editor para ajustar o cartaz.
              Use <strong>Salvar Como</strong> para criar uma cópia; o cartaz original não será alterado.
            </p>
          </div>
          <button type="button" className="subtle" disabled={busy} onClick={close}>Cancelar</button>
        </div>
        <p>PSD esperado: <strong>{originalArtwork?.source.fileName}</strong></p>
        <button type="button" disabled={busy} onClick={() => void select()}>
          {busy ? 'Abrindo PSD vinculado…' : 'Selecionar PSD manualmente'}
        </button>
        {analysis && (
          <>
            {!analysis.layers.some(layer => layer.visible && layer.type === 'text' && layer.text) && (
              <p className="import-warning" role="alert">
                Não foram encontradas camadas de texto visíveis neste PSD. Textos achatados em imagens não podem ser preparados para edição.
              </p>
            )}
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
                    <h3>Prévia do cartaz preparado</h3>
                    <PosterView poster={posterFromDocument(preview.document)} />
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                  <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
                  Revisei as camadas e a prévia. Quero continuar no editor e salvar uma cópia.
                </label>
                <button type="button" disabled={busy || !confirmed} onClick={() => void submit()}>
                  Continuar no editor
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
