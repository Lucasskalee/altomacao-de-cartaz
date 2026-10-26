import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, duplicate, serialize, deserialize } from '../src/features/cartazes/serialization';
import { priceToCents, fileName } from '../src/features/cartazes/validation';
import { renderToStaticMarkup } from 'react-dom/server';
import { PosterView } from '../src/components/editor/PosterView';
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
