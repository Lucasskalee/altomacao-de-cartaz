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
  previousPriceCol?: number | null;
  startDateCol?: number | null;
  endDateCol?: number | null;
};

export type ExcelImportedItem = {
  rowNumber: number;
  f7Raw: string;
  f7: string | null;
  description: string;
  priceRaw: string;
  priceCents: number | null;
  previousPriceRaw?: string;
  previousPriceCents?: number | null;
  startDateRaw?: string;
  startDateIso?: string | null;
  endDateRaw?: string;
  endDateIso?: string | null;
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
    throw new Error('O arquivo de planilha (.xlsx ou .xls) deve ter entre 22 bytes e 25 MB.');
  }
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x04034b50) {
    throw new Error('Arquivo inválido: selecione uma planilha Excel válida (.xlsx ou .xls).');
  }
  let eocdOffset = -1;
  const minEocd = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Estrutura ZIP da planilha não encontrada ou corrompida.');
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (totalEntries > 2000 || cdOffset >= bytes.length) {
    throw new Error('Estrutura interna da planilha inválida ou excede o limite de entradas.');
  }
  const entries = new Map<string, Uint8Array>();
  let offset = cdOffset;
  let totalUncompressed = 0;
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('Cabeçalho de diretório central da planilha corrompido.');
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
      throw new Error('Planilha descompactada excede o limite de memória permitido (64 MB).');
    }
    if (localHeaderOffset + 30 > bytes.length || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error('Cabeçalho local da planilha inválido.');
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error('Dados compactados da planilha truncados.');
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

function parseOpenXmlWorkbook(buffer: ArrayBuffer, fileName: string): ExcelWorkbook {
  const entries = unzipEntries(buffer);
  const decoder = new TextDecoder('utf-8');
  const readText = (path: string) => {
    const bytes = entries.get(path);
    return bytes ? decoder.decode(bytes) : null;
  };
  const workbookXml = readText('xl/workbook.xml');
  if (!workbookXml) throw new Error('Arquivo de planilha inválido: xl/workbook.xml não encontrado.');
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
  if (sheets.length === 0) throw new Error('Nenhuma aba de planilha encontrada no arquivo.');
  return { fileName, sheets };
}

function parseCsvOrTextSpreadsheet(text: string): string[][] {
  const lines = text.split(/\r?\n/).slice(0, 30).filter(l => l.trim().length > 0);
  let commaCount = 0;
  let semiCount = 0;
  let tabCount = 0;
  for (const line of lines) {
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (!inQuotes) {
        if (c === ';') semiCount++;
        else if (c === ',') commaCount++;
        else if (c === '\t') tabCount++;
      }
    }
  }
  let delimiter = ';';
  if (tabCount > semiCount && tabCount > commaCount) delimiter = '\t';
  else if (commaCount > semiCount && commaCount > tabCount) delimiter = ',';

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        currentCell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && c === delimiter) {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if (!inQuotes && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') {
        i++;
      }
      currentRow.push(currentCell.trim());
      currentCell = '';
      if (currentRow.some(cell => cell.length > 0)) {
        if (rows.length >= MAX_EXCEL_ROWS) {
          throw new Error(`A planilha excede o limite de ${MAX_EXCEL_ROWS.toLocaleString('pt-BR')} linhas.`);
        }
        rows.push(currentRow.slice(0, MAX_EXCEL_COLS));
      }
      currentRow = [];
    } else {
      currentCell += c;
    }
  }
  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some(cell => cell.length > 0)) {
      if (rows.length < MAX_EXCEL_ROWS) {
        rows.push(currentRow.slice(0, MAX_EXCEL_COLS));
      }
    }
  }

  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return rows.map(r => {
    const normalized = [...r];
    while (normalized.length < maxCols) normalized.push('');
    return normalized;
  });
}

function parseHtmlOrXmlSpreadsheet(text: string): string[][] {
  const rows: string[][] = [];
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(text)) !== null) {
    const rowContent = trMatch[1];
    const cellRegex = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const cellText = decodeXmlEntities(cellMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      cells.push(cellText);
    }
    if (cells.some(c => c.length > 0)) {
      if (rows.length >= MAX_EXCEL_ROWS) break;
      rows.push(cells.slice(0, MAX_EXCEL_COLS));
    }
  }

  if (rows.length === 0) {
    const xmlRowRegex = /<(?:\w+:)?Row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Row>/gi;
    let xmlRowMatch: RegExpExecArray | null;
    while ((xmlRowMatch = xmlRowRegex.exec(text)) !== null) {
      const rowContent = xmlRowMatch[1];
      const cellRegex = /<(?:\w+:)?Data\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Data>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
        cells.push(decodeXmlEntities(cellMatch[1].trim()));
      }
      if (cells.some(c => c.length > 0)) {
        if (rows.length >= MAX_EXCEL_ROWS) break;
        rows.push(cells.slice(0, MAX_EXCEL_COLS));
      }
    }
  }

  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  return rows.map(r => {
    const normalized = [...r];
    while (normalized.length < maxCols) normalized.push('');
    return normalized;
  });
}

export function parseSpreadsheet(buffer: ArrayBuffer, fileName = 'planilha.xlsx'): ExcelWorkbook {
  if (buffer.byteLength < 4 || buffer.byteLength > MAX_EXCEL_BYTES) {
    throw new Error('O arquivo de planilha deve ter entre 4 bytes e 25 MB.');
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);

  // 1. Arquivo ZIP / OpenXML (.xlsx ou .xls gravado com formato OpenXML)
  if (magic === 0x04034b50) {
    return parseOpenXmlWorkbook(buffer, fileName);
  }

  // 2. Arquivo binário OLE2 / BIFF8 legado (Excel 97-2003 puro: \xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1)
  const bytes = new Uint8Array(buffer);
  if (
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  ) {
    throw new Error(
      'Arquivo .xls em formato binário legado (Excel 97-2003). Abra o arquivo no Excel e salve-o como .xlsx ou .csv para importá-lo.'
    );
  }

  // 3. Arquivo em formato texto, CSV, TSV, XML ou HTML exportado como .xls
  let text = '';
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    text = utf8Decoder.decode(bytes);
  } catch {
    const winDecoder = new TextDecoder('windows-1252');
    text = winDecoder.decode(bytes);
  }

  const trimmedText = text.trim();
  let rows: string[][] = [];

  if (/<(?:table|html|Workbook)\b/i.test(trimmedText)) {
    rows = parseHtmlOrXmlSpreadsheet(trimmedText);
  } else {
    rows = parseCsvOrTextSpreadsheet(trimmedText);
  }

  if (rows.length === 0) {
    throw new Error('Nenhum dado ou linha de tabela encontrada na planilha.');
  }

  return {
    fileName,
    sheets: [{ name: 'Planilha 1', rows }],
  };
}

export const parseXlsx = parseSpreadsheet;

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

export function detectHeaderRowIndex(rows: string[][]): number {
  let bestRow = 0;
  let bestScore = 0;
  const limit = Math.min(15, rows.length);
  for (let r = 0; r < limit; r++) {
    const row = rows[r] ?? [];
    let score = 0;
    for (const rawCell of row) {
      const text = rawCell.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      if (!text) continue;
      if (/\bf7\b|cod.*prod|\bcod(?:igo|ico)?\b|\breferencia\b|\bsku\b/.test(text)) score += 2;
      else if (/\bscanteh\b|\bscantech\b|descri|produt|\bnome\b|\bitem\b|mercadoria/.test(text)) score += 2;
      else if (/data\s*ate\b|dt.*fim|dt.*fin|data.*fim|data.*fin|validade|vencim|\bate\b/.test(text)) score += 2;
      else if (/^de$|preco\s*de\b|preco\s*ant|valor\s*de\b/.test(text)) score += 1;
      else if (/^por$|preco\s*por\b|preco|oferta|promoc|valor|prvenda|futuro|amanha/.test(text)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestRow = r;
    }
  }
  return bestScore >= 2 ? bestRow : 0;
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
  let f7Col = findCol([/\bf7\b/, /cod.*prod/, /\bcod(?:igo|ico)?\b/, /\breferencia\b/, /\bsku\b/]);
  if (f7Col < 0 && headers.length > 0) f7Col = 0;
  let descriptionCol = findCol(
    [/\bscanteh\b|\bscantech\b/, /descri/, /produt/, /\bnome\b/, /\bitem\b/, /mercadoria/],
    [f7Col]
  );
  if (descriptionCol < 0 && headers.length > 1) descriptionCol = [0, 1, 2].find(i => i !== f7Col) ?? 0;

  const endDateCol = findCol(
    [/data\s*ate\b/, /dt.*fim/, /dt.*fin/, /data.*fim/, /data.*fin/, /validade/, /vencim/, /\bate\b/, /\bfinal\b/],
    [f7Col, descriptionCol]
  );
  const previousPriceCol = findCol(
    [/^de$/, /preco\s*de\b/, /preco\s*ant/, /valor\s*de\b/, /\bde\s*r\$/],
    [f7Col, descriptionCol, ...(endDateCol >= 0 ? [endDateCol] : [])]
  );
  const startDateCol = findCol(
    [/dt.*inic/, /data.*inic/, /\binicio\b/, /data\s*de\b/],
    [
      f7Col,
      descriptionCol,
      ...(endDateCol >= 0 ? [endDateCol] : []),
      ...(previousPriceCol >= 0 ? [previousPriceCol] : []),
    ]
  );

  const excludeForPrice = [
    f7Col,
    descriptionCol,
    ...(endDateCol >= 0 ? [endDateCol] : []),
    ...(previousPriceCol >= 0 ? [previousPriceCol] : []),
    ...(startDateCol >= 0 ? [startDateCol] : []),
  ];
  let priceCol = findCol(
    [/^por$/, /preco\s*por\b/, /\bpor\s*r\$/, /preco/, /oferta/, /promoc/, /valor/, /prvenda/, /futuro/, /amanha/],
    excludeForPrice
  );
  if (priceCol < 0 && headers.length > 2) {
    priceCol =
      [0, 1, 2, 3, 4, 5].find(i => i < headers.length && !excludeForPrice.includes(i)) ??
      ([0, 1, 2, 3].find(i => i !== f7Col && i !== descriptionCol) ?? 0);
  }
  const mapping: ColumnMapping = {
    f7Col: Math.max(0, f7Col),
    descriptionCol: Math.max(0, descriptionCol),
    priceCol: Math.max(0, priceCol),
  };
  if (previousPriceCol >= 0) mapping.previousPriceCol = previousPriceCol;
  if (startDateCol >= 0) mapping.startDateCol = startDateCol;
  if (endDateCol >= 0) mapping.endDateCol = endDateCol;
  return mapping;
}

export function parseExcelDateToIso(raw: string, referenceYear = new Date().getFullYear()): string {
  const cleaned = raw.trim();
  if (!cleaned) throw new Error('Data vazia');

  // 1. Formato ISO AAAA-MM-DD (ou com timestamp AAAA-MM-DDTHH:mm:ss)
  const isoMatch = cleaned.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    return validateYmd(year, month, day);
  }

  // 2. Formato Brasileiro DD/MM/AAAA, DD/MM/AA, DD-MM-AAAA, DD.MM.AAAA ou DD/MM
  const brMatch = cleaned.match(/^(\d{1,2})[/. -](\d{1,2})(?:[/. -](\d{2,4}))?(?:\s+.*)?$/);
  if (brMatch) {
    const day = Number(brMatch[1]);
    const month = Number(brMatch[2]);
    let year = referenceYear;
    if (brMatch[3]) {
      const yRaw = brMatch[3];
      year = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    }
    return validateYmd(year, month, day);
  }

  // 3. Número serial de data do Excel (ex.: 46321 ou 46321.5 -> dias desde 1899-12-30)
  if (/^\d{4,6}(?:\.\d+)?$/.test(cleaned)) {
    const serial = Math.floor(Number(cleaned));
    if (serial >= 30_000 && serial <= 80_000) {
      const excelEpochUtc = Date.UTC(1899, 11, 30);
      const dateUtc = new Date(excelEpochUtc + serial * 86_400_000);
      return validateYmd(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth() + 1, dateUtc.getUTCDate());
    }
  }

  throw new Error(`Data inválida ("${cleaned}")`);
}

function validateYmd(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Ano inválido (${year})`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Mês inválido (${month})`);
  }
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!Number.isInteger(day) || day < 1 || day > maxDay) {
    throw new Error(`Dia inválido (${day}/${month}/${year})`);
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatIsoDateShortBr(isoDate: string): string {
  const m = isoDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}`;
}

export function formatIsoDateFullBr(isoDate: string): string {
  const m = isoDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function applyValidityDateToLayerText(originalLayerText: string, endDateIso: string, startDateIso?: string | null): string {
  const cleanEnd = endDateIso.trim();
  const shortEnd = formatIsoDateShortBr(cleanEnd);
  const fullEnd = formatIsoDateFullBr(cleanEnd);
  const base = originalLayerText.trim();
  if (!base) {
    return `OFERTA VÁLIDA ATÉ ${shortEnd}`;
  }
  // Caso o texto original possua intervalo de datas (ex: "DE 10/10 A 25/10" ou "DE 10/10 ATÉ 25/10")
  const rangeRegex = /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(A|AT[EÉ])\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;
  if (startDateIso && rangeRegex.test(base)) {
    const shortStart = formatIsoDateShortBr(startDateIso);
    return base.replace(rangeRegex, (_, d1: string, sep: string, d2: string) => {
      const s1 = d1.length > 5 ? formatIsoDateFullBr(startDateIso) : shortStart;
      const s2 = d2.length > 5 ? fullEnd : shortEnd;
      return `${s1} ${sep} ${s2}`;
    });
  }
  // Caso o texto original contenha uma data DD/MM/AAAA ou DD/MM (ex: "OFERTA VÁLIDA ATÉ 25/10")
  const singleDateRegex = /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)(?!.*\b\d{1,2}\/\d{1,2})/;
  if (singleDateRegex.test(base)) {
    return base.replace(singleDateRegex, match => (match.length > 5 ? fullEnd : shortEnd));
  }
  return `${base} ${shortEnd}`.trim();
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
    const previousPriceRaw =
      mapping.previousPriceCol != null && mapping.previousPriceCol >= 0
        ? (row[mapping.previousPriceCol] ?? '').trim()
        : '';
    const startDateRaw = mapping.startDateCol != null && mapping.startDateCol >= 0 ? (row[mapping.startDateCol] ?? '').trim() : '';
    const endDateRaw = mapping.endDateCol != null && mapping.endDateCol >= 0 ? (row[mapping.endDateCol] ?? '').trim() : '';
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

    let previousPriceCents: number | null = null;
    if (previousPriceRaw) {
      try {
        previousPriceCents = parseExcelPriceToCents(previousPriceRaw);
      } catch {
        previousPriceCents = null;
      }
    }

    let startDateIso: string | null = null;
    if (startDateRaw) {
      try {
        startDateIso = parseExcelDateToIso(startDateRaw);
      } catch (err) {
        issues.push(`Data inicial inválida: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let endDateIso: string | null = null;
    if (endDateRaw) {
      try {
        endDateIso = parseExcelDateToIso(endDateRaw);
      } catch (err) {
        issues.push(`Data final inválida: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (startDateIso && endDateIso && startDateIso > endDateIso) {
      issues.push(`Data inicial (${startDateIso}) posterior à data final (${endDateIso})`);
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
      previousPriceRaw: previousPriceRaw || undefined,
      previousPriceCents,
      startDateRaw: startDateRaw || undefined,
      startDateIso,
      endDateRaw: endDateRaw || undefined,
      endDateIso,
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
