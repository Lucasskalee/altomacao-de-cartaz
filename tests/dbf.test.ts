import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseDbf, decimalToCents, MAX_DBF_BYTES } from '../src/features/importacao/dbf';
import { comparePrices } from '../src/features/importacao/comparison';
import { createDocument, duplicate } from '../src/features/cartazes/serialization';
import type { IndexedCartaz } from '../src/features/cartazes/f7';
import type { DbfProduct } from '../src/features/importacao/types';

type Row = { code?: string; description?: string; price?: string; alternative?: string; barcode?: string; deleted?: boolean };
function fixture(rows: Row[] = [{}], driver = 0): Uint8Array {
  const fields = [ ['CODPROD', 'N', 6, 0], ['DESCRICAO', 'C', 35, 0], ['PRVENDA', 'N', 12, 3], ['PRVENDA02', 'N', 12, 3], ['CODBAR', 'N', 14, 0] ] as const;
  const header = 32 + fields.length * 32 + 1, length = 1 + fields.reduce((sum,field) => sum + field[2],0);
  const bytes = new Uint8Array(header + rows.length * length + 1); bytes.fill(0);
  const view = new DataView(bytes.buffer); bytes[0]=3; bytes[29]=driver;
  view.setUint32(4, rows.length,true); view.setUint16(8,header,true); view.setUint16(10,length,true);
  fields.forEach(([name,type,size,decimals],i) => { const offset=32+i*32; bytes.set(Buffer.from(name,'ascii'),offset); bytes[offset+11]=type.charCodeAt(0); bytes[offset+16]=size; bytes[offset+17]=decimals; });
  bytes[header-1]=13;
  rows.forEach((row,i) => {
    const values = [row.code ?? '001245',row.description ?? 'REPOLHO VERDE',row.price ?? '2.890',row.alternative ?? '3.490',row.barcode ?? '00012345678901'];
    let offset=header+i*length; bytes[offset++]=row.deleted?42:32;
    fields.forEach((field,index) => { const value=Buffer.from(values[index],'latin1'); bytes.fill(32,offset,offset+field[2]); bytes.set(value.subarray(0,field[2]),offset+(field[1]==='N'?field[2]-Math.min(value.length,field[2]):0)); offset+=field[2]; });
  });
  bytes[bytes.length-1]=26; return bytes;
}
function poster(code: string, price: number, path = 'Hortifruti/a.skcartaz'): IndexedCartaz {
  const document=createDocument(); document.product.productCode=code; document.product.priceCents=price;
  return {path,fileName:path,document};
}

test('DBF dBASE III: mapeia cinco campos, preserva códigos e lê preços de três casas', () => {
  const data=parseDbf(fixture());
  assert.equal(data.recordsRead,1); assert.equal(data.productsIdentified,1);
  assert.equal(data.products[0].f7,'001245'); assert.equal(data.products[0].barcode,'00012345678901');
  assert.equal(data.products[0].priceCents,289); assert.equal(data.products[0].alternativeCents,349);
  assert.equal(data.products[0].referenceRaw,'2.890'); assert.equal(data.encoding,'cp850');
  assert.ok(data.warnings.some(warning=>warning.includes('Codificação')));
});
test('preços usam aritmética decimal, arredondamento metade para cima e branco distinto de zero', () => {
  for (const [value,cents] of [['2.890',289],['3.495',350],['1.005',101],['0.009',1],['0',0],['999999.994',99999999]]) assert.equal(decimalToCents(String(value)).cents,cents);
  assert.equal(decimalToCents('').cents,null); assert.equal(decimalToCents('  ').cents,null);
  assert.equal(decimalToCents('2.890').rounded,false); assert.equal(decimalToCents('2.891').rounded,true);
  for (const value of ['-1','NaN','Infinity','2,89','1e3','999999.995','1.2.3','2.89\nX']) assert.throws(()=>decimalToCents(value));
});
test('registros excluídos são ignorados; F7 e preços vazios/inválidos geram diagnóstico sem virar zero', () => {
  const data=parseDbf(fixture([{deleted:true,price:'INVALID'},{code:'',price:'',alternative:''},{code:'ABC',price:'-3.99'},{price:'0',alternative:''}]));
  assert.equal(data.recordsDeclared,4); assert.equal(data.deleted,1); assert.equal(data.recordsRead,3);
  assert.equal(data.products[0].priceCents,null); assert.equal(data.products[2].priceCents,0);
  assert.equal(data.products[2].alternativeCents,null); assert.equal(data.invalidRecords,2);
});
test('codificações CP850/CP860/CP437, Windows-1252 e UTF-8 têm tratamento explícito', () => {
  const data=parseDbf(fixture([{description:'P\xC3O'}],3)); assert.equal(data.products[0].description,'PÃO');
  assert.equal(parseDbf(fixture([{description:'P\xC7O'}]),'cp850').products[0].description,'PÃO');
  assert.equal(parseDbf(fixture([{description:'P\x8EO'}]),'cp860').products[0].description,'PÃO');
  assert.equal(parseDbf(fixture([{description:'CAF\x82'}],1)).products[0].description,'CAFé');
  assert.ok(parseDbf(fixture([{description:'P\xC3O'}]),'utf-8').products[0].issues.some(issue=>issue.includes('Codificação')));
});
test('DBF inválido, truncado, versão desconhecida e descritores incorretos são recusados', () => {
  assert.throws(()=>parseDbf(new Uint8Array(2))); assert.throws(()=>parseDbf(new Uint8Array(MAX_DBF_BYTES+1)));
  const broken: ((bytes:Uint8Array)=>void)[] = [b=>b[0]=0x30,b=>b[15]=1,b=>b[32]=0,b=>b[48]=0,b=>b[49]=20,b=>b[32+11]=77,b=>b[new DataView(b.buffer).getUint16(8,true)-1]=0,b=>b[new DataView(b.buffer).getUint16(8,true)]=0];
  for (const mutate of broken) { const bytes=fixture(); mutate(bytes); assert.throws(()=>parseDbf(bytes)); }
  assert.throws(()=>parseDbf(fixture().slice(0,-10)));
  const missing=fixture(); missing.set(Buffer.from('OUTRO\0\0','ascii'),32); assert.throws(()=>parseDbf(missing));
  const duplicate=fixture(); duplicate.set(Buffer.from('CODPROD\0','ascii'),64); assert.throws(()=>parseDbf(duplicate));
  const count=fixture(); new DataView(count.buffer).setUint32(4,100001,true); assert.throws(()=>parseDbf(count));
});
test('comparação exata por F7 retorna todos os cartazes, igual/alterado/sem cartaz, sem modificar dados', () => {
  const source=parseDbf(fixture([{price:'3.490'}])).products;
  const library=[poster('001245',289),poster('001245',349,'Ofertas/b.skcartaz'),poster('1245',349,'outro.skcartaz')];
  const before=JSON.stringify({source,library});
  const rows=comparePrices(source,library);
  assert.equal(rows.length,2); assert.deepEqual(rows.map(row=>row.status),['Alterado','Igual']);
  assert.equal(new Set(rows.map(row=>row.cartazId)).size,2);
  assert.equal(comparePrices(source,[poster('1245',349)])[0].status,'Sem cartaz');
  assert.equal(JSON.stringify({source,library}),before);
});
test('duplicatas idênticas agrupam; preços, descrição, barcode ou preço alternativo diferentes geram conflito', () => {
  const identical=parseDbf(fixture([{},{}])).products;
  assert.equal(comparePrices(identical,[]).length,1); assert.equal(comparePrices(identical,[])[0].occurrences,2);
  for (const changed of [{price:'3.490'},{alternative:'4.990'},{description:'OUTRO PRODUTO'},{barcode:'123'}]) {
    const products=parseDbf(fixture([{},changed])).products;
    const rows=comparePrices(products,[poster('001245',289),poster('001245',349,'b.skcartaz')]);
    assert.equal(rows.length,4); assert.ok(rows.every(row=>row.status==='Conflito no DBF'));
  }
  const subCent=parseDbf(fixture([{price:'2.891'},{price:'2.892'}])).products;
  assert.ok(comparePrices(subCent,[]).every(row=>row.conflicting));
});
test('dados vazios e inválidos nunca são classificados como preço igual ou sem cartaz', () => {
  const products=parseDbf(fixture([{price:''},{code:'ABC',description:''}])).products;
  assert.ok(comparePrices(products,[]).every(row=>row.status==='Dados inválidos'));
});
test('consulta01.dbf real: leitura completa, comparação e integridade do arquivo original', {skip:!existsSync('consulta01.dbf')}, t => {
  const original=readFileSync('consulta01.dbf'); const hash=createHash('sha256').update(original).digest('hex');
  const data=parseDbf(original);
  assert.equal(data.recordsDeclared,37218); assert.equal(data.recordsRead,37218); assert.equal(data.deleted,0);
  const first = data.products[0];
  assert.ok(first.f7 && /^[0-9]+$/.test(first.f7)); assert.ok(Number.isSafeInteger(first.priceCents));
  assert.ok(first.barcode && /^[0-9]+$/.test(first.barcode));
  const library=[poster(first.f7!,first.priceCents!),poster(first.f7!,first.priceCents!+100,'outra-pasta/b.skcartaz')];
  const rows=comparePrices(data.products,library);
  assert.ok(rows.some(row=>row.product.f7===first.f7&&row.priceStatus==='Igual'));
  assert.ok(rows.some(row=>row.product.f7===first.f7&&row.priceStatus==='Alterado'));
  assert.equal(createHash('sha256').update(readFileSync('consulta01.dbf')).digest('hex'),hash);
  t.diagnostic(JSON.stringify({bytes:original.length,records:data.recordsRead,products:data.productsIdentified,invalid:data.invalidRecords,roundedPrices:data.roundedPrices,conflictingCodes:new Set(rows.filter(row=>row.conflicting).map(row=>row.product.f7)).size,sha256:hash}));
});
