import type { Cartaz, ImportedTextRole } from '../cartazes/types';
import { serialize } from '../cartazes/serialization';
import { openDocument, saveDocument } from '../cartazes/storage';
import { buildArtwork, type PsdAnalysis, type PsdRoleMap, type PsdTemplateRoleMap } from './importer';

export type EditablePsdTexts = Record<ImportedTextRole, string>;

export function prepareLinkedArtwork(
  document: Cartaz,
  analysis: PsdAnalysis,
  textRoles: PsdTemplateRoleMap,
  texts: EditablePsdTexts
): Cartaz {
  if (document.layout.template !== 'imported-psd') throw new Error('Este cartaz não contém uma arte PSD.');
  if (analysis.hash !== document.layout.artwork.source.sha256) {
    throw new Error('Este PSD não é o arquivo usado para criar o cartaz. Selecione o PSD original correspondente.');
  }

  const priceRoles: PsdRoleMap = {};
  for (const part of document.layout.artwork.priceParts) {
    if (part.role === 'whole' || part.role === 'fraction' || part.role === 'decimal' ||
        part.role === 'fractionRule' || part.role === 'validity') {
      priceRoles[part.role] = part.layerId;
    }
  }
  const selected = Object.values(textRoles).filter((id): id is string => Boolean(id));
  if (!selected.length) throw new Error('Selecione ao menos uma camada de texto para editar.');
  if (new Set(selected).size !== selected.length || selected.some(id => Object.values(priceRoles).includes(id))) {
    throw new Error('Cada função deve usar uma camada diferente, sem reutilizar as camadas de preço.');
  }
  for (const id of selected) {
    const layer = analysis.layers.find(item => item.id === id);
    if (!layer || !layer.visible || layer.type !== 'text' || !layer.text) {
      throw new Error('Selecione apenas camadas de texto visíveis do PSD.');
    }
  }
  if (textRoles.title && !texts.title.trim()) throw new Error('Informe o texto da camada de nome.');
  if (textRoles.category && !texts.category.trim()) throw new Error('Informe o texto da categoria.');
  if (textRoles.packaging && !texts.packaging.trim()) throw new Error('Informe o texto da embalagem.');

  const artwork = buildArtwork(analysis, priceRoles, textRoles);
  if (artwork.compatibility !== 'ready') {
    throw new Error(`Não foi possível preparar este PSD: ${artwork.warnings.join(' ')}`);
  }

  const product = { ...document.product };
  if (textRoles.category) product.category = texts.category.trim();
  if (textRoles.title) product.name = texts.title.trim();
  if (textRoles.complement) product.complement = texts.complement.trim();
  if (textRoles.packaging) product.unit = texts.packaging.trim();
  return {
    ...document,
    product,
    layout: { ...document.layout, artwork },
    metadata: { ...document.metadata, updatedAt: new Date().toISOString() },
  };
}

export async function saveLinkedArtwork(
  path: string,
  expected: Cartaz,
  updated: Cartaz,
  editorGuard?: { path: string | null; dirty: boolean }
): Promise<void> {
  const normalize = (value: string) => value.replace(/\//g, '\\').toLocaleLowerCase('en-US');
  if (editorGuard?.dirty && editorGuard.path && normalize(editorGuard.path) === normalize(path)) {
    throw new Error('Este cartaz tem alterações não salvas no editor. Salve ou descarte essas alterações antes de continuar.');
  }
  const current = await openDocument(path);
  if (serialize(current) !== serialize(expected)) {
    throw new Error('O cartaz foi alterado desde que a edição foi aberta. Feche esta janela e atualize a biblioteca antes de tentar novamente.');
  }
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const backupPath = `${path.slice(0, split + 1)}.skalee-backup-${crypto.randomUUID()}.skcartaz`;
  await saveDocument(backupPath, current);
  try {
    await saveDocument(path, updated, true);
  } catch (ex) {
    throw new Error(`Não foi possível salvar o cartaz. Cópia de segurança criada em ${backupPath}. ${String(ex)}`);
  }
}
