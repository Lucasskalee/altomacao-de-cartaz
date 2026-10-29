export type ImportedPriceRole = 'whole' | 'fraction' | 'decimal' | 'fractionRule' | 'validity';
export type ImportedTextRole = 'category' | 'title' | 'complement' | 'packaging';
export type ImportedRole = ImportedPriceRole | ImportedTextRole;
export type ImportedLayerInfo = {
  id: string; name: string; type: 'text' | 'raster' | 'vector' | 'group' | 'empty';
  visible: boolean; depth: number; text?: string; font?: string;
  bounds: { left: number; top: number; right: number; bottom: number };
};
export type ImportedPricePart = {
  role: ImportedRole; layerId: string;
  bounds: { left: number; top: number; right: number; bottom: number };
  fontFamily?: string; fontSize?: number; originalText?: string; transform?: [number,number,number,number,number,number];
  color: string; shadow?: { dx: number; dy: number; blur: number; color: string };
  stroke?: { size: number; color: string };
};
export type ImportedArtwork = {
  kind: 'imported-psd'; compatibility: 'ready' | 'requires-preparation';
  source: { fileName: string; sha256: string; sourcePath?: string | null };
  canvas: { width: number; height: number; resolutionPpi: number; fit: 'contain' };
  staticBackground: string; originalPreview: string;
  priceParts: ImportedPricePart[]; layers: ImportedLayerInfo[]; warnings: string[];
  templateParts?: ImportedPricePart[];
  isReferenceTemplate?: boolean;
};
export type PaperFormat = 'A6' | 'A5' | 'A4' | 'A3' | 'expositor-a3-2x2' | 'custom';
export type LayoutOrientation = 'portrait' | 'landscape';
export type ClassicLayout = { template: 'oferta-classica'; paper: PaperFormat; orientation: LayoutOrientation; customWidthMm?: number; customHeightMm?: number; [key: string]: unknown };
export type ImportedLayout = { template: 'imported-psd'; paper: PaperFormat; orientation: LayoutOrientation; customWidthMm?: number; customHeightMm?: number; artwork: ImportedArtwork; [key: string]: unknown };

export type Cartaz = {
  schemaVersion: 1;
  id: string;
  product: { name: string; complement: string; priceCents: number; unit: string; productCode?: string | null; [key: string]: unknown };
  layout: ClassicLayout | ImportedLayout;
  metadata: { createdAt: string; updatedAt: string; [key: string]: unknown };
  [key: string]: unknown;
};
export type Entry = { path: string; name: string; folder: boolean; content?: string; error?: string; modifiedAt?: number };
export type Library = { root: string; entries: Entry[] };
