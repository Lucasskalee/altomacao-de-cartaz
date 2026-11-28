import { test } from 'node:test';
import './dbf.test';
import './updates.test';
import './offers.test';
import './scantech.test';
import './conductor.test';
import './formatos.test';
import './history.test';
import './filtros.test';
import './textAdjustment.test';
import './visualFidelity.test';
import './psdColorDepth.test';
import assert from 'node:assert/strict';
import { createDocument, duplicate, serialize, deserialize } from '../src/features/cartazes/serialization';
import { priceToCents, fileName, MAX_DOCUMENT_CHARS } from '../src/features/cartazes/validation';
import { renderToStaticMarkup } from 'react-dom/server';
import { PosterView } from '../src/components/editor/PosterView';
import { digitsOnly, getF7, indexCartazes, findCartazesByF7, matchesCartazSearch, withoutF7 } from '../src/features/cartazes/f7';
import { posterFromDocument } from '../src/features/cartazes/presentation';
import { exportPng, computePngDimensionsPx } from '../src/components/editor/exportPng';
import { applyProductFieldChange } from '../src/hooks/useCartaz';
import { F7Field } from '../src/components/editor/F7Field';
import { Library } from '../src/components/library/Library';
import type { Entry } from '../src/features/cartazes/types';
import * as storage from '../src/features/cartazes/storage';
import { drawImported, importedPriceWarning } from '../src/components/editor/importedRenderer';
import { analyzePsd, buildArtwork, extractMetadata, extractPriceFromRoles, type PsdAnalysis } from '../src/features/psd/importer';
import { prepareLinkedArtwork, prepareLinkedArtworkAutomatically, suggestLinkedArtworkMapping } from '../src/features/psd/editLinkedArtwork';
import { initializeCanvas } from 'ag-psd';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ImportedArtwork } from '../src/features/cartazes/types';

const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('PSD legado: sugere textos reais e preserva os mapeamentos já editados', () => {
  const document = createDocument();
  document.product.name = 'DESCRICAO COMPLETA DO PRODUTO';
  document.layout = { template: 'imported-psd', paper: 'A5', orientation: 'portrait', artwork: importedArtwork() };
  const analysis: PsdAnalysis = {
    fileName: 'repolho.psd', hash: 'a'.repeat(64), width: 886, height: 1240, resolutionPpi: 150,
    originalPreview: pixel,
    layers: [
      { id: '1', name: 'MARCA', type: 'text', visible: true, depth: 0, text: 'MARCA ORIGINAL', font: 'Brush Hand New', bounds: { left: 100, top: 300, right: 600, bottom: 400 } },
      { id: '6', name: '2', type: 'text', visible: true, depth: 0, text: '2', font: 'Zullia', bounds: { left: 121, top: 606, right: 422, bottom: 1036 } },
    ],
    suggested: {}, metadata: { name: '', complement: '', unit: '', price: '', validityText: '' },
    warnings: [], psd: { width: 886, height: 1240 }, runtime: new Map(),
  };
  const suggested = suggestLinkedArtworkMapping(document, analysis);
  assert.equal(suggested.roles.title, '1');
  assert.equal(suggested.texts.title, 'MARCA ORIGINAL');
  assert.notEqual(suggested.texts.title, document.product.name);
  if (document.layout.template !== 'imported-psd') throw new Error('PSD esperado.');
  document.layout.artwork.templateParts = [{ role: 'title', layerId: '1', bounds: analysis.layers[0].bounds, color: '#000000' }];
  document.product.name = 'MARCA EDITADA';
  assert.equal(suggestLinkedArtworkMapping(document, analysis).texts.title, 'MARCA EDITADA');
  assert.throws(() => suggestLinkedArtworkMapping(document, { ...analysis, hash: 'b'.repeat(64) }), /não corresponde/);
  document.layout.artwork.templateParts = [];
  assert.throws(() => prepareLinkedArtworkAutomatically(document, { ...analysis, layers: [] }), /camada de nome ou marca/);
});

test('PSD vinculado: prepara camada de sabor sem alterar o arquivo, F7 ou preço', {
  skip: !process.env.SKALEE_TEST_PSD,
}, async () => {
  const drawn: unknown[] = [];
  const printedText: string[] = [];
  const fakeCanvas = (w = 1179, h = 1770): any => ({
    width: w, height: h,
    getContext: () => ({
      clearRect() {}, fillRect() {}, save() {}, restore() {}, putImageData() {},
      translate() {}, scale() {}, transform() {}, strokeText() {},
      fillText(text: string) { printedText.push(text); },
      measureText(text: string) { return { width: text.length * 25 }; },
      drawImage(source: unknown) { drawn.push(source); },
      getImageData: (_x: number, _y: number, cw: number, ch: number) => ({
        data: new Uint8ClampedArray(cw * ch * 4), width: cw, height: ch,
      }),
    }),
    toDataURL: () => pixel,
  });
  initializeCanvas(fakeCanvas, (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h } as any));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => fakeCanvas() } });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    },
  });
  try {
    const raw = readFileSync(process.env.SKALEE_TEST_PSD!);
    const hash = createHash('sha256').update(raw).digest('hex');
    const analysis = await analyzePsd(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'farofa.psd');
    const document = createDocument();
    document.product = { name: 'FAROFA DONANA 400G CALABRESA', complement: '', unit: 'UN', productCode: '21707', priceCents: 699 };
    document.layout = { template: 'imported-psd', paper: 'A5', orientation: 'portrait', artwork: buildArtwork(analysis, analysis.suggested) };
    const texts = { category: '', title: '', complement: 'CALABRESA', packaging: '' };
    drawn.length = 0;
    const updated = prepareLinkedArtwork(document, analysis, { complement: '4' }, texts);
    assert.equal(updated.product.complement, 'CALABRESA');
    assert.equal(updated.product.productCode, '21707');
    assert.equal(updated.product.priceCents, 699);
    assert.equal(document.product.complement, '');
    assert.equal(updated.layout.template, 'imported-psd');
    if (updated.layout.template !== 'imported-psd') throw new Error('Arte PSD esperada.');
    assert.equal(updated.layout.artwork.templateParts?.[0].originalText, 'BACON');
    assert.equal(drawn.includes(analysis.runtime.get('4')?.canvas), false);
    assert.equal(drawn.includes(analysis.runtime.get('10')?.canvas), true);
    await drawImported(fakeCanvas(), updated.layout.artwork, '6,99', 1179, 1770, undefined, { complement: updated.product.complement });
    assert.ok(printedText.includes('CALABRESA'));
    assert.ok(!printedText.includes('BACON'));
    assert.throws(() => prepareLinkedArtwork(document, { ...analysis, hash: '0'.repeat(64) }, { complement: '4' }, texts), /não é o arquivo/);
    assert.throws(() => prepareLinkedArtwork(document, analysis, { title: '4', complement: '4' }, texts), /camada diferente/);
    assert.equal(createHash('sha256').update(readFileSync(process.env.SKALEE_TEST_PSD!)).digest('hex'), hash);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
    if (imageDescriptor) Object.defineProperty(globalThis, 'Image', imageDescriptor);
    else Reflect.deleteProperty(globalThis, 'Image');
  }
});
function importedArtwork():ImportedArtwork{return {kind:'imported-psd',compatibility:'ready',source:{fileName:'repolho verde kg.psd',sha256:'a'.repeat(64)},canvas:{width:886,height:1240,resolutionPpi:150,fit:'contain'},staticBackground:pixel,originalPreview:pixel,priceParts:[{role:'whole',layerId:'6',bounds:{left:121,top:606,right:422,bottom:1036},fontFamily:'Zullia',color:'#c74624'},{role:'fraction',layerId:'15',bounds:{left:422,top:602,right:719,bottom:847},fontFamily:'Zullia',color:'#c74624'},{role:'decimal',layerId:'14',bounds:{left:432,top:897,right:492,bottom:963},fontFamily:'Zullia',color:'#c74624'},{role:'fractionRule',layerId:'22',bounds:{left:437,top:865,right:696,bottom:883},color:'#c74624'}],layers:[{id:'6',name:'2',type:'text',visible:true,depth:0,text:'2',font:'Zullia',bounds:{left:121,top:606,right:422,bottom:1036}}],warnings:[]};}
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
test('cartaz PSD é autocontido, preserva F7/zeros e duplica com outro UUID',()=>{
  const d=createDocument();d.product.productCode='001245';d.product.priceCents=299;d.layout={template:'imported-psd',paper:'A5',orientation:'portrait',artwork:importedArtwork()};
  const reopened=deserialize(serialize(d));assert.equal(reopened.layout.template,'imported-psd');assert.equal(reopened.product.productCode,'001245');
  assert.equal((reopened.layout as any).artwork.source.fileName,'repolho verde kg.psd');assert.ok(serialize(reopened).includes(pixel));
  const copy=duplicate(reopened);assert.notEqual(copy.id,reopened.id);assert.deepEqual(copy.layout,reopened.layout);
});
test('compositor PSD recebe somente preço e não projeta F7 na saída',()=>{
  const d=createDocument();d.product.productCode='001245';d.product.priceCents=349;d.layout={template:'imported-psd',paper:'A5',orientation:'portrait',artwork:importedArtwork()};
  const poster=posterFromDocument(d);assert.equal(poster.price,'3,49');assert.equal(poster.artwork?.source.fileName,'repolho verde kg.psd');assert.ok(!JSON.stringify(poster).includes('001245'));
  assert.equal(importedPriceWarning(importedArtwork(),'2,99'),'');
  assert.equal(importedPriceWarning(importedArtwork(),'3,49'),'');
  assert.equal(importedPriceWarning(importedArtwork(),'12,99'),'');
  assert.ok(importedPriceWarning(importedArtwork(),'129,90'));
  assert.ok(importedPriceWarning(importedArtwork(),'123456,78'));
  const html=renderToStaticMarkup(<PosterView poster={poster}/>);assert.ok(html.includes('canvas'));assert.ok(!html.includes('001245'));
});
test('extração de metadados PSD não inventa preço fictício quando não reconhecido',()=>{
  const layers=importedArtwork().layers;
  assert.equal(extractPriceFromRoles(layers,{whole:'6'}),'');
  const unknown=extractMetadata([{id:'1',name:'Camada',type:'raster',visible:true,depth:0,bounds:{left:0,top:0,right:10,bottom:10}}],{});
  assert.deepEqual(unknown,{name:'',complement:'',unit:'',price:'',validityText:''});
});
test('repolho verde kg.psd real: análise de 26 camadas, extração 2,99, alteração 3,49, F7 e integridade', {skip:!existsSync('repolho verde kg.psd')}, async () => {
  const fakeCanvas = (w = 886, h = 1240): any => ({
    width: w, height: h,
    getContext: () => ({ clearRect(){}, save(){}, restore(){}, drawImage(){}, putImageData(){}, getImageData: (_x:number,_y:number,cw:number,ch:number) => ({data:new Uint8ClampedArray(cw*ch*4),width:cw,height:ch}) }),
    toDataURL: () => pixel,
  });
  initializeCanvas(fakeCanvas, (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h } as any));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => fakeCanvas() } });
  try {
    const raw = readFileSync('repolho verde kg.psd');
    const hashBefore = createHash('sha256').update(raw).digest('hex');
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const analysis = await analyzePsd(buffer, 'repolho verde kg.psd');
    assert.equal(analysis.hash, hashBefore);
    assert.equal(analysis.width, 886); assert.equal(analysis.height, 1240);
    assert.equal(analysis.layers.length, 26);
    assert.deepEqual(analysis.suggested, { whole: '7', fraction: '15', decimal: '14', fractionRule: '22', validity: undefined });
    assert.deepEqual(analysis.metadata, { name: 'REPOLHO', complement: 'VERDE', unit: 'KG', price: '2,99', validityText: '' });
    const artwork = buildArtwork(analysis, analysis.suggested);
    assert.equal(artwork.compatibility, 'ready');
    const doc = createDocument();
    doc.product = { ...doc.product, name: analysis.metadata.name, complement: analysis.metadata.complement, unit: analysis.metadata.unit, productCode: '001245', priceCents: priceToCents('3,49') };
    doc.layout = { template: 'imported-psd', paper: 'A5', orientation: 'portrait', artwork };
    const reopened = deserialize(serialize(doc));
    assert.equal(reopened.product.priceCents, 349);
    assert.equal(reopened.product.productCode, '001245');
    assert.equal(reopened.layout.template, 'imported-psd');
    assert.equal(createHash('sha256').update(readFileSync('repolho verde kg.psd')).digest('hex'), hashBefore);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document');
  }
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
  for (const s of ['{','null','<script>','{}', 'x'.repeat(MAX_DOCUMENT_CHARS + 1)]) assert.throws(() => deserialize(s));
  for (const mutate of [(d:any) => d.schemaVersion=2,(d:any) => d.product.priceCents=2.89,(d:any) => d.product.priceCents=-1,(d:any) => d.product.name='',(d:any) => d.product.unit=null,(d:any) => d.metadata.updatedAt='ontem',(d:any) => d.layout.paper='B5']) {
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

test('Modelos de Layout: criação de Oferta e Vencimento, alternância dinâmica e preservação de dados', async () => {
  const { createOfficialDocument, switchPosterModel, getPosterModel } = await import('../src/features/psd/templateService');

  const docOferta = await createOfficialDocument('oferta', {
    name: 'MACARRÃO INSTANTÂNEO',
    complement: 'GALINHA CAIPIRA',
    priceCents: 249,
    unit: '85G',
  });

  assert.equal(getPosterModel(docOferta), 'oferta');
  assert.equal(docOferta.product.name, 'MACARRÃO INSTANTÂNEO');
  assert.equal(docOferta.product.priceCents, 249);
  assert.equal(docOferta.layout.template, 'imported-psd');

  // Alterna dinamicamente para o modelo Vencimento
  const docVenc = await switchPosterModel(docOferta, 'vencimento');
  assert.equal(getPosterModel(docVenc), 'vencimento');
  assert.equal(docVenc.product.name, 'MACARRÃO INSTANTÂNEO');
  assert.equal(docVenc.product.priceCents, 249);
  assert.equal(docVenc.product.unit, '85G');
  assert.equal((docVenc.layout as any).artwork.posterModel, 'vencimento');
  assert.ok(docVenc.product.validityText, 'Vencimento deve inicializar com data sugerida');

  // Alterna de volta para Oferta
  const docRetornado = await switchPosterModel(docVenc, 'oferta');
  assert.equal(getPosterModel(docRetornado), 'oferta');
  assert.equal(docRetornado.product.name, 'MACARRÃO INSTANTÂNEO');
  assert.equal(docRetornado.product.priceCents, 249);
});

test('Caixa Fechada e Filtros de Formato: suporte a PEQUENOS (A6), MÉDIOS (A5), A4, A3 e EXTERNOS', async () => {
  const { getPosterPaperFormat, getFormatBadge } = await import('../src/components/ofertas/OfferFolders');
  const doc = createDocument();
  doc.product = {
    name: 'CERVEJA AMSTEL',
    complement: 'LATA 269ML',
    priceCents: 269,
    unit: 'UN',
    hasBoxPrice: true,
    boxQuantity: 12,
    boxUnitLabel: 'UND.',
    boxPriceCents: 3228,
  } as any;

  const poster = posterFromDocument(doc);
  assert.equal(poster.name, 'CERVEJA AMSTEL');
  assert.equal(poster.price, '2,69');
  assert.equal(poster.hasBoxPrice, true);
  assert.equal(poster.boxQuantity, 12);
  assert.equal(poster.boxUnitLabel, 'UND.');
  assert.equal(poster.boxPrice, '32,28');

  // Detecção de formatos pelas pastas e metadados
  assert.equal(getPosterPaperFormat(null, 'C:\\Ofertas\\PEQUENOS\\amstel.skcartaz'), 'A6');
  assert.equal(getPosterPaperFormat(null, 'C:\\Ofertas\\MÉDIOS\\amstel.skcartaz'), 'A5');
  assert.equal(getPosterPaperFormat(null, 'C:\\Ofertas\\CARTAZ A4\\amstel.skcartaz'), 'A4');
  assert.equal(getPosterPaperFormat(null, 'C:\\Ofertas\\CARTAZ AÇOUGUE A3\\carne.skcartaz'), 'A3');
  assert.equal(getPosterPaperFormat(null, 'C:\\Ofertas\\CARTAZ EXTERNOS\\outdoor.skcartaz'), 'expositor-a3-2x2');

  const badgeA6 = getFormatBadge('A6');
  assert.equal(badgeA6.label, 'Pequeno (A6)');
  const badgeA5 = getFormatBadge('A5');
  assert.equal(badgeA5.label, 'Médio (A5)');

  // Reconhecimento do setor FLV (Frutas, Legumes e Verduras)
  const { isFlvItem } = await import('../src/components/ofertas/OfferFolders');
  assert.equal(isFlvItem('FLV.ABACATE KG'), true);
  assert.equal(isFlvItem('FLV.MACA KG GALA'), true);
  assert.equal(isFlvItem('FLV ABACAXI C/COROA'), true);
  assert.equal(isFlvItem('CAFE CABOCLO VCO 500G EX.FORT'), false);
  assert.equal(isFlvItem('LEITE LONGA VIDA LIDER 1L INT'), false);
  assert.equal(isFlvItem('CARRE SUINO KG'), false);
});

test('Modelo Caixa Fechada: criação oficial, alternância dinâmica e exportação PSD direta com atacado', async () => {
  const { createOfficialDocument, switchPosterModel, getPosterModel } = await import('../src/features/psd/templateService');
  const { exportDerivedPsdDirect } = await import('../src/features/scantech/directExport');

  // Cria cartaz normal de melancia
  const docMelancia = await createOfficialDocument('oferta', {
    name: 'FLV.MELANCIA KG',
    complement: '',
    priceCents: 399,
    unit: 'KG',
  });

  assert.equal(getPosterModel(docMelancia), 'oferta');
  assert.equal(docMelancia.product.name, 'FLV.MELANCIA KG');

  // Alterna para Caixa Fechada
  const docCaixa = await switchPosterModel(docMelancia, 'caixa');
  assert.equal(getPosterModel(docCaixa), 'caixa');
  assert.equal(docCaixa.product.name, 'FLV.MELANCIA KG');
  assert.equal((docCaixa.product as any).hasBoxPrice, true);
  assert.equal((docCaixa.product as any).boxQuantity, 12);
  assert.equal((docCaixa.product as any).boxPriceCents, 399 * 12);

  // Teste de exportDerivedPsdDirect simulado em memória
  const mockIo = {
    readSourcePsd: async () => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const buf = await fs.readFile(path.resolve(process.cwd(), 'public/templates/modelo_caixa.psd'));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    writeOutputPsd: async () => ({ fileSize: 50000 }),
  };

  const exp = await exportDerivedPsdDirect({
    sourcePsdPath: 'C:\\fake\\modelo_caixa.psd',
    outputPsdPath: 'C:\\fake\\PEQUENOS\\FLV.MELANCIA KG.psd',
    title: 'MELANCIA KG',
    whole: '3',
    fraction: '99',
    hasBoxPrice: true,
    boxQuantity: 12,
    boxUnitLabel: 'UND.',
    boxWhole: '47',
    boxFraction: '88',
    roles: {
      wholeLayerId: '2',
      fractionLayerId: '69',
      titleLayerId: 'CERVEJA',
    },
  }, mockIo as any);

  assert.equal(exp.ok, true);
  assert.ok(exp.bytes && exp.bytes.length > 100);
});

test('sincronização de preço no editor: price <-> priceCents mantém consistência em ambas as direções', () => {
  const base = createDocument();
  assert.equal(base.product.priceCents, 289);

  // Edição via input de texto principal atualiza string e priceCents juntos
  const edited = applyProductFieldChange(base, '2,89', 'price', '14,90');
  assert.equal(edited.price, '14,90');
  assert.equal(edited.document.product.priceCents, 1490);

  // Digitação intermediária ("14,") preserva texto digitado e mantém último priceCents válido
  const partial = applyProductFieldChange(edited.document, edited.price, 'price', '14,');
  assert.equal(partial.price, '14,');
  assert.equal(partial.document.product.priceCents, 1490);

  // Edição via Editor Cirúrgico (priceCents numérico) atualiza price formatado em pt-BR
  const surgical = applyProductFieldChange(partial.document, partial.price, 'priceCents', 995);
  assert.equal(surgical.document.product.priceCents, 995);
  assert.equal(surgical.price, '9,95');
});

test('posterFromDocument propaga campos estendidos de embalagem/imagem e respeita priceOverride sem vazar F7', () => {
  const doc = createDocument();
  doc.product.productCode = '009988';
  doc.product.hasBoxPrice = true;
  doc.product.boxQuantity = 24;
  doc.product.boxUnitLabel = 'UN';
  doc.product.boxPriceCents = 4800;
  doc.product.boxPackageType = 'fardo';
  doc.product.boxPackageLabel = 'NO FARDO C/ 24';
  doc.product.unitBadgeMode = 'un';
  doc.product.productImage = { dataUrl: pixel, fileName: 'foto.png', bounds: { left: 10, top: 20, right: 200, bottom: 220 } };

  const poster = posterFromDocument(doc, '3,49');
  assert.equal(poster.price, '3,49');
  assert.equal(poster.hasBoxPrice, true);
  assert.equal(poster.boxQuantity, 24);
  assert.equal(poster.boxPrice, '48,00');
  assert.equal(poster.boxPackageType, 'fardo');
  assert.equal(poster.boxPackageLabel, 'NO FARDO C/ 24');
  assert.equal(poster.unitBadgeMode, 'un');
  assert.deepEqual(poster.productImage, { dataUrl: pixel, fileName: 'foto.png', bounds: { left: 10, top: 20, right: 200, bottom: 220 } });
  assert.equal('productCode' in poster, false);
});

test('computePngDimensionsPx calcula dimensões exatas em 300 DPI para todos os formatos de papel', () => {
  assert.deepEqual(computePngDimensionsPx(), { width: 1748, height: 2480 });
  assert.deepEqual(computePngDimensionsPx({ paper: 'A5', orientation: 'portrait' }), { width: 1748, height: 2480 });
  assert.deepEqual(computePngDimensionsPx({ paper: 'A5', orientation: 'landscape' }), { width: 2480, height: 1748 });
  assert.deepEqual(computePngDimensionsPx({ paper: 'A6', orientation: 'portrait' }), { width: 1240, height: 1748 });
  assert.deepEqual(computePngDimensionsPx({ paper: 'A4', orientation: 'portrait' }), { width: 2480, height: 3508 });
  assert.deepEqual(computePngDimensionsPx({ paper: 'A3', orientation: 'portrait' }), { width: 3508, height: 4961 });
  assert.deepEqual(
    computePngDimensionsPx({ paper: 'custom', orientation: 'portrait', customWidthMm: 100, customHeightMm: 200 }),
    { width: 1181, height: 2362 },
  );
});

test('exportPng em PSD importado aplica formato 300 DPI, validade e textos dinâmicos editados', async () => {
  const artwork = importedArtwork();
  artwork.posterModel = 'vencimento';
  artwork.templateParts = [
    {
      role: 'validity',
      layerId: 'val-1',
      bounds: { left: 100, top: 900, right: 400, bottom: 960 },
      fontSize: 36,
      originalText: '01/01/2026',
      color: '#ffffff',
    },
    {
      role: 'title',
      layerId: 'title-1',
      bounds: { left: 80, top: 220, right: 800, bottom: 320 },
      fontSize: 64,
      originalText: 'PRODUTO ANTIGO',
      color: '#292d5a',
    },
  ];
  const doc = createDocument();
  doc.product.name = 'LEITE INTEGRAL';
  doc.product.complement = 'CAIXA 1L';
  doc.product.unit = 'UN';
  doc.product.priceCents = 499;
  doc.product.validityText = '31/12/2026';
  doc.layout = { template: 'imported-psd', paper: 'A5', orientation: 'portrait', artwork };

  const poster = posterFromDocument(doc);
  const drawnTexts: string[] = [];
  const ctx = {
    clearRect: () => {},
    fillRect: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    transform: () => {},
    fillText: (text: string) => drawnTexts.push(String(text)),
    strokeText: () => {},
    measureText: (t: string) => ({ width: Math.max(10, String(t).length * 20) }),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: () => 'data:image/png;base64,ok',
  };
  const anchor = { download: '', href: '', click: () => {} };
  const docDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const imgDesc = Object.getOwnPropertyDescriptor(globalThis, 'Image');

  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 100;
    naturalHeight = 100;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: (tag: string) => (tag === 'canvas' ? canvas : anchor) },
  });
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: FakeImage });

  try {
    await exportPng(poster, { paper: 'A4', orientation: 'portrait' });
    assert.equal(canvas.width, 2480);
    assert.equal(canvas.height, 3508);
    assert.ok(drawnTexts.some(t => t.includes('31/12/2026')), 'Data de validade editada deve aparecer no PNG exportado');
    assert.ok(drawnTexts.some(t => t.includes('LEITE INTEGRAL')), 'Nome dinâmico editado deve aparecer no PNG exportado');
    assert.ok(drawnTexts.some(t => t.includes('4')), 'Preço inteiro deve aparecer no PNG exportado');
    assert.ok(drawnTexts.some(t => t.includes('99')), 'Centavos devem aparecer no PNG exportado');
  } finally {
    if (docDesc) Object.defineProperty(globalThis, 'document', docDesc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (imgDesc) Object.defineProperty(globalThis, 'Image', imgDesc);
    else Reflect.deleteProperty(globalThis, 'Image');
  }
});

test('alternar de Caixa para Vencimento carrega modelo_vencimento.psd e desativa modo Caixa Fechada', async () => {
  const { createOfficialDocument, switchPosterModel, getPosterModel } = await import('../src/features/psd/templateService');

  const docCaixa = await createOfficialDocument('caixa', {
    name: 'CERVEJA AMSTEL',
    complement: 'LATA 269ML',
    priceCents: 269,
    unit: 'UN',
  });
  assert.equal(getPosterModel(docCaixa), 'caixa');
  assert.equal(docCaixa.product.hasBoxPrice, true);

  // Alterna de Caixa -> Vencimento: deve trocar a arte para modelo_vencimento.psd e desligar hasBoxPrice
  const docVenc = await switchPosterModel(docCaixa, 'vencimento');
  assert.equal(getPosterModel(docVenc), 'vencimento');
  assert.equal(docVenc.product.hasBoxPrice, false);
  assert.ok(docVenc.product.validityText, 'Vencimento deve ter data sugerida');
  assert.equal(docVenc.layout.template, 'imported-psd');
  if (docVenc.layout.template === 'imported-psd') {
    assert.equal(docVenc.layout.artwork.source.fileName, 'modelo_vencimento.psd');
    assert.ok(docVenc.layout.artwork.priceParts.some(p => p.role === 'validity'));
  }

  // Alterna de Vencimento -> Oferta: deve trocar a arte para modelo_oferta.psd, limpar validade e manter hasBoxPrice = false
  const docOferta = await switchPosterModel(docVenc, 'oferta');
  assert.equal(getPosterModel(docOferta), 'oferta');
  assert.equal(docOferta.product.hasBoxPrice, false);
  assert.equal(docOferta.product.validityText, '');
  if (docOferta.layout.template === 'imported-psd') {
    assert.equal(docOferta.layout.artwork.source.fileName, 'modelo_oferta.psd');
  }
});

test('upsertLibraryEntry e removeLibraryEntry atualizam biblioteca em memória sem reescanear disco', async () => {
  const { upsertLibraryEntry, removeLibraryEntry } = await import('../src/features/cartazes/storage');
  const root = 'C:\\Skalee\\Cartazes';
  const doc1 = createDocument();
  doc1.product = { name: 'SALGADINHO CHEETOS', complement: '95G LUA', priceCents: 1099, unit: 'UN', productCode: '009911' };

  const initialLib = {
    root,
    entries: [
      { path: `${root}\\Mercearia`, name: 'Mercearia', folder: true },
      { path: `${root}\\Mercearia\\cheetos.psd`, name: 'cheetos.psd', folder: false, content: serialize(doc1), modifiedAt: 1000 },
      { path: `${root}\\Mercearia\\cheetos.skcartaz`, name: 'cheetos.skcartaz', folder: false, content: serialize(doc1), modifiedAt: 1000 },
    ],
  };

  // Atualiza gramagem e preço em memória para ambos .psd e .skcartaz companheiro
  const updatedDoc = { ...doc1, product: { ...doc1.product, complement: '80G LUA', priceCents: 949 } };
  const afterUpsert = upsertLibraryEntry(initialLib, `${root}\\Mercearia\\cheetos.psd`, updatedDoc, 2000);
  assert.ok(afterUpsert);
  assert.equal(afterUpsert!.entries.length, 3);
  const psdEntry = afterUpsert!.entries.find(e => e.name === 'cheetos.psd');
  const skEntry = afterUpsert!.entries.find(e => e.name === 'cheetos.skcartaz');
  assert.ok(psdEntry?.content?.includes('80G LUA'));
  assert.ok(skEntry?.content?.includes('949'));

  // Novo arquivo salvo na raiz da biblioteca é inserido incrementalmente
  const doc2 = createDocument();
  doc2.product = { name: 'BATATA RUFFLES', complement: 'TUBO 100G', priceCents: 1299, unit: 'UN', productCode: '009922' };
  const afterInsert = upsertLibraryEntry(afterUpsert, `${root}\\Mercearia\\ruffles.skcartaz`, doc2, 3000);
  assert.equal(afterInsert?.entries.length, 4);

  // Remoção limpa apenas o alvo (ou subpasta)
  const afterRemove = removeLibraryEntry(afterInsert, `${root}\\Mercearia\\ruffles.skcartaz`);
  assert.equal(afterRemove?.entries.length, 3);
  assert.equal(afterRemove?.entries.some(e => e.name === 'ruffles.skcartaz'), false);
});

test('applyPartAdjustmentToDocument aplica, limita e reseta deslocamento (X/Y) e escala de camadas PSD', async () => {
  const { applyPartAdjustmentToDocument } = await import('../src/hooks/useCartaz');
  const { getEditableParts, getEffectivePartBounds, getPartKey } = await import('../src/components/editor/importedRenderer');

  const doc = createDocument();
  const baseArtwork = importedArtwork();
  doc.layout = { template: 'imported-psd', paper: 'A5', orientation: 'portrait', artwork: baseArtwork };

  const parts = getEditableParts(baseArtwork);
  const fractionPart = parts.find(p => p.role === 'fraction');
  assert.ok(fractionPart, 'Deve existir parte de centavos editável');
  const key = getPartKey(fractionPart!);

  const moved = applyPartAdjustmentToDocument(doc, key, { dx: 18, dy: -12, scale: 1.25 });
  assert.equal(moved.layout.template, 'imported-psd');
  if (moved.layout.template === 'imported-psd') {
    const updatedPart = moved.layout.artwork.priceParts.find(p => getPartKey(p) === key)!;
    assert.deepEqual(updatedPart.adjustments, { dx: 18, dy: -12, scale: 1.25 });
    const origCx = (fractionPart!.bounds.left + fractionPart!.bounds.right) / 2;
    const eff = getEffectivePartBounds(updatedPart);
    const effCx = (eff.left + eff.right) / 2;
    assert.equal(Math.round(effCx - origCx), 18);
  }

  // Clamp de segurança impede valores absurdos
  const clamped = applyPartAdjustmentToDocument(moved, key, { dx: 5000, dy: -5000, scale: 9 });
  if (clamped.layout.template === 'imported-psd') {
    const p = clamped.layout.artwork.priceParts.find(item => getPartKey(item) === key)!;
    assert.deepEqual(p.adjustments, { dx: 600, dy: -800, scale: 2.5 });
  }

  // Resetar camada limpa o campo adjustments
  const reset = applyPartAdjustmentToDocument(clamped, key, null);
  if (reset.layout.template === 'imported-psd') {
    const p = reset.layout.artwork.priceParts.find(item => getPartKey(item) === key)!;
    assert.equal(p.adjustments, undefined);
  }
});

test('createDebouncedAsyncSaver agrupa edições rápidas, reporta progresso e serializa alterações durante a gravação', async () => {
  const { createDebouncedAsyncSaver } = await import('../src/features/cartazes/asyncSave');

  let calls = 0;
  let activeWrites = 0;
  let maxConcurrentWrites = 0;
  const phases: string[] = [];
  const percents: number[] = [];
  let releaseFirstWrite: (() => void) | null = null;

  const saver = createDebouncedAsyncSaver({
    debounceMs: 25,
    performSave: async ({ onProgress }) => {
      calls += 1;
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      onProgress({ percent: 45, stage: 'Gravando…' });
      if (calls === 1) {
        await new Promise<void>(resolve => {
          releaseFirstWrite = resolve;
        });
      }
      onProgress({ percent: 95, stage: 'Finalizando…' });
      activeWrites -= 1;
      return true;
    },
    onStateChange: state => {
      phases.push(state.phase);
      percents.push(state.percent);
    },
  });

  // 4 alterações rápidas devem ser agrupadas em apenas 1 gravação
  saver.schedule();
  saver.schedule();
  saver.schedule();
  saver.schedule();
  assert.equal(saver.getState().phase, 'scheduled');

  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(calls, 1);
  assert.equal(saver.isInFlight(), true);
  assert.ok(percents.includes(45));

  // Nova edição enquanto grava: não inicia 2ª gravação paralela, mas enfileira 1 follow-up automático
  saver.schedule();
  saver.schedule();
  assert.equal(calls, 1);

  releaseFirstWrite?.();
  await new Promise(resolve => setTimeout(resolve, 35));

  assert.equal(calls, 2, 'Deve executar exatamente 1 gravação adicional com as alterações ocorridas durante a escrita');
  assert.equal(maxConcurrentWrites, 1, 'Nunca deve executar duas escritas simultâneas no mesmo arquivo');
  assert.equal(saver.getState().phase, 'saved');
  assert.equal(saver.getState().percent, 100);
  assert.ok(phases.includes('scheduled'));
  assert.ok(phases.includes('saving'));
  assert.ok(phases.includes('saved'));
  saver.dispose();
});

test('createDebouncedAsyncSaver suporta flush imediato (Ctrl+S) e recupera de erro de escrita', async () => {
  const { createDebouncedAsyncSaver } = await import('../src/features/cartazes/asyncSave');

  let shouldFail = true;
  let lastReason = '';
  const saver = createDebouncedAsyncSaver({
    debounceMs: 500,
    performSave: async ({ reason, onProgress }) => {
      lastReason = reason;
      onProgress({ percent: 50, stage: 'Gravando…' });
      if (shouldFail) throw new Error('Disco protegido contra gravação');
      return true;
    },
  });

  saver.schedule();
  const failed = await saver.flush('manual');
  assert.equal(failed, false);
  assert.equal(lastReason, 'manual');
  assert.equal(saver.getState().phase, 'error');
  assert.match(saver.getState().error ?? '', /Disco protegido/);

  shouldFail = false;
  const retried = await saver.flush('manual');
  assert.equal(retried, true);
  assert.equal(saver.getState().phase, 'saved');
  assert.equal(saver.getState().error, null);
  saver.dispose();
});

test('useMarqueeSelection helpers: normalizeMarqueeRect e computeMarqueeSelection selecionam itens no quadrado azul e suportam modo aditivo', async () => {
  const { normalizeMarqueeRect, computeMarqueeSelection } = await import('../src/hooks/useMarqueeSelection');

  // Arraste de baixo-direita para cima-esquerda deve normalizar corretamente
  const rect = normalizeMarqueeRect(250, 220, 40, 80);
  assert.deepEqual(rect, { left: 40, top: 80, right: 250, bottom: 220, width: 210, height: 140 });

  const rows = [
    { id: 'item-1', bounds: { left: 20, top: 20, right: 300, bottom: 60 } },   // fora (acima)
    { id: 'item-2', bounds: { left: 20, top: 90, right: 300, bottom: 130 } },  // dentro
    { id: 'item-3', bounds: { left: 20, top: 180, right: 300, bottom: 240 } }, // intersecção parcial
    { id: 'item-4', bounds: { left: 20, top: 260, right: 300, bottom: 300 } }, // fora (abaixo)
  ];

  const replaced = computeMarqueeSelection(rows, rect, new Set(['item-1']), false);
  assert.deepEqual([...replaced].sort(), ['item-2', 'item-3']);

  const additive = computeMarqueeSelection(rows, rect, new Set(['item-1']), true);
  assert.deepEqual([...additive].sort(), ['item-1', 'item-2', 'item-3']);
});

test('selectExportCandidates filtra corretamente por escopo (checked-rows, print-marked e all)', async () => {
  const { selectExportCandidates } = await import('../src/components/ofertas/OfferFolders');
  const docA = createDocument();
  docA.product.name = 'PRODUTO A';
  const docB = createDocument();
  docB.product.name = 'PRODUTO B';
  const docC = createDocument();
  docC.product.name = 'PRODUTO C';

  const makeView = (id: string, f7: string, path: string, doc: typeof docA, printSelected: boolean) => ({
    item: {
      id,
      rowNumber: 1,
      f7,
      description: doc.product.name,
      scheduledPriceCents: 499,
      conflicting: false,
      issues: [],
      posters: [],
    },
    matchedPosters: [
      {
        state: {
          cartazId: doc.id,
          cartazPath: path,
          selected: printSelected,
          copies: 1,
          status: 'preparado' as const,
          printedAt: null,
        },
        libraryCartaz: null,
        currentPriceCents: 499,
        scheduledDocument: doc,
        appliedPriceCents: 499,
        hasInvertedLayers: false,
        priceMismatchReason: null,
      },
    ],
    unlinkedLibraryPosters: [],
    hasConflict: false,
    missingPoster: false,
  });

  const views = [
    makeView('row-a', '100', 'C:\\a.skcartaz', docA, true),
    makeView('row-b', '200', 'C:\\b.skcartaz', docB, false),
    makeView('row-c', '300', 'C:\\c.skcartaz', docC, true),
  ];

  const checkedOnly = selectExportCandidates(views, 'checked-rows', new Set(['row-b', 'row-c']));
  assert.deepEqual(checkedOnly.map(c => c.item.id), ['row-b', 'row-c']);

  const printMarkedOnly = selectExportCandidates(views, 'print-marked', new Set(['row-b']));
  assert.deepEqual(printMarkedOnly.map(c => c.item.id), ['row-a', 'row-c']);

  const allLinked = selectExportCandidates(views, 'all', new Set());
  assert.equal(allLinked.length, 3);
});

test('App.tsx expõe useMarqueeSelection e renderiza a superfície de seleção de arraste (sk-marquee-surface)', async () => {
  const appModule = await import('../src/App');
  assert.equal(typeof appModule.useMarqueeSelection, 'function');
  const html = renderToStaticMarkup(<appModule.default />);
  assert.match(html, /sk-main-content sk-marquee-surface/);
});

test('computeSnapAdjustment e computeHorizontalCenterDx aplicam imã no centro, camadas vizinhas e grade', async () => {
  const { computeSnapAdjustment, computeHorizontalCenterDx } = await import('../src/components/editor/importedRenderer');
  const artwork = importedArtwork();
  const wholePart = artwork.priceParts.find(p => p.role === 'whole')!;
  const fractionPart = artwork.priceParts.find(p => p.role === 'fraction')!;

  // Centralização horizontal exata do Reais no canvas (tolerância de 0.5px por arredondamento inteiro de dx)
  const centerDx = computeHorizontalCenterDx(wholePart, artwork);
  const wholeBaseCenter = (wholePart.bounds.left + wholePart.bounds.right) / 2;
  assert.ok(Math.abs(wholeBaseCenter + centerDx - artwork.canvas.width / 2) <= 0.5);

  // Imã magnético próximo ao centro do canvas (desvio de 4px puxa para o centro exato)
  const snappedCenter = computeSnapAdjustment(wholePart, centerDx + 4, 0, 1, artwork, [fractionPart], false);
  assert.equal(snappedCenter.dx, centerDx);
  assert.equal(snappedCenter.guides.verticalX, artwork.canvas.width / 2);

  // Alinhamento magnético com o topo da camada vizinha (Centavos alinhado ao topo de Reais)
  const deltaToWholeTop = Math.round(wholePart.bounds.top - fractionPart.bounds.top);
  const snappedSibling = computeSnapAdjustment(fractionPart, 0, deltaToWholeTop + 3, 1, artwork, [wholePart], false);
  assert.equal(snappedSibling.dy, deltaToWholeTop);
  assert.equal(snappedSibling.guides.horizontalY, wholePart.bounds.top);
});

test('applyPartAdjustmentsBatchToDocument move e reseta o bloco de preço atomicamente', async () => {
  const { applyPartAdjustmentsBatchToDocument } = await import('../src/hooks/useCartaz');
  const { getPartKey } = await import('../src/components/editor/importedRenderer');
  const doc = createDocument();
  const artwork = importedArtwork();
  doc.layout = { template: 'imported-psd', paper: 'A5', orientation: 'portrait', artwork };

  const wholePart = artwork.priceParts.find(p => p.role === 'whole')!;
  const fractionPart = artwork.priceParts.find(p => p.role === 'fraction')!;
  const kWhole = getPartKey(wholePart);
  const kFrac = getPartKey(fractionPart);

  const moved = applyPartAdjustmentsBatchToDocument(doc, {
    [kWhole]: { dx: 24, dy: -12, scale: 1.15 },
    [kFrac]: { dx: 24, dy: -12, scale: 1.15 },
  });
  assert.equal(moved.layout.template, 'imported-psd');
  if (moved.layout.template === 'imported-psd') {
    assert.deepEqual(moved.layout.artwork.priceParts.find(p => p.role === 'whole')?.adjustments, { dx: 24, dy: -12, scale: 1.15 });
    assert.deepEqual(moved.layout.artwork.priceParts.find(p => p.role === 'fraction')?.adjustments, { dx: 24, dy: -12, scale: 1.15 });
  }

  const reset = applyPartAdjustmentsBatchToDocument(moved, { [kWhole]: null, [kFrac]: null });
  if (reset.layout.template === 'imported-psd') {
    assert.equal(reset.layout.artwork.priceParts.find(p => p.role === 'whole')?.adjustments, undefined);
    assert.equal(reset.layout.artwork.priceParts.find(p => p.role === 'fraction')?.adjustments, undefined);
  }
});

test('indexCartazes reutiliza cache WeakMap por Entry e findCartazesByF7 opera em O(1)', () => {
  const doc1 = createDocument();
  doc1.product.name = 'CAFE EXTRA FORTE';
  doc1.product.productCode = '004411';
  const doc2 = createDocument();
  doc2.product.name = 'LEITE INTEGRAL';
  doc2.product.productCode = '009922';

  const e1: Entry = { name: 'cafe.skcartaz', path: 'C:\\Lib\\cafe.skcartaz', folder: false, content: serialize(doc1) };
  const e2: Entry = { name: 'leite.skcartaz', path: 'C:\\Lib\\leite.skcartaz', folder: false, content: serialize(doc2) };

  const first = indexCartazes([e1, e2]);
  const second = indexCartazes([e1, e2]);
  // Mesma referência reutilizada do WeakMap (sem re-executar JSON.parse)
  assert.equal(first[0], second[0]);
  assert.equal(first[1], second[1]);

  const found = findCartazesByF7('004411', first);
  assert.equal(found.length, 1);
  assert.equal(found[0].document.product.name, 'CAFE EXTRA FORTE');
});

test('atalho Delete: isTextEditingElement libera checkboxes e buildBatchDeleteConfirmation lista itens para exclusão permanente', async () => {
  const { isTextEditingElement, buildBatchDeleteConfirmation } = await import('../src/features/cartazes/keyboard');

  // Checkboxes e botões NÃO bloqueiam o atalho Delete na lista
  assert.equal(isTextEditingElement({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget), false);
  assert.equal(isTextEditingElement({ tagName: 'INPUT', type: 'radio' } as unknown as EventTarget), false);
  assert.equal(isTextEditingElement({ tagName: 'BUTTON' } as unknown as EventTarget), false);

  // Campos de digitação continuam bloqueando o atalho Delete para não apagar itens enquanto digita
  assert.equal(isTextEditingElement({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget), true);
  assert.equal(isTextEditingElement({ tagName: 'INPUT', type: 'search' } as unknown as EventTarget), true);
  assert.equal(isTextEditingElement({ tagName: 'TEXTAREA' } as unknown as EventTarget), true);
  assert.equal(isTextEditingElement({ tagName: 'SELECT' } as unknown as EventTarget), true);
  assert.equal(isTextEditingElement({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget), true);

  const single = buildBatchDeleteConfirmation(['C:\\Lib\\arroz.skcartaz'], () => 'ARROZ 5KG');
  assert.equal(single.tone, 'danger');
  assert.match(single.title, /1 cartaz permanentemente/);
  assert.match(single.description, /"ARROZ 5KG"/);

  const many = buildBatchDeleteConfirmation(
    ['C:\\1.skcartaz', 'C:\\2.skcartaz', 'C:\\3.skcartaz', 'C:\\4.skcartaz', 'C:\\5.skcartaz', 'C:\\6.skcartaz'],
    p => p.split('\\').pop() || p
  );
  assert.equal(many.tone, 'danger');
  assert.match(many.title, /6 cartazes permanentemente/);
  assert.match(many.description, /e mais 2/);
  assert.match(many.note ?? '', /não pode ser desfeita/);
});

test('WebWorker de renderização: extractSerializableArtwork remove base64 pesados e preparePosterRenderPlan serializa plano completo', async () => {
  const { extractSerializableArtwork, preparePosterRenderPlan } = await import(
    '../src/components/editor/posterRenderPlan'
  );

  const artwork: ImportedArtwork = {
    kind: 'imported-psd',
    compatibility: 'ready',
    source: { fileName: 'complexo.psd', sha256: 'hash-worker-1' },
    canvas: { width: 1000, height: 1414, resolutionPpi: 300, fit: 'contain' },
    staticBackground: 'data:image/png;base64,' + 'A'.repeat(2048),
    originalPreview: 'data:image/png;base64,' + 'B'.repeat(2048),
    warnings: [],
    layers: [
      { id: '1', name: 'Fundo', type: 'raster', visible: true, depth: 0, bounds: { left: 0, top: 0, right: 1000, bottom: 1414 } },
      { id: '2', name: 'Caixa com 12 un', type: 'text', visible: true, depth: 0, text: 'CAIXA COM 12 UN', bounds: { left: 100, top: 1100, right: 900, bottom: 1180 } },
    ],
    priceParts: [
      {
        layerId: '10',
        role: 'whole',
        originalText: '10',
        bounds: { left: 120, top: 600, right: 520, bottom: 1100 },
        adjustments: { dx: 9999, dy: -9999, scale: 9 },
        fontFamily: 'Impact',
        fontSize: 400,
        color: '#d32f2f',
      },
      {
        layerId: '11',
        role: 'fraction',
        originalText: '99',
        bounds: { left: 540, top: 620, right: 860, bottom: 880 },
        fontFamily: 'Impact',
        fontSize: 220,
        color: '#d32f2f',
      },
    ],
  };

  const serializable = extractSerializableArtwork(artwork);
  assert.equal('staticBackground' in serializable, false);
  assert.equal('originalPreview' in serializable, false);
  assert.equal(serializable.source.sha256, 'hash-worker-1');
  assert.equal(serializable.priceParts.length, 2);

  const plan = preparePosterRenderPlan({
    artwork: serializable,
    price: '19,90',
    outputWidth: 500,
    outputHeight: 707,
    validityText: 'OFERTA VALIDA HOJE',
    dynamicTexts: { name: 'SALGADINHO', complement: '80G', unit: 'UN' },
  });

  assert.equal(plan.whole, '19');
  assert.equal(plan.fraction, '90');
  assert.equal(plan.outputWidth, 500);
  assert.equal(plan.outputHeight, 707);
  assert.ok(Math.abs(plan.scale - 0.5) < 0.001);
  assert.equal(plan.hasNativeBoxLayers, true);

  // Ajustes fora dos limites foram clampados antes do desenho no Canvas
  const wholePart = plan.normalizedPriceParts.find(p => p.role === 'whole');
  assert.ok(wholePart?.adjustments);
  assert.equal(wholePart!.adjustments!.dx, 600);
  assert.equal(wholePart!.adjustments!.dy, -800);
  assert.equal(wholePart!.adjustments!.scale, 2.5);

  // serializedPayload é um JSON íntegro produzido fora da thread principal
  const parsed = JSON.parse(plan.serializedPayload);
  assert.equal(parsed.sourceHash, 'hash-worker-1');
  assert.equal(parsed.whole, '19');
  assert.equal(parsed.fraction, '90');
  assert.equal(parsed.hasNativeBoxLayers, true);
});

test('preparePosterRenderOffThread executa via Worker (mock) e cancela requisições obsoletas via AbortController', async () => {
  const { extractSerializableArtwork, preparePosterRenderPlan } = await import(
    '../src/components/editor/posterRenderPlan'
  );
  const {
    preparePosterRenderOffThread,
    isPosterRenderWorkerActive,
    setPosterRenderWorkerFactory,
    terminatePosterRenderWorker,
  } = await import('../src/components/editor/posterRenderWorkerClient');

  const artwork: ImportedArtwork = {
    kind: 'imported-psd',
    compatibility: 'ready',
    source: { fileName: 'oferta.psd', sha256: 'hash-worker-2' },
    canvas: { width: 800, height: 1131, resolutionPpi: 300, fit: 'contain' },
    staticBackground: 'data:image/png;base64,abc',
    originalPreview: 'data:image/png;base64,def',
    warnings: [],
    layers: [],
    priceParts: [
      {
        layerId: '1',
        role: 'whole',
        originalText: '9',
        bounds: { left: 100, top: 500, right: 420, bottom: 950 },
        fontFamily: 'Impact',
        fontSize: 320,
        color: '#b91c1c',
      },
      {
        layerId: '2',
        role: 'fraction',
        originalText: '99',
        bounds: { left: 440, top: 520, right: 700, bottom: 760 },
        fontFamily: 'Impact',
        fontSize: 180,
        color: '#b91c1c',
      },
    ],
  };

  const baseInput = {
    artwork: extractSerializableArtwork(artwork),
    price: '12,49',
    outputWidth: 400,
    outputHeight: 566,
  };

  // 1) Fallback automático quando Worker não existe (ambiente Node)
  setPosterRenderWorkerFactory(null);
  const fallbackPlan = await preparePosterRenderOffThread(baseInput);
  assert.equal(fallbackPlan.whole, '12');
  assert.equal(fallbackPlan.fraction, '49');

  // 2) Execução real via Worker simulado (valida postMessage / onmessage)
  let workerCalls = 0;

  class MockWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    postMessage(data: { requestId: number; input: Parameters<typeof preparePosterRenderPlan>[0] }) {
      workerCalls += 1;
      setTimeout(() => {
        const plan = preparePosterRenderPlan(data.input);
        this.onmessage?.({ data: { requestId: data.requestId, ok: true, plan } } as MessageEvent);
      }, 5);
    }
    terminate() {
      // noop
    }
  }

  try {
    setPosterRenderWorkerFactory(() => new MockWorker() as unknown as Worker);

    const workerPlan = await preparePosterRenderOffThread({
      ...baseInput,
      price: '24,95',
    });
    assert.equal(isPosterRenderWorkerActive(), true);
    assert.equal(workerCalls, 1);
    assert.equal(workerPlan.whole, '24');
    assert.equal(workerPlan.fraction, '95');

    // 3) Cancelamento de edição anterior em digitação rápida via AbortController
    const controller = new AbortController();
    const pending = preparePosterRenderOffThread({ ...baseInput, price: '99,99' }, controller.signal);
    controller.abort();
    await assert.rejects(pending, (err: unknown) => (err as { name?: string })?.name === 'AbortError');
  } finally {
    setPosterRenderWorkerFactory(null);
    terminatePosterRenderWorker();
  }
});

test('Reutilização de referência PSD entre produtos/F7 diferentes gera arquivos .skcartaz independentes sem sobrescrever', async () => {
  const {
    buildUniqueCartazPathForOfferItem,
    executePsdBatchLinking,
  } = await import('../src/features/ofertas/service');

  const itemA = {
    id: 'item-a',
    f7: '31404',
    description: 'PAPEL ALUMINIO GIOPACK 30CMX4M',
    scheduledPriceCents: 498,
    rowNumber: 2,
    posters: [],
  };
  const itemB = {
    id: 'item-b',
    f7: '31405',
    description: 'PAPEL ALUMINIO GIOPACK 45CMX7M',
    scheduledPriceCents: 899,
    rowNumber: 3,
    posters: [],
  };

  // 1) Primeiro uso do PSD: usa o nome canônico do PSD
  const first = buildUniqueCartazPathForOfferItem(
    'C:\\Skalee\\Cartazes',
    'papel aluminio GIOPACK 30CMX4M.psd',
    itemA,
    'A6',
    []
  );
  assert.equal(first.reusedReference, false);
  assert.equal(first.existsForSameProduct, false);
  assert.equal(first.path, 'C:\\Skalee\\Cartazes\\papel aluminio GIOPACK 30CMX4M.skcartaz');

  // 2) Re-vincular para o MESMO F7 reconhece o arquivo existente do mesmo produto
  const existing = [{ path: first.path, productCode: itemA.f7 }];
  const sameF7 = buildUniqueCartazPathForOfferItem(
    'C:\\Skalee\\Cartazes',
    'papel aluminio GIOPACK 30CMX4M.psd',
    itemA,
    'A6',
    existing
  );
  assert.equal(sameF7.reusedReference, false);
  assert.equal(sameF7.existsForSameProduct, true);
  assert.equal(sameF7.path, first.path);

  // 3) Reutilizar o MESMO PSD para OUTRO F7 gera caminho independente sem sobrescrever o itemA
  const second = buildUniqueCartazPathForOfferItem(
    'C:\\Skalee\\Cartazes',
    'papel aluminio GIOPACK 30CMX4M.psd',
    itemB,
    'A6',
    existing
  );
  assert.equal(second.reusedReference, true);
  assert.equal(second.existsForSameProduct, false);
  assert.notEqual(second.path.toLowerCase(), first.path.toLowerCase());
  assert.ok(second.path.includes('31405'));

  // 4) Vinculação em lote usando o mesmo PSD para dois F7 diferentes cria 2 arquivos distintos
  const campaign = {
    schemaVersion: 1 as const,
    id: 'camp-reuse',
    name: 'Ofertas',
    campaignDate: '2026-11-28',
    archived: false,
    sourceExcel: null,
    items: [itemA, itemB],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const savedPaths: string[] = [];
  const sharedPsd = { name: 'modelo-aluminio.psd', path: 'C:\\PSDs\\modelo-aluminio.psd', size: 100 };
  const result = await executePsdBatchLinking(
    campaign,
    [
      { item: itemA, psd: sharedPsd },
      { item: itemB, psd: sharedPsd },
    ],
    'A6',
    'C:\\Skalee\\Cartazes',
    {
      readPsd: async p => ({ name: 'modelo-aluminio.psd', path: p, buffer: new ArrayBuffer(8) }),
      buildCartazFromPsd: async (_psdData, item) => ({
        schemaVersion: 1,
        id: `doc-${item.f7}`,
        product: { name: item.description, complement: '', unit: 'UN', priceCents: item.scheduledPriceCents, productCode: item.f7 },
        layout: { template: 'oferta-classica', paper: 'A6', orientation: 'portrait' },
        metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      }),
      saveCartazDocument: async targetPath => {
        savedPaths.push(targetPath);
      },
      persistCampaign: async c => c,
    },
    []
  );
  assert.equal(result.success, true);
  assert.equal(result.linkedCount, 2);
  assert.equal(savedPaths.length, 2);
  assert.notEqual(savedPaths[0].toLowerCase(), savedPaths[1].toLowerCase());
});

test('Exportação direta de PSD persiste ajustes de mover/redimensionar camadas (dx, dy, scale) de forma idempotente', async () => {
  const {
    extractLayerAdjustmentsFromArtwork,
    applyPartAdjustmentToPsdLayer,
    exportDerivedPsdDirect,
  } = await import('../src/features/scantech/directExport');
  const { readPsd, writePsd } = await import('ag-psd');

  const artwork: ImportedArtwork = {
    kind: 'imported-psd',
    compatibility: 'ready',
    source: { fileName: 'papel.psd', sha256: 'c'.repeat(64) },
    canvas: { width: 1000, height: 1400, resolutionPpi: 300, fit: 'contain' },
    staticBackground: pixel,
    originalPreview: pixel,
    warnings: [],
    layers: [],
    priceParts: [
      {
        role: 'whole',
        layerId: '0',
        originalText: '4',
        bounds: { left: 120, top: 600, right: 420, bottom: 1000 },
        fontFamily: 'Zullia',
        fontSize: 50,
        transform: [6, 0, 0, 8, 270, 980],
        color: '#c74624',
      },
      {
        role: 'fraction',
        layerId: '1',
        originalText: '98',
        bounds: { left: 460, top: 620, right: 780, bottom: 860 },
        fontFamily: 'Zullia',
        fontSize: 50,
        transform: [4, 0, 0, 5, 620, 840],
        color: '#c74624',
        adjustments: { dx: 14, dy: -11, scale: 1.2 },
      },
    ],
  };

  const extracted = extractLayerAdjustmentsFromArtwork(artwork);
  assert.ok(extracted['1']);
  assert.equal(extracted['1'].dx, 14);
  assert.equal(extracted['1'].dy, -11);
  assert.equal(extracted['1'].scale, 1.2);
  assert.equal(extracted['0'], undefined);

  // Testa idempotência ao aplicar duas vezes o mesmo ajuste
  const syntheticLayer: any = {
    name: '98',
    left: 460,
    top: 620,
    right: 780,
    bottom: 860,
    text: {
      text: '98',
      transform: [4, 0, 0, 5, 620, 840],
      style: { fontSize: 50 },
    },
  };
  applyPartAdjustmentToPsdLayer(syntheticLayer, extracted['1']);
  const afterFirst = [...syntheticLayer.text.transform];
  assert.ok(Math.abs(afterFirst[0] - 4.8) < 0.01);
  assert.ok(Math.abs(afterFirst[3] - 6.0) < 0.01);
  assert.ok(Math.abs(afterFirst[4] - 634) < 0.5);
  // Pivot Y = origCy (740): 740 + (840 - 740) * 1.2 - 11 = 849
  assert.ok(Math.abs(afterFirst[5] - 849) < 0.5);

  // Segunda aplicação no mesmo layer já ajustado NÃO deve dobrar deslocamento nem escala
  applyPartAdjustmentToPsdLayer(syntheticLayer, extracted['1']);
  const afterSecond = [...syntheticLayer.text.transform];
  assert.ok(Math.abs(afterSecond[0] - afterFirst[0]) < 0.01);
  assert.ok(Math.abs(afterSecond[3] - afterFirst[3]) < 0.01);
  assert.ok(Math.abs(afterSecond[4] - afterFirst[4]) < 0.5);
  assert.ok(Math.abs(afterSecond[5] - afterFirst[5]) < 0.5);

  // Exportação completa via exportDerivedPsdDirect preserva os ajustes no PSD salvo
  const rawPsd = {
    width: 1000,
    height: 1400,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3,
    children: [
      {
        name: '4',
        left: 120,
        top: 600,
        right: 420,
        bottom: 1000,
        text: { text: '4', transform: [6, 0, 0, 8, 270, 980], style: { fontSize: 50 } },
      },
      {
        name: '98',
        left: 460,
        top: 620,
        right: 780,
        bottom: 860,
        text: { text: '98', transform: [4, 0, 0, 5, 620, 840], style: { fontSize: 50 } },
      },
    ],
  };
  const srcBuffer = writePsd(rawPsd as any);
  let exportedBytes: Uint8Array | null = null;
  const exportRes = await exportDerivedPsdDirect(
    {
      sourcePsdBuffer: srcBuffer,
      outputPsdPath: 'C:\\Saida\\papel-ajustado.psd',
      title: 'GIOPACK',
      whole: '4',
      fraction: '98',
      layerAdjustments: extracted,
      roles: { wholeLayerId: '0', fractionLayerId: '1' },
    },
    {
      readSourcePsd: async () => srcBuffer,
      writeOutputPsd: async (_out, _src, bytes) => {
        exportedBytes = bytes;
        return { fileSize: bytes.byteLength };
      },
    }
  );
  assert.equal(exportRes.ok, true);
  assert.ok(exportedBytes);
  const reloaded = readPsd(exportedBytes!.buffer as any);
  const fracLayer = reloaded.children![1];
  assert.ok(fracLayer.text?.transform);
  assert.ok(Math.abs(fracLayer.text!.transform![0] - 4.8) < 0.05);
  assert.ok(Math.abs(fracLayer.text!.transform![3] - 6.0) < 0.05);
  assert.ok(Math.abs(fracLayer.text!.transform![4] - 634) < 1);
  assert.ok(Math.abs(fracLayer.text!.transform![5] - 849) < 1);
});

test('computeWheelScaledValue redimensiona camada via rolagem do mouse com suporte a Shift (fino) e limites seguros', async () => {
  const { computeWheelScaledValue } = await import('../src/components/editor/PosterView');

  // Rolar para cima (deltaY < 0) aumenta 4%
  assert.equal(computeWheelScaledValue(1, -120, false), 1.04);
  // Rolar para baixo (deltaY > 0) diminui 4%
  assert.equal(computeWheelScaledValue(1, 120, false), 0.96);
  // Shift + rolagem aplica ajuste fino de 1%
  assert.equal(computeWheelScaledValue(1, -120, true), 1.01);
  assert.equal(computeWheelScaledValue(1, 120, true), 0.99);
  // Respeita limites mínimo (0.4) e máximo (2.5)
  assert.equal(computeWheelScaledValue(0.4, 120, false), 0.4);
  assert.equal(computeWheelScaledValue(2.5, -120, false), 2.5);
  // deltaY === 0 mantém a escala atual
  assert.equal(computeWheelScaledValue(1.15, 0, false), 1.15);
});

test('Fidelidade de fonte Arial Regular (ArialMT) em Complemento/Categoria: mantém peso 400 sem forçar negrito 900', async () => {
  const { resolveFontWeight } = await import('../src/components/editor/importedRenderer');

  assert.equal(resolveFontWeight('ArialMT', '900'), '400');
  assert.equal(resolveFontWeight('Arial', '900'), '400');
  assert.equal(resolveFontWeight('Arial-BoldMT', '400'), '700');
  assert.equal(resolveFontWeight('Arial-Black', '400'), '900');

  const usedFonts: string[] = [];
  const fakeCanvas: any = {
    width: 800,
    height: 1131,
    getContext: () => ({
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineJoin: 'miter',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      set font(val: string) {
        usedFonts.push(val);
      },
      get font() {
        return usedFonts[usedFonts.length - 1] ?? '';
      },
      fillRect() {},
      drawImage() {},
      save() {},
      restore() {},
      translate() {},
      scale() {},
      transform() {},
      measureText: (txt: string) => ({ width: txt.length * 14 }),
      strokeText() {},
      fillText() {},
    }),
  };

  const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      onload?: () => void;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  });
  try {
    const artwork: ImportedArtwork = {
      kind: 'imported-psd',
      compatibility: 'ready',
      source: { fileName: 'papel.psd', sha256: 'd'.repeat(64) },
      canvas: { width: 1000, height: 1400, resolutionPpi: 300, fit: 'contain' },
      staticBackground: pixel,
      originalPreview: pixel,
      warnings: [],
      layers: [],
      priceParts: [
        {
          role: 'whole',
          layerId: '1',
          originalText: '4',
          bounds: { left: 100, top: 700, right: 400, bottom: 1200 },
          fontFamily: 'Zullia',
          fontSize: 50,
          color: '#c74624',
        },
      ],
      templateParts: [
        {
          role: 'complement',
          layerId: '2',
          originalText: '30CMX4M',
          bounds: { left: 350, top: 560, right: 650, bottom: 640 },
          fontFamily: 'ArialMT',
          fontSize: 23.74,
          transform: [2.2, 0, 0, 4.16, 500, 635],
          color: '#000000',
        },
      ],
    };

    await drawImported(fakeCanvas, artwork, '4,98', 800, 1131, undefined, {
      complement: '30CMX4M',
    });

    const arialFontUsed = usedFonts.find(f => f.includes('ArialMT'));
    assert.ok(arialFontUsed, 'Deve usar fonte ArialMT na camada de complemento');
    assert.ok(arialFontUsed!.startsWith('400 '), `Esperava peso 400 para ArialMT Regular, recebeu: ${arialFontUsed}`);
  } finally {
    if (imageDescriptor) {
      Object.defineProperty(globalThis, 'Image', imageDescriptor);
    } else {
      delete (globalThis as Record<string, unknown>).Image;
    }
  }
});






