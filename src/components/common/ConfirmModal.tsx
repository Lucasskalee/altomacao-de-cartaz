import { useEffect } from 'react';

export type ConfirmDialogRequest = {
  title: string;
  description: string;
  note?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'warning' | 'danger';
};

type Props = {
  request: ConfirmDialogRequest | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmModal({ request, onConfirm, onCancel }: Props) {
  useEffect(() => {
    if (!request) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [request, onCancel]);

  if (!request) return null;

  const tone = request.tone ?? 'primary';
  const confirmClass =
    tone === 'danger'
      ? 'editor-btn sk-btn-danger'
      : tone === 'warning'
        ? 'editor-btn sk-btn-warning'
        : 'editor-btn primary';

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="panel modal sk-lib-modal sk-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sk-confirm-modal-title"
      >
        <h2 id="sk-confirm-modal-title" className={`sk-confirm-title sk-confirm-title--${tone}`}>
          {request.title}
        </h2>
        <p className="sk-confirm-description">{request.description}</p>
        {request.note && <div className="sk-modal-note">{request.note}</div>}
        <div className="toolbar sk-modal-actions">
          <button type="button" className="editor-btn subtle" onClick={onCancel}>
            {request.cancelLabel || 'Cancelar'}
          </button>
          <button type="button" className={confirmClass} onClick={onConfirm} autoFocus>
            {request.confirmLabel || 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  );
}
