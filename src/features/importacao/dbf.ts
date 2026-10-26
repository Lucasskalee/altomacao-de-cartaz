import codepages from './oem-codepages.json';
import { getF7 } from '../cartazes/f7';
import type { DbfData, DbfEncoding, DbfProduct } from './types';

export const MAX_DBF_BYTES = 25 * 1024 * 1024;
const REQUIRED = ['CODPROD', 'DESCRICAO', 'PRVENDA', 'PRVENDA02', 'CODBAR'];
type Field = { name: string; type: string; length: number; decimals: number; offset: number };

/** Decimal half-up rounding without binary floating point arithmetic. Blank != zero. */
export function decimalToCents(text: string): { cents: number | null; rounded: boolean } {
  const value = text.trim();
  if (!value) return { cents: null, rounded: false };
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value) || /[^0-9.]/.test(value)) throw new Error('Preço inválido ou negativo.');
  const [whole, fraction = ''] = value.split('.');
  if (whole.length > 15 || fraction.length > 20) throw new Error('Preço fora do limite.');
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)) + (fraction.length > 2 && fraction[2] >= '5' ? 1n : 0n);
  if (cents > 99_999_999n) throw new Error('Preço excede R$ 999.999,99.');
  return { cents: Number(cents), rounded: /[1-9]/.test(fraction.slice(2)) };
}

function decoder(encoding: Exclude<DbfEncoding, 'auto'>): (bytes: Uint8Array) => string {
  if (encoding === 'cp850' || encoding === 'cp860' || encoding === 'cp437') {
    const table = codepages[encoding];
    return bytes => Array.from(bytes, byte => byte < 128 ? String.fromCharCode(byte) : table[byte - 128]).join('');
  }
  const textDecoder = new TextDecoder(encoding, { fatal: true });
  return bytes => textDecoder.decode(bytes);
}

export function parseDbf(bytes: Uint8Array, selection: DbfEncoding = 'auto'): DbfData {
  if (bytes.byteLength > MAX_DBF_BYTES) throw new Error('DBF excede o limite de 25 MB.');
  if (bytes.byteLength < 33) throw new Error('DBF inválido: cabeçalho incompleto.');
  if (![0x03, 0x83].includes(bytes[0])) throw new Error('Formato DBF não suportado. Esta versão lê dBASE III com campos de texto e numéricos.');
  if (bytes[15]) throw new Error('DBF criptografado não suportado.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true), header = view.getUint16(8, true), recordLength = view.getUint16(10, true);
  if (header < 33 || header > bytes.length || recordLength < 2 || count > 100_000 || header + count * recordLength > bytes.length) throw new Error('DBF inválido, truncado ou com mais de 100 mil registros.');
  for (let index = header + count * recordLength; index < bytes.length; index++) {
    if (bytes[index] !== 0 && bytes[index] !== 0x1a) throw new Error('DBF contém dados adicionais inconsistentes com a quantidade de registros.');
  }
  const fields = new Map<string, Field>();
  let offset = 1, cursor = 32;
  for (; cursor < header && bytes[cursor] !== 0x0d; cursor += 32) {
    if (cursor + 32 > header) throw new Error('Descritor de campo DBF incompleto.');
    const nameBytes = bytes.subarray(cursor, cursor + 11);
    const name = String.fromCharCode(...nameBytes).split('\0')[0].toUpperCase();
    const type = String.fromCharCode(bytes[cursor + 11]), length = bytes[cursor + 16], decimals = bytes[cursor + 17];
    if (!name || /[^A-Z0-9_]/.test(name) || fields.has(name) || length === 0 || offset + length > recordLength) throw new Error('DBF com campos inválidos, repetidos ou tamanhos inconsistentes.');
    fields.set(name, { name, type, length, decimals, offset }); offset += length;
  }
  if (cursor >= header || bytes[cursor] !== 0x0d || offset !== recordLength) throw new Error('DBF com terminador ou comprimento de registro inválido.');
  for (const key of REQUIRED) {
    const field = fields.get(key);
    if (!field) throw new Error(`Campo obrigatório ausente no DBF: ${key}.`);
    if (!['C', 'N', 'F'].includes(field.type) || field.decimals >= field.length || (['CODPROD', 'CODBAR'].includes(key) && field.decimals !== 0)) throw new Error(`Tipo de campo não suportado: ${key}.`);
  }
  const driver = bytes[29];
  const drivers: Record<number, Exclude<DbfEncoding, 'auto'>> = { 1:'cp437', 2:'cp850', 3:'windows-1252', 0x24:'cp860', 0x57:'windows-1252' };
  const encoding = selection === 'auto' ? drivers[driver] ?? 'cp850' : selection;
  const decode = decoder(encoding);
  const warnings: string[] = [];
  if (selection === 'auto' && !drivers[driver]) warnings.push(`Codificação não informada ou desconhecida (LDID ${driver}). Usando DOS CP850; confira os acentos e escolha outra codificação se necessário.`);
  if (fields.get('CODPROD')!.type !== 'C') warnings.push('CODPROD é numérico no DBF: códigos são lidos como texto, sem acrescentar zeros ausentes. A comparação F7 é exata.');
  let deleted = 0, invalidRecords = 0, roundedPrices = 0;
  const products: DbfProduct[] = [];
  const codes = new Set<string>();
  for (let row = 0; row < count; row++) {
    const start = header + row * recordLength;
    if (bytes[start] === 0x2a) { deleted++; continue; }
    if (bytes[start] !== 0x20) throw new Error(`Marcador de registro inválido na linha ${row + 1}.`);
    const issues: string[] = [];
    const read = (key: string) => {
      const field = fields.get(key)!;
      try { return decode(bytes.subarray(start + field.offset, start + field.offset + field.length)).replace(/\0+$/g, '').trim(); }
      catch { issues.push(`Codificação inválida em ${key}`); return ''; }
    };
    const code = read('CODPROD'), f7 = getF7(code), description = read('DESCRICAO');
    const referenceRaw = read('PRVENDA'), alternativeRaw = read('PRVENDA02'), barcodeRaw = read('CODBAR');
    if (!f7) issues.push(code ? 'F7 contém caracteres não numéricos' : 'F7 vazio');
    if (!description) issues.push('Descrição vazia');
    if (barcodeRaw && !getF7(barcodeRaw)) issues.push('Código de barras não numérico');
    const money = (value: string, key: string) => {
      try { const result = decimalToCents(value); if (result.rounded) roundedPrices++; return result.cents; }
      catch (error) { issues.push(`${key}: ${String(error)}`); return null; }
    };
    const priceCents = money(referenceRaw, 'PRVENDA'), alternativeCents = money(alternativeRaw, 'PRVENDA02');
    if (priceCents === null && !referenceRaw) issues.push('PRVENDA vazio');
    if (f7) codes.add(f7);
    if (issues.length) invalidRecords++;
    products.push({ record: row + 1, codeRaw: code, f7, description, priceCents, alternativeCents, barcode: barcodeRaw || null, referenceRaw, alternativeRaw, issues });
  }
  if (roundedPrices) warnings.push(`${roundedPrices} valor(es) com frações de centavo foram arredondados para comparação (metade para cima). Os valores originais continuam visíveis nos detalhes.`);
  return { recordsDeclared: count, recordsRead: count - deleted, deleted, productsIdentified: codes.size, invalidRecords, roundedPrices, encoding, languageDriver: driver, warnings, products };
}
