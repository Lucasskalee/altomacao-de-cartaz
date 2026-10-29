import { PaperSize } from '../formatos/types';

export type FormatFilterOption = 'all' | PaperSize;
export type SortOption = 'date_desc' | 'date_asc' | 'name_asc' | 'name_desc';
export type DateFilterOption = 'all' | 'today' | '7days' | '30days' | 'custom';
export type PrintDateFilterOption = 'all' | 'today' | '7days' | '30days' | 'custom' | 'never' | 'printed';

export interface PosterFilterState {
  f7Query: string;
  descQuery: string;
  format: FormatFilterOption;
  createdDateFilter: DateFilterOption;
  createdStartDate?: string;
  createdEndDate?: string;
  printedDateFilter: PrintDateFilterOption;
  printedStartDate?: string;
  printedEndDate?: string;
  sort: SortOption;
}

export const INITIAL_FILTER_STATE: PosterFilterState = {
  f7Query: '',
  descQuery: '',
  format: 'all',
  createdDateFilter: 'all',
  printedDateFilter: 'all',
  sort: 'date_desc',
};

