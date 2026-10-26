import { invoke } from '@tauri-apps/api/core';
import type { PriceComparison } from './types';

export type EditorGuard = { path: string | null; dirty: boolean };
export type Proposal = { path: string; documentId: string; f7: string; oldPriceCents: number; newPriceCents: number; source: string; conflicting: boolean };
export type Change = Omit<Proposal, 'source' | 'conflicting'> & { name: string };
export type Review = { id: string; action: 'update' | 'restore'; dbfName: string; changes: Change[]; ignoredConflicts: number };
export type HistoryEntry = Change & { id: string; timestamp: string; action: 'update' | 'restore'; dbfName: string; result: string; message: string; backupAvailable: boolean; backupPath: string; restoresId: string | null };
export type UpdateOutcome = { entries: HistoryEntry[]; stopped: boolean; errors: string[] };
export type HistoryData = { entries: HistoryEntry[]; errors: string[] };
const normalizedPath = (path: string) => path.replace(/\//g, '\\').toLocaleLowerCase('en-US');
export const selectionKey = (row: PriceComparison) => JSON.stringify([row.cartazId, row.cartazPath ? normalizedPath(row.cartazPath) : null]);
export const dirtyPaths = (guard: EditorGuard) => guard.dirty && guard.path ? [guard.path] : [];
export function isBlockedInEditor(row: PriceComparison, guard: EditorGuard): boolean {
  return Boolean(guard.dirty && guard.path && row.cartazPath && normalizedPath(guard.path) === normalizedPath(row.cartazPath));
}
export function canSelect(row: PriceComparison, guard: EditorGuard): boolean {
  return row.status === 'Alterado' && !row.conflicting && row.product.issues.length === 0 && Boolean(row.cartazPath && row.cartazId && row.cartazSource && row.product.f7) && row.cartazPriceCents !== null && Number.isSafeInteger(row.product.priceCents) && row.product.priceCents !== null && row.product.priceCents >= 0 && row.product.priceCents <= 99_999_999 && !isBlockedInEditor(row, guard);
}
export function selectedProposals(rows: PriceComparison[], selected: Set<string>, guard: EditorGuard): Proposal[] {
  const unique = new Map<string, Proposal>();
  for (const row of rows) {
    if (!selected.has(selectionKey(row))) continue;
    if (!canSelect(row, guard)) throw new Error('A seleção contém um cartaz bloqueado, conflitante ou sem alteração válida. Revise a comparação.');
    unique.set(selectionKey(row), { path: row.cartazPath!, documentId: row.cartazId!, f7: row.product.f7!, oldPriceCents: row.cartazPriceCents!, newPriceCents: row.product.priceCents!, source: row.cartazSource!, conflicting: row.conflicting });
  }
  if (unique.size === 0) throw new Error('Selecione ao menos uma alteração válida.');
  return [...unique.values()];
}
export const prepareUpdates = (dbfName: string, proposals: Proposal[], conflictCodes: string[], guard: EditorGuard) =>
  invoke<Review>('prepare_price_updates', { dbfName, proposals, conflictCodes, dirtyPaths: dirtyPaths(guard) });
export const prepareRestore = (entryId: string, guard: EditorGuard) =>
  invoke<Review>('prepare_price_restore', { entryId, dirtyPaths: dirtyPaths(guard) });
export const commitUpdates = (planId: string, guard: EditorGuard) =>
  invoke<UpdateOutcome>('commit_price_updates', { planId, confirmed: true, dirtyPaths: dirtyPaths(guard) });
export const listHistory = () => invoke<HistoryData>('list_price_history');
export const discardPlan = (planId: string) => invoke<void>('discard_price_plan', { planId });
export const changedPaths = (outcome: UpdateOutcome) => outcome.entries.filter(entry => ['updated', 'restored', 'recovery-required'].includes(entry.result)).map(entry => entry.path);
export const resultLabel: Record<string, string> = { updated: 'Atualizado', restored: 'Restaurado', failed: 'Falha', skipped: 'Não executado', prepared: 'Interrompido — conferir backup', 'recovery-required': 'Requer recuperação' };
