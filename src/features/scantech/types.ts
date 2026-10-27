import type { ImportedArtwork } from '../cartazes/types';
import type { ColumnMapping } from '../ofertas/excel';

export type PhotoshopStatus = {
  available: boolean;
  exePath: string | null;
  version: string | null;
  productName: string | null;
  automationMode: string;
  details: string;
};

export type ScannedPsdEntry = {
  name: string;
  path: string;
  size: number;
  modifiedAt?: number | null;
};

export type ScantechItemStatus = 'pronto' | 'sem-psd' | 'inconsistente' | 'exportado' | 'erro-exportacao';

export type VisualApproval = {
  f7: string;
  priceCents: number;
  validityText: string;
  sourcePsdSha256: string | null;
  approvedAt: string;
};

export type ScantechItem = {
  id: string;
  rowNumber: number;
  f7: string;
  description: string;
  priceCents: number;
  previousPriceCents?: number | null;
  startDateIso: string | null;
  endDateIso: string | null;
  customValidityText: string | null;
  sourcePsdPath: string | null;
  sourcePsdName: string | null;
  cartazId: string | null;
  cartazPath: string | null;
  wholeLayerId: string | null;
  fractionLayerId: string | null;
  decimalLayerId: string | null;
  fractionRuleLayerId: string | null;
  validityLayerId: string | null;
  originalValidityText: string | null;
  selected: boolean;
  status: ScantechItemStatus;
  issues: string[];
  importedPriceWarning?: string | null;
  sourcePsdSha256?: string | null;
  visualApproval?: VisualApproval | null;
  exportedPsdPath: string | null;
  exportedAt: string | null;
  exportError: string | null;
};

export type ScantechCampaign = {
  schemaVersion: 1;
  id: string;
  name: string;
  globalStartDate: string | null;
  globalEndDate: string;
  psdSourceFolder: string | null;
  exportFolder: string | null;
  archived: boolean;
  sourceExcel?: {
    fileName: string;
    sheetName: string;
    headerRowIndex: number;
    mapping: ColumnMapping;
    importedAt: string;
  } | null;
  items: ScantechItem[];
  createdAt: string;
  updatedAt: string;
};

export type ScantechItemView = {
  item: ScantechItem;
  effectiveEndDate: string;
  effectiveStartDate: string | null;
  resolvedValidityText: string;
  wholeValue: string;
  fractionValue: string;
  artwork: ImportedArtwork | null;
  hasInvertedLayers: boolean;
  widthWarning: string | null;
  isVisuallyApproved: boolean;
  realErrors: string[];
  blockingReasons: string[];
  canExport: boolean;
};

export type ScantechExportJob = {
  itemId: string;
  f7: string;
  description: string;
  sourcePsdPath: string;
  outputPsdPath: string;
  wholeLayerId: string;
  fractionLayerId: string;
  decimalLayerId?: string | null;
  fractionRuleLayerId?: string | null;
  validityLayerId?: string | null;
  wholeValue: string;
  fractionValue: string;
  validityText?: string | null;
  rotateDeltaDeg?: number | null;
  skewDeltaDeg?: number | null;
  safeLeftLimit?: number | null;
  safeRightLimit?: number | null;
  horizontalScale?: number | null;
  normalizedTransform?: [number, number, number, number, number, number] | null;
};

export type ScantechExportJobResult = {
  itemId: string;
  f7: string;
  ok: boolean;
  outputPsdPath: string;
  error: string | null;
  warnings: string[];
  wholeApplied: string | null;
  fractionApplied: string | null;
  validityApplied: string | null;
  horizontalScaleApplied?: number | null;
  normalizedTransform?: boolean | null;
  fileSize: number | null;
};

export type ScantechExportBatchResult = {
  photoshopVersion?: string | null;
  directExport?: boolean;
  engine?: string;
  results: ScantechExportJobResult[];
};

