const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const USAGES={'composition-lighting':'只参考构图光色',look:'画风基准'};
const LIMIT=20;
const globalCatalog=()=>({scope:'global',state:'unknown',preferencesKnown:false,reason:'not-requested',readMore:'toon styles catalog --json',application:'独立全局视频画风库；本作品摘要未读取全局喜好。旧作品收藏不代表全局收藏，收藏也不自动应用作品。'});
const invalid=()=>Object.assign(new Error('画风参考返回的作品范围或结构无效'),{code:'STYLE_SUMMARY_INVALID'});
const bounded=(value,max=180)=>typeof value==='string'?value.replace(/[\u0000-\u001f]/g,' ').slice(0,max):undefined;
const fields=(value,keys,max=180)=>Object.fromEntries(keys.filter(key=>typeof value?.[key]==='string').map(key=>[key,bounded(value[key],max)]));
function notePreview(value,max=300){return typeof value==='string'?{notesPreview:bounded(value,max),notesCharacters:value.length,notesTruncated:value.length>max}:{};}
function snapshot(source){
 if(!plain(source))return null;
 const result=fields(source,['id','title','kind','provenance','sourceLabel','benchmarkId','benchmarkTitle','categoryId','categoryName','styleId','styleName','modelId','modelName','sourceImageId','sourceReferenceId','sceneGroup','usage']);
 if(typeof source.sha256==='string'&&/^[a-f0-9]{64}$/.test(source.sha256))result.sha256=source.sha256;
 if(typeof source.sourceSha256==='string'&&/^[a-f0-9]{64}$/.test(source.sourceSha256))result.sourceSha256=source.sourceSha256;
 if(Number.isSafeInteger(source.sourceBytes)&&source.sourceBytes>=0)result.sourceBytes=source.sourceBytes;
 if(Number.isSafeInteger(source.bytes)&&source.bytes>=0)result.bytes=source.bytes;
 if(typeof source.verifiedOutput==='boolean')result.verifiedOutput=source.verifiedOutput;
 if(plain(source.director))result.director=fields(source.director,['id','nameZh','nameEn'],100);else if(typeof source.director==='string')result.director=bounded(source.director,100);
 if(plain(source.upstream))result.upstream=fields(source.upstream,['repository','commit','manifestSha256','licenseStatus']);
 if(plain(source.actualMetrics))result.actualMetrics=Object.fromEntries(['width','height','duration','durationSeconds','fps','frames'].filter(key=>typeof source.actualMetrics[key]==='number'&&Number.isFinite(source.actualMetrics[key])&&source.actualMetrics[key]>=0).map(key=>[key,source.actualMetrics[key]]));
 return result;
}
/** Whitelist only saved selection facts. Never enrich old snapshots from live
 * samples, or copy sample prompts, file paths, image URLs or unknown objects. */
export function summarizeStyleReferences(value,workId){
 if(!plain(value)||typeof value.workId!=='string'||value.workId.toLowerCase()!==workId.toLowerCase()||!Number.isSafeInteger(value.selectionRevision)||value.selectionRevision<0||!Object.hasOwn(value,'selection')||value.selection!==null&&!plain(value.selection)||!Array.isArray(value.samples)||!Array.isArray(value.preferences))throw invalid();
 const selected=value.selection;
 if(selected&&(typeof selected.sampleId!=='string'||!Object.hasOwn(USAGES,selected.usage)||!plain(selected.snapshot)))throw invalid();
 const favorites=value.preferences.filter(item=>plain(item)&&item.favorite===true),catalog=new Map(value.samples.filter(plain).map(item=>[item.id,item]));
 const result={workId,scope:'work',preferenceScope:'work',globalCatalog:globalCatalog(),state:'loaded',selectionKnown:true,selectionRevision:value.selectionRevision,selection:selected?{sampleId:bounded(selected.sampleId,220),usage:selected.usage,usageLabel:USAGES[selected.usage],...notePreview(selected.notes),...fields(selected,['selectedAt'],50),scope:{workId,appliesTo:'new-creation-reference',usage:selected.usage,changesWorkStyle:false,automaticallyBindsModelInput:false},snapshot:snapshot(selected.snapshot),currentSourceChanged:typeof selected.currentSourceChanged==='boolean'?selected.currentSourceChanged:typeof value.currentSourceChanged==='boolean'?value.currentSourceChanged:null,currentSourceAvailable:typeof selected.currentSourceAvailable==='boolean'?selected.currentSourceAvailable:typeof value.currentSourceAvailable==='boolean'?value.currentSourceAvailable:null}:null,favoritesKnown:true,favorites:favorites.slice(0,LIMIT).map(item=>{const sample=catalog.get(item.sampleId);return {sampleId:bounded(item.sampleId,220),rating:Number.isInteger(item.rating)&&item.rating>=0&&item.rating<=5?item.rating:null,revision:Number.isSafeInteger(item.revision)?item.revision:null,...fields(sample,['title','kind','categoryName','modelName','styleName','sourceLabel'],140),...notePreview(item.notes,200),sourceListed:Boolean(sample)};}),favoritesSummary:{count:favorites.length,shown:Math.min(favorites.length,LIMIT),limit:LIMIT},preferenceCount:value.preferences.length,application:'作品级参考只按已保存用途供新创作引用，不替代当前work.style；这里的收藏仅为旧作品级喜好，不挪为全局收藏。不会自动改旧媒体、分镜或执行稿，也不会把参考图片自动绑定给模型。verifiedOutput与SHA只表示真实产物登记/文件证据，不代表主观画质通过。',readMore:`toon styles state --work ${workId} --json`};
 if(selected&&result.selection.currentSourceChanged===true)result.warnings=[{code:'style-reference-source-changed',message:'当前参考源与选样时快照有变化，保留旧快照；请用styles state核对后明确重新选择。'}];
 return result;
}
/** An older/unavailable API must remain unknown, never become “not selected”. */
export async function readStyleReferenceSummary(read,workId){
 try{return summarizeStyleReferences(await read(),workId);}
 catch(error){return {workId,scope:'work',preferenceScope:'work',globalCatalog:globalCatalog(),state:'unknown',selectionKnown:false,favoritesKnown:false,reason:error.status===404?'unsupported':error.code==='STYLE_SUMMARY_INVALID'?'invalid-response':'unavailable',readMore:`toon styles state --work ${workId} --json`,warnings:[{code:'style-references-unavailable',...(Number.isInteger(error.status)?{status:error.status}:{}),message:'无法核对本作品的已选画风参考与收藏；状态为未知，不代表尚未选择。请读取styles state核对当前服务与作品权限。'}]};}
}
