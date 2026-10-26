import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { createDocument } from '../src/features/cartazes/serialization';
import type { IndexedCartaz } from '../src/features/cartazes/f7';
import { comparePrices } from '../src/features/importacao/comparison';
import type { DbfProduct } from '../src/features/importacao/types';
import { canSelect, changedPaths, commitUpdates, dirtyPaths, isBlockedInEditor, prepareUpdates, selectedProposals, selectionKey, type Review } from '../src/features/importacao/updates';
import { PriceConfirmation } from '../src/components/importacao/PriceConfirmation';

const clean = { path:null,dirty:false };
function product(f7 = '001245', price = 349): DbfProduct { return {record:1,codeRaw:f7,f7,description:'REPOLHO',priceCents:price,alternativeCents:price,barcode:'000123',referenceRaw:(price/100).toFixed(2),alternativeRaw:(price/100).toFixed(2),issues:[]}; }
function cartaz(path='C:/Biblioteca/a.skcartaz'): IndexedCartaz { const document=createDocument();document.product.productCode='001245';return {path,fileName:path,document,source:JSON.stringify(document)}; }

test('milhares de produtos DBF com um cartaz: somente esse documento é selecionável', () => {
  const products=Array.from({length:5000},(_,i)=>({...product(String(i+1)),record:i+1}));
  products.push(product());
  const rows=comparePrices(products,[cartaz()]);
  const valid=rows.filter(row=>canSelect(row,clean)); assert.equal(valid.length,1);
  const selected=new Set(valid.map(selectionKey));
  const proposals=selectedProposals(rows,selected,clean); assert.equal(proposals.length,1); assert.equal(proposals[0].f7,'001245');
  assert.equal(proposals[0].oldPriceCents,289); assert.equal(proposals[0].newPriceCents,349);
});
test('seleção ignora iguais/sem cartaz/inválidos e bloqueia qualquer variante conflitante', () => {
  const equal=comparePrices([product('001245',289)],[cartaz()])[0]; assert.equal(canSelect(equal,clean),false);
  const missing=comparePrices([product()],[])[0]; assert.equal(canSelect(missing,clean),false);
  const invalid=comparePrices([{...product(),issues:['erro']}],[cartaz()])[0]; assert.equal(canSelect(invalid,clean),false);
  const conflicts=comparePrices([product(),product('001245',399)],[cartaz()]);
  for(const row of conflicts){assert.equal(canSelect(row,clean),false);assert.throws(()=>selectedProposals(conflicts,new Set([selectionKey(row)]),clean));}
});
test('mesmo F7/UUID em caminhos diferentes permite selecionar um arquivo individual', () => {
  const a=cartaz();const b={...a,path:'C:/Biblioteca/Outra/b.skcartaz'};
  const rows=comparePrices([product()],[a,b]);assert.notEqual(selectionKey(rows[0]),selectionKey(rows[1]));
  const proposals=selectedProposals(rows,new Set([selectionKey(rows[1])]),clean);
  assert.equal(proposals.length,1);assert.equal(proposals[0].path,b.path);assert.equal(proposals[0].documentId,a.document.id);
});
test('edição pendente bloqueia seleção e envia o caminho atual ao backend', () => {
  const row=comparePrices([product()],[cartaz()])[0];const guard={path:'c:\\biblioteca\\a.skcartaz',dirty:true};
  assert.ok(isBlockedInEditor(row,guard));assert.equal(canSelect(row,guard),false);
  assert.throws(()=>selectedProposals([row],new Set([selectionKey(row)]),guard));
  assert.deepEqual(dirtyPaths(guard),[guard.path]); assert.deepEqual(dirtyPaths({...guard,dirty:false}),[]);
  assert.ok(canSelect(row,{path:'C:/outro.skcartaz',dirty:true}));
});
test('snapshot preserva conteúdo exato e revisão exibe preços/arquivos/conflitos e exige aceite', () => {
  const item=cartaz();const row=comparePrices([product()],[item])[0];
  assert.equal(selectedProposals([row],new Set([selectionKey(row)]),clean)[0].source,item.source);
  const review:Review={id:'plano',action:'update',dbfName:'consulta.dbf',ignoredConflicts:4,changes:[{path:item.path,documentId:item.document.id,f7:'001245',name:'REPOLHO',oldPriceCents:289,newPriceCents:349}]};
  const html=renderToStaticMarkup(<PriceConfirmation review={review} saving={false} confirm={()=>{throw Error('Não confirmar ao renderizar');}} cancel={()=>{}}/>);
  for(const value of ['2,89','3,49','001245','REPOLHO','4 F7','required','disabled','Confirmar e salvar'])assert.ok(html.includes(value));
});
test('IPC de preparo não grava; confirmação é comando separado com guarda atual, offline', async t => {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{crypto:globalThis.crypto}});
  t.mock.method(globalThis,'fetch',()=>{throw Error('Sem internet');});
  const calls:{cmd:string;args:any}[]=[];
  mockIPC((cmd,args)=>{calls.push({cmd,args});if(cmd==='prepare_price_updates')return {id:'plano'};return {entries:[],stopped:false,errors:[]};});
  try {
    const rows=comparePrices([product()],[cartaz()]);
    await prepareUpdates('consulta.dbf',selectedProposals(rows,new Set([selectionKey(rows[0])]),clean),['999'],clean);
    assert.deepEqual(calls.map(call=>call.cmd),['prepare_price_updates']);
    await commitUpdates('plano',{path:'C:/Biblioteca/a.skcartaz',dirty:true});
    assert.equal(calls[1].cmd,'commit_price_updates');assert.equal(calls[1].args.confirmed,true);
    assert.deepEqual(calls[1].args.dirtyPaths,['C:/Biblioteca/a.skcartaz']);
  } finally {clearMocks();if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else Reflect.deleteProperty(globalThis,'window');}
});
