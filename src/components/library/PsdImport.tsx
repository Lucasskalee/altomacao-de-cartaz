import { useMemo, useState } from 'react';
import { analyzePsd, buildArtwork, extractPriceFromRoles, type PsdAnalysis, type PsdRoleMap } from '../../features/psd/importer';
import { selectPsd } from '../../features/psd/service';
import { createDocument } from '../../features/cartazes/serialization';
import { chooseSave, saveDocument } from '../../features/cartazes/storage';
import { digitsOnly } from '../../features/cartazes/f7';
import { fileName, priceToCents } from '../../features/cartazes/validation';
import { PosterView } from '../editor/PosterView';
import { importedPriceWarning } from '../editor/importedRenderer';
import type { ImportedPriceRole } from '../../features/cartazes/types';

type Props={close:()=>void;saved:(path:string)=>Promise<void>};
const roleLabels:Record<ImportedPriceRole,string>={whole:'Reais',fraction:'Centavos',decimal:'Vírgula',fractionRule:'Linha dos centavos'};

export function PsdImport({close,saved}:Props) {
  const [analysis,setAnalysis]=useState<PsdAnalysis|null>(null),[roles,setRoles]=useState<PsdRoleMap>({});
  const [name,setName]=useState(''),[complement,setComplement]=useState(''),[unit,setUnit]=useState(''),[f7,setF7]=useState(''),[price,setPrice]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const artwork=useMemo(()=>{if(!analysis)return null;try{return buildArtwork(analysis,roles);}catch{return null;}},[analysis,roles]);
  const validPrice=useMemo(()=>{try{priceToCents(price);return true;}catch{return false;}},[price]);
  const priceWarning=artwork&&validPrice?importedPriceWarning(artwork,price):'';
  const select=async()=>{
    setBusy(true);setError('');
    try {
      const selected=await selectPsd(); if(!selected)return;
      const result=await analyzePsd(selected.buffer,selected.name);
      setAnalysis(result); setRoles(result.suggested);
      setName(result.metadata.name); setComplement(result.metadata.complement);
      setUnit(result.metadata.unit); setPrice(result.metadata.price);
    }
    catch(ex){setError(String(ex));setAnalysis(null);} finally{setBusy(false);}
  };
  const save=async()=>{
    if(!analysis||!artwork)throw new Error('Conclua o mapeamento das camadas do preço.');
    if(artwork.compatibility!=='ready')throw new Error('A arte requer preparação e não pode ser salva como editável.');
    if(!price.trim())throw new Error('Informe ou confirme o preço do cartaz.');
    if(priceWarning)throw new Error(priceWarning);
    const document=createDocument(); const now=new Date().toISOString();
    document.product={...document.product,name:name.trim().toUpperCase(),complement:complement.trim().toUpperCase(),unit:unit.trim().toUpperCase(),productCode:f7||null,priceCents:priceToCents(price)};
    document.layout={template:'imported-psd',paper:'A5',orientation:'portrait',artwork}; document.metadata={...document.metadata,createdAt:now,updatedAt:now};
    const path=await chooseSave(fileName(`${name}-${complement}`)); if(!path)return;
    await saveDocument(path,document); await saved(path); close();
  };
  const setRole=(role:ImportedPriceRole,id:string)=>{
    setRoles(previous=>{
      const next={...previous,[role]:id||undefined};
      if(analysis&&(role==='whole'||role==='fraction')){
        const extracted=extractPriceFromRoles(analysis.layers,next);
        if(extracted)setPrice(extracted);
      }
      return next;
    });
  };
  return <div className="modal-backdrop psd-backdrop"><section className="panel psd-import" role="dialog" aria-modal="true" aria-labelledby="psd-title">
    <div className="psd-title"><div><h2 id="psd-title">Importar arte PSD</h2><p>O arquivo original será apenas lido. A arte salva ficará independente dele.</p></div><button className="subtle" onClick={close}>Fechar</button></div>
    {!analysis?<div className="psd-empty"><button disabled={busy} onClick={()=>void select()}>{busy?'Analisando…':'Selecionar arquivo PSD'}</button><p>Piloto: um arquivo RGB, 8 bits, até 25 MB e 300 camadas.</p></div>:<>
      <div className="psd-summary"><div><strong>{analysis.fileName}</strong><small>{analysis.width} × {analysis.height}px · {analysis.resolutionPpi} PPI · {analysis.layers.length} camadas</small><small>SHA-256: {analysis.hash}</small></div><button className="subtle" onClick={()=>void select()}>Escolher outro</button></div>
      {(artwork?.warnings??analysis.warnings).map(warning=><p className="import-warning" key={warning}>{warning}</p>)}
      <div className="psd-workspace"><div><h3>Composição original</h3><img className="psd-original" src={analysis.originalPreview} alt="Prévia original incorporada ao PSD"/></div><div><h3>Teste do preço</h3>{artwork&&validPrice?<PosterView poster={{name,detail:complement,unit,price,artwork}}/>:<p className="empty">Mapeie reais e centavos e informe um preço válido para gerar a prévia editável.</p>}{artwork&&<p className={artwork.compatibility==='ready'?'success':'error-text'}>{artwork.compatibility==='ready'?'Compatível com edição de preço':'Requer preparação antes de salvar'}</p>}{priceWarning&&<p className="error-text" role="alert">{priceWarning}</p>}</div></div>
      <fieldset className="psd-fields"><legend>Dados do cartaz</legend><label>Nome<input maxLength={32} placeholder="Extraído das camadas ou informe…" value={name} onChange={event=>setName(event.target.value.toUpperCase())}/></label><label>Complemento<input maxLength={28} placeholder="Opcional" value={complement} onChange={event=>setComplement(event.target.value.toUpperCase())}/></label><label>Preço de teste<input inputMode="decimal" placeholder="Ex.: 2,99" value={price} onChange={event=>setPrice(event.target.value)}/></label><label>Unidade<input maxLength={12} placeholder="Ex.: KG, UN" value={unit} onChange={event=>setUnit(event.target.value.toUpperCase())}/></label><label>Código F7<input inputMode="numeric" value={f7} onChange={event=>setF7(digitsOnly(event.target.value))}/></label></fieldset>
      <h3>Mapeamento do preço</h3><div className="psd-role-grid">{(Object.keys(roleLabels) as ImportedPriceRole[]).map(role=><label key={role}>{roleLabels[role]}<select value={roles[role]??''} onChange={event=>setRole(role,event.target.value)}><option value="">Não mapeada</option>{analysis.layers.filter(layer=>layer.visible&&layer.type!=='group'&&layer.type!=='empty').map(layer=><option value={layer.id} key={layer.id}>{layer.name}{layer.text?` — “${layer.text}”`:''}</option>)}</select></label>)}</div>
      <details className="psd-layers"><summary>Camadas detectadas ({analysis.layers.length})</summary><div className="psd-layer-list">{analysis.layers.map(layer=><div key={layer.id} style={{paddingLeft:layer.depth*16}}><strong>{layer.visible?'●':'○'} {layer.name}</strong><span>{layer.type}{layer.text?` · “${layer.text}”`:''}{layer.font?` · ${layer.font}`:''} · {layer.bounds.left},{layer.bounds.top}–{layer.bounds.right},{layer.bounds.bottom}</span></div>)}</div></details>
      <div className="toolbar"><button disabled={!artwork||artwork.compatibility!=='ready'||!validPrice||Boolean(priceWarning)||!name.trim()||!unit.trim()} onClick={()=>{setBusy(true);setError('');void save().catch(ex=>setError(String(ex))).finally(()=>setBusy(false));}}>{busy?'Salvando…':'Salvar cartaz importado'}</button><button className="subtle" onClick={close}>Cancelar</button></div>
    </>}{error&&<p className="error-text" role="alert">{error}</p>}
  </section></div>;
}
