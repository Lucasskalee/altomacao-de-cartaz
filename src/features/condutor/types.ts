import type { Poster } from '../../components/editor/PosterView';
import type { Cartaz } from '../cartazes/types';
import type { PaperSize, Orientation } from '../formatos/types';

export type ConductorSourceType = 'library' | 'external_file' | 'external_folder' | 'editor';
export type ConductorFileFormat = 'skcartaz' | 'psd';
export type ConductorItemStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ConductorQueueItem {
  id: string;
  name: string;
  detail: string;
  price: string;
  unit: string;
  f7?: string; // Optional (requirement 4: F7 must be optional)
  category?: string;
  validityText?: string;
  sourcePath: string; // Full Windows / UNC path or special token
  sourceType: ConductorSourceType;
  fileFormat: ConductorFileFormat;
  fileSize?: number;
  copies: number; // >= 1
  status: ConductorItemStatus;
  errorMessage?: string;
  poster?: Poster;
  thumbnailUrl?: string;
  originalCartaz?: Cartaz;
  paperFormat?: PaperSize;
  orientation?: Orientation;
  customWidthMm?: number;
  customHeightMm?: number;
  createdAt?: number;
  lastPrintedAt?: number;
}

export interface ConductorScannedEntry {
  name: string;
  path: string;
  format: 'skcartaz' | 'psd';
  size: number;
  modifiedAt?: number;
}

export interface ConductorPrintBatchResult {
  posters: Poster[];
  skippedErrors: string[];
  totalCopies: number;
  distinctItemsCount: number;
}

