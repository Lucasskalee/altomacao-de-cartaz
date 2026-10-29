export type PaperSize = 'A6' | 'A5' | 'A4' | 'A3' | 'expositor-a3-2x2' | 'custom';
export type Orientation = 'portrait' | 'landscape';

export interface PosterFormatConfig {
  paper: PaperSize;
  orientation: Orientation;
  customWidthMm?: number;
  customHeightMm?: number;
}

export const DEFAULT_FORMAT_CONFIG: PosterFormatConfig = {
  paper: 'A5',
  orientation: 'portrait',
};

export const STANDARD_PAPER_DIMENSIONS_MM: Record<'A6' | 'A5' | 'A4' | 'A3' | 'expositor-a3-2x2', { width: number; height: number }> = {
  A6: { width: 105, height: 148 },
  A5: { width: 148, height: 210 },
  A4: { width: 210, height: 297 },
  A3: { width: 297, height: 420 },
  'expositor-a3-2x2': { width: 594, height: 840 },
};

export interface ResolutionCheckResult {
  isInsufficient: boolean;
  warning?: string;
  recommendedPx: { width: number; height: number };
  minimumPx: { width: number; height: number };
  effectiveDpi?: number;
}
