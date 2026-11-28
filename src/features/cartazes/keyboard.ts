import type { ConfirmDialogRequest } from '../../components/common/ConfirmModal';

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
]);

/**
 * Returns true only when the event target is an active text-editing control
 * (text inputs, textarea, select, or contentEditable).
 * Checkboxes and radios return false so pressing Delete right after checking
 * a poster in a list triggers the list Delete shortcut as expected.
 */
export function isTextEditingElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as HTMLElement;
  const tag = el.tagName?.toLowerCase();
  if (!tag) return false;
  if (tag === 'textarea' || tag === 'select' || el.isContentEditable) {
    return true;
  }
  if (tag === 'input') {
    const inputType = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(inputType);
  }
  return false;
}

/**
 * Returns true when an interactive modal dialog is currently mounted on screen,
 * preventing background list keyboard shortcuts (like Delete) from firing behind it.
 */
export function hasActiveModalDialog(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.querySelector('[role="dialog"][aria-modal="true"], .modal-backdrop'));
}

/**
 * Builds a clear, high-trust confirmation dialog request before permanently
 * deleting selected posters from disk / library.
 */
export function buildBatchDeleteConfirmation(
  paths: string[],
  resolveLabel: (path: string) => string
): ConfirmDialogRequest {
  const count = paths.length;
  const labels = paths.map(p => resolveLabel(p).trim() || p.split(/[\\/]/).pop() || p);
  const previewLimit = 4;
  const previewNames = labels
    .slice(0, previewLimit)
    .map(name => `"${name}"`)
    .join(', ');
  const overflow = count > previewLimit ? ` e mais ${count - previewLimit}` : '';

  const title =
    count === 1
      ? 'Excluir 1 cartaz permanentemente?'
      : `Excluir ${count} cartazes permanentemente?`;

  const description =
    count === 1
      ? `Deseja excluir permanentemente o cartaz ${previewNames} do disco e da biblioteca?`
      : `Deseja excluir permanentemente os ${count} cartazes selecionados (${previewNames}${overflow})?`;

  return {
    title,
    description,
    note: 'Esta ação remove os arquivos permanentemente do disco e da biblioteca local e não pode ser desfeita.',
    confirmLabel: count === 1 ? 'Excluir permanentemente' : `Excluir ${count} cartazes`,
    cancelLabel: 'Cancelar',
    tone: 'danger',
  };
}
