import type { Cartaz } from '../cartazes/types';
import type { IndexedCartaz } from '../cartazes/f7';
import type { ColumnMapping } from './excel';

export type PrintStatus = 'pendente' | 'preparado' | 'impresso';

export type CampaignPosterState = {
  cartazId: string;
  cartazPath: string;
  selected: boolean;
  copies: number;
  status: PrintStatus;
  printedAt?: string | null;
};

export type CampaignItem = {
  id: string;
  rowNumber: number;
  f7: string;
  description: string;
  scheduledPriceCents: number;
  conflicting: boolean;
  issues: string[];
  posters: CampaignPosterState[];
};

export type OfferCampaign = {
  schemaVersion: 1;
  id: string;
  name: string;
  campaignDate: string;
  archived: boolean;
  sourceExcel?: {
    fileName: string;
    sheetName: string;
    headerRowIndex: number;
    mapping: ColumnMapping;
    importedAt: string;
  } | null;
  items: CampaignItem[];
  createdAt: string;
  updatedAt: string;
};

export type CampaignMatchView = {
  item: CampaignItem;
  matchedPosters: {
    state: CampaignPosterState;
    libraryCartaz: IndexedCartaz | null;
    currentPriceCents: number | null;
    scheduledDocument: Cartaz | null;
  }[];
  unlinkedLibraryPosters: IndexedCartaz[];
  hasConflict: boolean;
  missingPoster: boolean;
};
