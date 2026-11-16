import type { Cartaz, ImportedTextRole } from '../cartazes/types';
import { validate } from '../cartazes/validation';
import { buildArtwork, suggestTemplateLayers, type PsdAnalysis, type PsdRoleMap, type PsdTemplateRoleMap } from './importer';

export type EditablePsdTexts = Record<ImportedTextRole, string>;

export function suggestLinkedArtworkMapping(document: Cartaz, analysis: PsdAnalysis): {
  roles: PsdTemplateRoleMap;
  texts: EditablePsdTexts;
} {
  if (document.layout.template !== 'imported-psd' || analysis.hash !== document.layout.artwork.source.sha256) {
    throw new Error('O PSD vinculado a este cartaz foi alterado ou não corresponde ao documento.');
  }
  const priceRoles: PsdRoleMap = {};
  for (const part of document.layout.artwork.priceParts) {
    if (part.role === 'whole' || part.role === 'fraction' || part.role === 'decimal' ||
        part.role === 'fractionRule' || part.role === 'validity') {
      priceRoles[part.role] = part.layerId;
    }
  }
  const existing = document.layout.artwork.templateParts ?? [];
  const roles: PsdTemplateRoleMap = existing.length ? {} : suggestTemplateLayers(analysis.layers, priceRoles);
  for (const part of existing) {
    if (part.role === 'category' || part.role === 'title' || part.role === 'complement' || part.role === 'packaging') {
      roles[part.role] = part.layerId;
    }
  }
  const texts: EditablePsdTexts = { category: '', title: '', complement: '', packaging: '' };
  for (const role of ['category', 'title', 'complement', 'packaging'] as const) {
    const id = roles[role];
    if (!id) continue;
    const saved = existing.some(part => part.role === role && part.layerId === id);
    if (!saved) {
      texts[role] = analysis.layers.find(layer => layer.id === id)?.text?.trim() ?? '';
    } else if (role === 'category') {
      texts.category = typeof document.product.category === 'string'
        ? document.product.category
        : existing.find(part => part.role === role)?.originalText ?? '';
    } else if (role === 'title') {
      texts.title = document.product.name;
    } else if (role === 'complement') {
      texts.complement = document.product.complement;
    } else {
      texts.packaging = document.product.unit;
    }
  }
  return { roles, texts };
}

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
  const prepared: Cartaz = {
    ...document,
    product,
    layout: { ...document.layout, artwork },
    metadata: { ...document.metadata, updatedAt: new Date().toISOString() },
  };
  validate(prepared);
  return prepared;
}

export function prepareLinkedArtworkAutomatically(document: Cartaz, analysis: PsdAnalysis): Cartaz {
  const { roles, texts } = suggestLinkedArtworkMapping(document, analysis);
  if (!roles.title) {
    throw new Error('Não foi possível identificar automaticamente uma camada de nome ou marca.');
  }
  return prepareLinkedArtwork(document, analysis, roles, texts);
}
