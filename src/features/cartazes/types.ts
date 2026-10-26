export type Cartaz = {
  schemaVersion: 1;
  id: string;
  product: { name: string; complement: string; priceCents: number; unit: string; productCode: string | null; [key: string]: unknown };
  layout: { template: 'oferta-classica'; paper: 'A5'; orientation: 'portrait'; [key: string]: unknown };
  metadata: { createdAt: string; updatedAt: string; [key: string]: unknown };
  [key: string]: unknown;
};
export type Entry = { path: string; name: string; folder: boolean; content?: string; error?: string; modifiedAt?: number };
export type Library = { root: string; entries: Entry[] };
