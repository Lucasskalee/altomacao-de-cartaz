import { PaperSize, Orientation } from '../formatos/types';

export type PrintOperationStatus = 'requested' | 'sent' | 'confirmed';

export interface PrintHistoryEntry {
  id: string;
  productName: string;
  f7?: string | null;
  formatLabel: string;
  paper: PaperSize;
  orientation: Orientation;
  timestamp: number; // Unix timestamp em ms
  formattedDate: string; // Ex: "28/10/2026 19:50"
  copies: number;
  status: PrintOperationStatus;
  sourcePath?: string;
}

export type HistoryPeriodFilter = 'all' | 'today' | '7days' | '30days' | 'custom';

export interface PrintHistoryFilter {
  period: HistoryPeriodFilter;
  startDate?: string;
  endDate?: string;
  format?: string; // 'all' | 'A5' | 'A4' | 'A3' | 'custom'
  query?: string; // Busca por nome de produto ou F7
}

