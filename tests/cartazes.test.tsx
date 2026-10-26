import { test } from 'node:test';
import './dbf.test';
import assert from 'node:assert/strict';
import { createDocument, duplicate, serialize, deserialize } from '../src/features/cartazes/serialization';
import { priceToCents, fileName } from '../src/features/cartazes/validation';
import { renderToStaticMarkup } from 'react-dom/server';
import { PosterView } from '../src/components/editor/PosterView';
import { digitsOnly, getF7, indexCartazes, findCartazesByF7, matchesCartazSearch, withoutF7 } from '../src/features/cartazes/f7';
import { posterFromDocument } from '../src/features/cartazes/presentation';
import { exportPng } from '../src/components/editor/exportPng';
import { F7Field } from '../src/components/editor/F7Field';
import { Library } from '../src/components/library/Library';
import type { Entry } from '../src/features/cartazes/types';
import * as storage from '../src/features/cartazes/storage';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
test('Repolho Verde: serializar, reabrir, editar preço e manter identidade', () => {
  const initial = createDocument();
  const reopened = deserialize(serialize(initial));
  assert.equal(reopened.product.priceCents,289);
  reopened.product.priceCents = priceToCents('3,49');
  const updated = deserialize(serialize(reopened));
  assert.equal(updated.product.priceCents,349);
  assert.equal(updated.id, initial.id);
  assert.equal(updated.metadata.createdAt, initial.metadata.createdAt);
});
test('duplicar mantém original intacto e cria outra identidade', () => {
  const initial = createDocument(); const copy = duplicate(initial);
  copy.product.priceCents = 349;
  assert.notEqual(copy.id,initial.id); assert.equal(initial.product.priceCents,289);
});
test('preserva informações adicionais e código do produto', () => {
  const d = createDocument(); d.product.productCode = '000123'; d.product.extra = 'texto'; d.extra = { note: 'observação' };
  assert.deepEqual(deserialize(serialize(d)),d);
});
test('valores monetários em centavos sem arredondamento binário', () => {
  for (const [input, cents] of [['2,89',289],['3.49',349],['0,01',1],['10',1000],['1,1',110]]) assert.equal(priceToCents(String(input)),cents);
  for (const input of ['-1','2,899','2,3,4','NaN','Infinity','','1e5']) assert.throws(() => priceToCents(input));
});
test('rejeita JSON corrompido, versão futura, campos inválidos e documentos grandes', () => {
  for (const s of ['{','null','<script>','{}', 'x'.repeat(1_048_577)]) assert.throws(() => deserialize(s));
  for (const mutate of [(d:any) => d.schemaVersion=2,(d:any) => d.product.priceCents=2.89,(d:any) => d.product.priceCents=-1,(d:any) => d.product.name='',(d:any) => d.product.unit=null,(d:any) => d.metadata.updatedAt='ontem',(d:any) => d.layout.paper='A4']) {
    const d = createDocument(); mutate(d); assert.throws(() => deserialize(JSON.stringify(d)));
  }
});
test('nome sugerido seguro e extensão própria', () => {
  assert.equal(fileName('Maçã Fuji'),'maca-fuji.skcartaz');
  assert.equal(fileName('../../'),'cartaz.skcartaz');
});
test('prévia/impressão recebem dados do documento e escapam conteúdo', () => {
  const d = createDocument(); d.product.name='<script>alert(1)</script>';
  const html = renderToStaticMarkup(<PosterView poster={{name:d.product.name,detail:d.product.complement,price:(d.product.priceCents/100).toFixed(2),unit:d.product.unit}}/>);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(html.includes('VERDE')); assert.ok(html.includes('89')); assert.ok(html.includes('KG'));
});

test('F7 é string, aceita digitação/colagem só de dígitos e preserva zeros sem tamanho fixo', () => {
  assert.equal(digitsOnly('001245'), '001245');
  assert.equal(digitsOnly(' 00.12-45\r\nABC'), '001245');
  assert.equal(digitsOnly(''), '');
  assert.equal(getF7('001245'), '001245');
  for (const code of [1245, null, undefined, '', 'A001', ' 001245', '001245\n', '001245\r\n', '１２３']) assert.equal(getF7(code), null);
  const d = createDocument(); d.product.productCode = '0'.repeat(150) + '1245';
  assert.equal(deserialize(serialize(d)).product.productCode, d.product.productCode);
  const html = renderToStaticMarkup(<F7Field value="001245" matches={[]} checking={false} error="" onChange={() => {}} onRefresh={() => {}}/>);
  assert.ok(html.includes('value="001245"')); assert.ok(html.includes('type="text"'));
  assert.ok(html.includes('inputMode="numeric"')); assert.ok(!html.includes('maxLength'));
});

test('abre documentos antigos sem campo, com null/vazio ou código legado e preserva dados', () => {
  const d = createDocument(); delete d.product.productCode;
  d.product.extra = 'preservar';
  const missing = deserialize(JSON.stringify(d));
  assert.equal(missing.product.productCode, undefined);
  assert.deepEqual(deserialize(serialize(missing)), d);
  for (const value of [null, '', 'ABC-001']) {
    d.product.productCode = value;
    assert.deepEqual(deserialize(serialize(d)), d);
  }
  const invalid = {...d, product: {...d.product, productCode: 1245}};
  assert.throws(() => deserialize(JSON.stringify(invalid)));
});

function f7Entries(): Entry[] {
  const a = createDocument(); a.product.productCode = '001245';
  const b = duplicate(a); b.product.priceCents = 349;
  const c = createDocument(); delete c.product.productCode;
  const d = createDocument(); d.product.productCode = '1245'; d.product.name = 'OUTRO';
  return [
    {path:'C:/Biblioteca/Hortifruti/a.skcartaz', name:'a.skcartaz', folder:false, content:serialize(a)},
    {path:'C:/Biblioteca/Promocoes/Subpasta/b.skcartaz', name:'b.skcartaz', folder:false, content:serialize(b)},
    {path:'C:/Biblioteca/antigo.skcartaz', name:'antigo.skcartaz', folder:false, content:serialize(c)},
    {path:'C:/Biblioteca/outro.skcartaz', name:'outro.skcartaz', folder:false, content:serialize(d)},
    {path:'C:/Biblioteca/erro.skcartaz', name:'erro.skcartaz', folder:false, content:'{'},
    {path:'C:/Biblioteca/Pasta', name:'Pasta', folder:true},
  ];
}

test('consulta F7 retorna todos os caminhos, UUIDs e preços sem colapsar cartazes', () => {
  const entries = f7Entries(); const index = indexCartazes(entries);
  const matches = findCartazesByF7('001245', index);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map(item => item.document.product.priceCents), [289,349]);
  assert.notEqual(matches[0].document.id, matches[1].document.id);
  assert.ok(matches[1].path.includes('Subpasta'));
  assert.equal(findCartazesByF7('1245', index).length, 1);
  for (const code of ['', 'ABC', ' 001245', '000001245']) assert.equal(findCartazesByF7(code,index).length,0);
  // Copies made outside the app can share UUID: each physical file still counts.
  assert.equal(findCartazesByF7('001245',[matches[0],{...matches[0],path:'C:/copia.skcartaz'}]).length,2);
  assert.equal(indexCartazes(entries).length,4);
});

test('pesquisa por nome/F7 e filtro sem código usam todas as pastas', () => {
  const index = indexCartazes(f7Entries());
  assert.equal(index.filter(item => matchesCartazSearch(item,'001245')).length,2);
  assert.equal(index.filter(item => matchesCartazSearch(item,'repolho')).length,3);
  assert.equal(index.filter(item => matchesCartazSearch(item,'  verde ')).length,4);
  assert.deepEqual(withoutF7(index).map(item => item.fileName),['antigo.skcartaz']);
  const legacy = createDocument(); legacy.product.productCode='LEGADO';
  assert.equal(withoutF7([{path:'antigo',fileName:'antigo',document:legacy}]).length,1);
});

test('alterar F7 e duplicar não modifica preço/layout e mantém identidades independentes', () => {
  const d = createDocument(); const baseline = structuredClone(d);
  d.product.productCode = digitsOnly('001245');
  const reopened = deserialize(serialize(d));
  assert.equal(reopened.product.productCode,'001245');
  assert.equal(reopened.id,baseline.id); assert.deepEqual(reopened.layout,baseline.layout);
  assert.equal(reopened.product.priceCents,baseline.product.priceCents);
  const copy = duplicate(reopened);
  assert.notEqual(copy.id,reopened.id); assert.equal(copy.product.productCode,reopened.product.productCode);
});

test('biblioteca mostra F7/sem F7 e alerta duplicidades permite continuar', () => {
  const html = renderToStaticMarkup(<Library data={{root:'C:/Biblioteca',entries:f7Entries()}} open={async () => {}} newDocument={async () => {}} run={() => {}} refresh={async () => {}} relocated={() => {}} removed={() => {}}/>);
  assert.ok(html.includes('Sem F7')); assert.ok(html.includes('F7: 1245'));
  assert.ok(html.includes('Somente cartazes sem F7')); assert.ok(html.includes('nome ou F7'));
  const matches = findCartazesByF7('001245',indexCartazes(f7Entries()));
  const warning = renderToStaticMarkup(<F7Field value="001245" matches={matches} checking={false} error="" onChange={() => {}} onRefresh={() => {}}/>);
  assert.ok(warning.includes('2 outro(s)')); assert.ok(warning.includes('continuar e salvar normalmente'));
  assert.ok(warning.includes('Hortifruti')); assert.ok(warning.includes('Subpasta'));
  assert.ok(!warning.includes('disabled'));
});

test('F7 não altera markup de prévia/impressão nem comandos de desenho/exportação PNG', () => {
  const d = createDocument();
  const before = posterFromDocument(d);
  d.product.productCode = '001245';
  const after = posterFromDocument(d);
  assert.deepEqual(after,before);
  assert.equal(renderToStaticMarkup(<PosterView poster={before}/>),renderToStaticMarkup(<PosterView poster={after}/>));
  const drawing: unknown[][] = [];
  const ctx = { fillRect: (...args: unknown[]) => drawing.push(['rect',...args]), fillText: (...args: unknown[]) => drawing.push(['text',...args]), measureText: () => ({width:1}) };
  const canvas = {width:0,height:0,getContext:() => ctx,toDataURL:(type:string) => { assert.equal(type,'image/png'); return 'data:image/png;base64,test'; }};
  const anchor = {download:'',href:'',click:() => drawing.push(['download',anchor.download])};
  const descriptor = Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string) => tag === 'canvas' ? canvas : anchor}});
  try {
    exportPng(before); const originalDraw = structuredClone(drawing); drawing.length=0;
    exportPng(after); assert.deepEqual(drawing,originalDraw);
    assert.equal(canvas.width,1748); assert.equal(canvas.height,2480);
    assert.ok(!JSON.stringify(drawing).includes('001245'));
  } finally {
    if (descriptor) Object.defineProperty(globalThis,'document',descriptor); else Reflect.deleteProperty(globalThis,'document');
  }
});

test('serviços locais salvam/reabrem e consultam F7 sem rede (IPC simulado)', async t => {
  const descriptors = ['window','isTauri'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  Object.defineProperty(globalThis,'window',{configurable:true,value:{crypto:globalThis.crypto}});
  Object.defineProperty(globalThis,'isTauri',{configurable:true,value:true});
  t.mock.method(globalThis,'fetch',() => { throw new Error('Rede desligada'); });
  const disk = new Map<string,string>();
  const actions: string[] = [];
  mockIPC((cmd,args:any) => {
    assert.equal(cmd,'files'); const r=args.request; actions.push(r.action);
    if(r.action === 'save') { disk.set(r.path,r.content); return r.path; }
    if(r.action === 'read') return disk.get(r.path);
    if(r.action === 'list') return {root:'C:/Biblioteca',entries:[...disk].map(([path,content]) => ({path,content,name:path,folder:false}))};
    throw new Error('Operação inesperada');
  });
  try {
    const doc = createDocument(); doc.product.productCode='001245';
    await storage.saveDocument('C:/Biblioteca/Hortifruti/a.skcartaz',doc);
    const reopened = await storage.openDocument('C:/Biblioteca/Hortifruti/a.skcartaz');
    assert.equal(reopened.product.productCode,'001245');
    const copy = duplicate(reopened); copy.product.priceCents=349;
    await storage.saveDocument('C:/Biblioteca/Ofertas/b.skcartaz',copy);
    const before = [...disk];
    const matches = await storage.findCartazesByF7('001245');
    assert.equal(matches.length,2); assert.deepEqual(matches.map(item => item.document.product.priceCents),[289,349]);
    assert.deepEqual([...disk],before); assert.equal(actions.at(-1),'list');
  } finally {
    clearMocks();
    for(const [key,descriptor] of descriptors) { if(descriptor) Object.defineProperty(globalThis,key,descriptor); else Reflect.deleteProperty(globalThis,key); }
  }
});
