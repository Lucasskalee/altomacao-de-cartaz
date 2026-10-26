export type DbfEncoding = 'auto' | 'cp850' | 'cp860' | 'cp437' | 'windows-1252' | 'utf-8';
export type DbfProduct = {
  record: number;
  codeRaw: string;
  f7: string | null;
  description: string;
  priceCents: number | null;
  alternativeCents: number | null;
  barcode: string | null;
  referenceRaw: string;
  alternativeRaw: string;
  issues: string[];
};
export type DbfData = {
  recordsDeclared: number;
  recordsRead: number;
  deleted: number;
  productsIdentified: number;
  invalidRecords: number;
  roundedPrices: number;
  encoding: Exclude<DbfEncoding, 'auto'>;
  languageDriver: number;
  warnings: string[];
  products: DbfProduct[];
};
export type ComparisonStatus = 'Igual' | 'Alterado' | 'Sem cartaz' | 'Conflito no DBF' | 'Dados inválidos';
export type PriceComparison = {
  key: string;
  product: DbfProduct;
  occurrences: number;
  conflicting: boolean;
  cartazPath: string | null;
  cartazId: string | null;
  cartazPriceCents: number | null;
  priceStatus: 'Igual' | 'Alterado' | null;
  status: ComparisonStatus;
};
