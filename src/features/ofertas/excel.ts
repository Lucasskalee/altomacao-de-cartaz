import { inflateRaw } from 'pako';
import { digitsOnly, getF7 } from '../cartazes/f7';

export const MAX_EXCEL_BYTES = 25 * 1024 * 1024;
export const MAX_EXCEL_ROWS = 50_000;
export const MAX_EXCEL_COLS = 100;

export type ExcelSheet = {
  name: string;
  rows: string[][];
};

export type ExcelWorkbook = {
  fileName: string;
  sheets: ExcelSheet[];
};

export type ColumnMapping = {
  f7Col: number;
  descriptionCol: number;
  priceCol: number;
};

export type ExcelImportedItem = {
  rowNumber: number;
  f7Raw: string;
  f7: string | null;
  description: string;
  priceRaw: string;
  priceCents: number | null;
  issues: string[];
};

export type ExcelExtractionResult = {
  items: ExcelImportedItem[];
  validCount: number;
  invalidCount: number;
  duplicateF7s: string[];
  conflictingF7s: string[];
};

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|apos|quot);/g, (_, entity: string) => {
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'amp') return '&';
    if (entity === 'apos') return "'";
    if (entity === 'quot') return '"';
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return '';
  });
}

function unzipEntries(buffer: ArrayBuffer): Map<string, Uint8Array> {
  if (buffer.byteLength < 22 || buffer.byteLength > MAX_EXCEL_BYTES) {
    throw new Error('O arquivo Excel (.xlsx) deve ter entre 22 bytes e 25 MB.');
  }
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x04034b50) {
    throw new Error('Arquivo inválido: selecione uma planilha Excel .xlsx válida.');
  }
  let eocdOffset = -1;
  const minEocd = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Estrutura ZIP da planilha .xlsx não encontrada ou corrompida.');
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (totalEntries > 2000 || cdOffset >= bytes.length) {
    throw new Error('Estrutura interna do arquivo .xlsx inválida ou excede o limite de entradas.');
  }
  const entries = new Map<string, Uint8Array>();
  let offset = cdOffset;
  let totalUncompressed = 0;
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('Cabeçalho de diretório central do .xlsx corrompido.');
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen)).replace(/\\/g, '/');
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > 64 * 1024 * 1024) {
      throw new Error('Planilha .xlsx descompactada excede o limite de memória permitido (64 MB).');
    }
    if (localHeaderOffset + 30 > bytes.length || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error('Cabeçalho local do .xlsx inválido.');
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error('Dados compactados do .xlsx truncados.');
    const slice = bytes.subarray(dataStart, dataEnd);
    if (method === 0) {
      entries.set(name, slice);
    } else if (method === 8) {
      entries.set(name, inflateRaw(slice));
    } else {
      throw new Error(`Método de compressão ZIP não suportado (${method}).`);
    }
  }
  return entries;
}

function getAttr(tag: string, attrName: string): string | null {
  const regex = new RegExp(`(?:^|\\s)${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = tag.match(regex);
  return match ? decodeXmlEntities(match[1] ?? match[2] ?? '') : null;
}

function parseSharedStrings(xml: string): string[] {
  const result: string[] = [];
  const siRegex = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRegex.exec(xml)) !== null) {
    const inner = siMatch[1];
    const tRegex = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
    let text = '';
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(inner)) !== null) {
      text += decodeXmlEntities(tMatch[1]);
    }
    result.push(text);
  }
  return result;
}

function colRefToIndex(ref: string): number {
  const letters = ref.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? '';
  if (!letters) return -1;
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col - 1;
}

function parseWorksheet(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g;
  let rowMatch: RegExpExecArray | null;
  let autoRowIndex = 0;
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowAttrs = rowMatch[1];
    const rowBody = rowMatch[2];
    const rAttr = getAttr(rowAttrs, 'r');
    const rowIndex = rAttr && /^\d+$/.test(rAttr) ? Math.max(0, parseInt(rAttr, 10) - 1) : autoRowIndex;
    autoRowIndex = rowIndex + 1;
    if (rowIndex >= MAX_EXCEL_ROWS) throw new Error(`A planilha excede o limite de ${MAX_EXCEL_ROWS.toLocaleString('pt-BR')} linhas.`);
    const rowCells: string[] = [];
    const cellRegex = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let cellMatch: RegExpExecArray | null;
    let autoColIndex = 0;
    while ((cellMatch = cellRegex.exec(rowBody)) !== null) {
      const cellAttrs = cellMatch[1];
      const cellBody = cellMatch[2] ?? '';
      const cellRef = getAttr(cellAttrs, 'r');
      const colIndex = cellRef ? colRefToIndex(cellRef) : autoColIndex;
      const targetCol = colIndex >= 0 ? colIndex : autoColIndex;
      autoColIndex = targetCol + 1;
      if (targetCol >= MAX_EXCEL_COLS) continue;
      const cellType = getAttr(cellAttrs, 't') ?? '';
      let rawValue = '';
      if (cellType === 'inlineStr') {
        const tRegex = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
        let tMatch: RegExpExecArray | null;
        while ((tMatch = tRegex.exec(cellBody)) !== null) {
          rawValue += decodeXmlEntities(tMatch[1]);
        }
      } else {
        const vMatch = cellBody.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
        const vText = vMatch ? decodeXmlEntities(vMatch[1]).trim() : '';
        if (cellType === 's') {
          const idx = parseInt(vText, 10);
          rawValue = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : '';
        } else {
          rawValue = vText;
        }
      }
      while (rowCells.length <= targetCol) rowCells.push('');
      rowCells[targetCol] = rawValue.trim();
    }
    while (rows.length <= rowIndex) rows.push([]);
    rows[rowIndex] = rowCells;
  }
  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return rows.map(r => {
    const normalized = [...r];
    while (normalized.length < maxCols) normalized.push('');
    return normalized;
  });
}

export function parseXlsx(buffer: ArrayBuffer, fileName = 'planilha.xlsx'): ExcelWorkbook {
  const entries = unzipEntries(buffer);
  const decoder = new TextDecoder('utf-8');
  const readText = (path: string) => {
    const bytes = entries.get(path);
    return bytes ? decoder.decode(bytes) : null;
  };
  const workbookXml = readText('xl/workbook.xml');
  if (!workbookXml) throw new Error('Arquivo .xlsx inválido: xl/workbook.xml não encontrado.');
  const relsXml = readText('xl/_rels/workbook.xml.rels') ?? '';
  const relMap = new Map<string, string>();
  const relRegex = /<(?:\w+:)?Relationship\b([^>]*?)\/?>/g;
  let relMatch: RegExpExecArray | null;
  while ((relMatch = relRegex.exec(relsXml)) !== null) {
    const id = getAttr(relMatch[1], 'Id');
    const target = getAttr(relMatch[1], 'Target');
    if (id && target) {
      const normalized = target.replace(/^\/+/, '').startsWith('xl/')
        ? target.replace(/^\/+/, '')
        : `xl/${target.replace(/^\.?\/+/, '')}`;
      relMap.set(id, normalized);
    }
  }
  const sharedStringsXml = readText('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : [];
  const sheets: ExcelSheet[] = [];
  const sheetRegex = /<(?:\w+:)?sheet\b([^>]*?)\/?>/g;
  let sheetMatch: RegExpExecArray | null;
  let sheetIndex = 1;
  while ((sheetMatch = sheetRegex.exec(workbookXml)) !== null) {
    const attrs = sheetMatch[1];
    const name = getAttr(attrs, 'name') || `Planilha ${sheetIndex}`;
    const rId = getAttr(attrs, 'r:id') ?? getAttr(attrs, 'id');
    const targetPath = (rId && relMap.get(rId)) || `xl/worksheets/sheet${sheetIndex}.xml`;
    const sheetXml = readText(targetPath) ?? readText(`xl/worksheets/sheet${sheetIndex}.xml`);
    if (sheetXml) {
      sheets.push({ name, rows: parseWorksheet(sheetXml, sharedStrings) });
    }
    sheetIndex++;
  }
  if (sheets.length === 0) throw new Error('Nenhuma aba de planilha encontrada no arquivo .xlsx.');
  return { fileName, sheets };
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label || 'A';
}

export function suggestColumnMapping(headers: string[]): ColumnMapping {
  const norm = headers.map(h =>
    h.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  );
  const findCol = (patterns: RegExp[], exclude: number[] = []) => {
    for (const pattern of patterns) {
      const idx = norm.findIndex((text, i) => !exclude.includes(i) && pattern.test(text));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  let f7Col = findCol([/\bf7\b/, /cod.*prod/, /\bcodigo\b/, /\bcod\b/, /\breferencia\b/, /\bsku\b/]);
  if (f7Col < 0 && headers.length > 0) f7Col = 0;
  let descriptionCol = findCol([/descri/, /produt/, /\bnome\b/, /\bitem\b/, /mercadoria/], [f7Col]);
  if (descriptionCol < 0 && headers.length > 1) descriptionCol = [0, 1, 2].find(i => i !== f7Col) ?? 0;
  let priceCol = findCol([/preco/, /oferta/, /promoc/, /valor/, /prvenda/, /futuro/, /amanha/], [f7Col, descriptionCol]);
  if (priceCol < 0 && headers.length > 2) priceCol = [0, 1, 2, 3].find(i => i !== f7Col && i !== descriptionCol) ?? 0;
  return {
    f7Col: Math.max(0, f7Col),
    descriptionCol: Math.max(0, descriptionCol),
    priceCol: Math.max(0, priceCol),
  };
}

function roundFloatingNumberString(raw: string): string {
  // Trata imprecisão IEEE-754 em células numéricas do Excel (ex.: "19.890000000000001", "8.9900000000000002", "1.99E+1")
  if (!/^\d+\.\d{5,}$/.test(raw) && !/^\d+(?:\.\d+)?[eE][+-]?\d+$/.test(raw)) return raw;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0 || num > 999_999.9999) return raw;
  // Arredonda para 4 casas decimais para eliminar ruído binário IEEE-754 mantendo subcentavos de milésimo
  return num.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function parseExcelPriceToCents(raw: string): number {
  const cleaned = roundFloatingNumberString(raw.replace(/R\$/gi, '').replace(/\s+/g, '').trim());
  if (!cleaned) throw new Error('Preço vazio');
  if (cleaned.startsWith('-')) throw new Error('Preço negativo não permitido');
  let normalized = cleaned;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    normalized = cleaned.replace(',', '.');
  }
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error('Formato de preço inválido');
  const [whole, fraction = ''] = normalized.split('.');
  if (whole.length > 8) throw new Error('Preço excede o limite permitido');
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)) + (fraction.length > 2 && fraction[2] >= '5' ? 1n : 0n);
  if (cents <= 0n || cents > 99_999_999n) throw new Error('Preço deve ser maior que zero e até R$ 999.999,99');
  return Number(cents);
}

export function extractCampaignItemsFromSheet(
  sheet: ExcelSheet,
  headerRowIndex: number,
  mapping: ColumnMapping
): ExcelExtractionResult {
  const items: ExcelImportedItem[] = [];
  const f7Counts = new Map<string, number>();
  const f7Prices = new Map<string, Set<number>>();

  const startRow = Math.max(0, headerRowIndex + 1);
  for (let r = startRow; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    if (row.every(cell => !cell.trim())) continue;
    const f7Raw = (row[mapping.f7Col] ?? '').trim();
    const description = (row[mapping.descriptionCol] ?? '').trim().toUpperCase();
    const priceRaw = (row[mapping.priceCol] ?? '').trim();
    const issues: string[] = [];

    const cleanedF7 = getF7(f7Raw) ?? (f7Raw && /^0*\d+$/.test(f7Raw) ? f7Raw : null);
    if (!f7Raw) {
      issues.push('Código F7 vazio');
    } else if (!cleanedF7) {
      const onlyDigits = digitsOnly(f7Raw);
      if (!onlyDigits || f7Raw !== onlyDigits) {
        issues.push('F7 contém caracteres não numéricos');
      }
    }

    if (!description) {
      issues.push('Descrição vazia');
    }

    let priceCents: number | null = null;
    if (!priceRaw) {
      issues.push('Preço programado vazio');
    } else {
      try {
        priceCents = parseExcelPriceToCents(priceRaw);
      } catch (err) {
        issues.push(err instanceof Error ? err.message : String(err));
      }
    }

    if (cleanedF7) {
      f7Counts.set(cleanedF7, (f7Counts.get(cleanedF7) ?? 0) + 1);
      if (priceCents !== null) {
        const prices = f7Prices.get(cleanedF7) ?? new Set<number>();
        prices.add(priceCents);
        f7Prices.set(cleanedF7, prices);
      }
    }

    items.push({
      rowNumber: r + 1,
      f7Raw,
      f7: cleanedF7,
      description,
      priceRaw,
      priceCents,
      issues,
    });
  }

  const duplicateF7s: string[] = [];
  const conflictingF7s: string[] = [];
  for (const [f7, count] of f7Counts.entries()) {
    if (count > 1) {
      duplicateF7s.push(f7);
      if ((f7Prices.get(f7)?.size ?? 0) > 1) {
        conflictingF7s.push(f7);
      }
    }
  }

  for (const item of items) {
    if (item.f7 && conflictingF7s.includes(item.f7)) {
      item.issues.push('Conflito na planilha: mesmo F7 com preços programados diferentes');
    }
  }

  const validCount = items.filter(i => i.issues.length === 0).length;
  const invalidCount = items.length - validCount;
  return { items, validCount, invalidCount, duplicateF7s, conflictingF7s };
}
