export const STYLE_REFERENCE_USAGES=[{id:'composition-lighting',label:'只参考构图光色'},{id:'look',label:'画风基准'}];
export const STYLE_REFERENCE_SCOPES=[{id:'benchmark',label:'画风样片'},{id:'community',label:'社区参考'},{id:'work',label:'本作品样片'},{id:'all',label:'全部样片'}];
export const STYLE_REFERENCE_CATEGORIES={cinematic:'电影写实',anime:'动漫',illustration:'插画绘本',material:'材质工艺'};
export const STYLE_REFERENCE_GROUPS={'railway-station':'铁路站场景','post-festival-square':'节庆后的广场','work-generated':'本作品生成样片','work-imported':'本作品导入样片'};
export const styleArray=value=>Array.isArray(value)?value:[];
export function styleDirectorName(sample){const director=sample?.director;return typeof director==='string'?director:director?.nameZh||director?.nameEn||director?.name||'';}
export function styleGroupName(group,groups=[]){return styleArray(groups).find(item=>item.id===group)?.name||styleArray(groups).find(item=>item.id===group)?.label||STYLE_REFERENCE_GROUPS[group]||group||'其他参考';}
export function styleSampleScope(sample){return sample?.benchmarkId?'benchmark':['upstream-example','upstream-animation'].includes(sample?.provenance)?'community':['work-generated','work-imported'].includes(sample?.provenance)?'work':'other';}
export function styleProvenanceLabel(sample){return styleSampleScope(sample)==='benchmark'?'统一场景样片':{'upstream-example':'上游风格示例','work-generated':'本作品生成样片','work-imported':'本作品导入样片'}[sample?.provenance]||'来源待核对';}
export const styleModelKey=sample=>sample?.modelId||sample?.modelName||'unrecorded';
export const styleModelName=sample=>sample?.modelName||sample?.modelId||'模型未记录';
export const styleLookKey=sample=>sample?.styleId||sample?.styleName||sample?.director?.id||(typeof sample?.director==='string'?sample.director:'unrecorded');
export const styleLookName=sample=>sample?.styleName||styleDirectorName(sample)||'画风未记录';
export function styleFriendlySource(sample){
 if(sample?.provenance==='upstream-example')return '社区原图';
 if(sample?.status==='pending')return sample.kind==='video'?'视频待生成':'图片待生成';
 if(sample?.verifiedOutput===true&&sample.available!==false){const model=`${sample.modelId||''} ${sample.modelName||''}`;if(sample.kind==='image'&&/gpt/i.test(model))return 'GPT 静帧实测';if(sample.kind==='video'&&/h3/i.test(model)&&/gb10/i.test(model))return 'GB10 H3 实测';}
 if(sample?.provenance==='work-imported')return '作品导入样片';
 if(sample?.provenance==='work-generated')return '作品生成样片';
 return sample?.kind==='video'?'视频样片':'静帧样片';
}
function isCommunityFilmReference(sample){const id=sample?.director?.id;if(!id||!['railway-station','post-festival-square'].includes(sample?.sceneGroup))return false;return sample.provenance==='upstream-example'&&sample.id===`reference:${id}`||sample.provenance==='upstream-animation'&&sample.id===`community-video:${id}`&&sample.sourceReferenceId===`reference:${id}`;}
export const styleCategoryKey=sample=>sample?.categoryId||(typeof sample?.category==='string'?sample.category:sample?.category?.id)||(isCommunityFilmReference(sample)?'cinematic':'unclassified');
export const styleCategoryName=sample=>sample?.categoryName||sample?.category?.name||STYLE_REFERENCE_CATEGORIES[styleCategoryKey(sample)]||(styleCategoryKey(sample)==='unclassified'?'未分类':styleCategoryKey(sample));
export function styleMediaUrl(value){return typeof value==='string'&&/^\/api\/(?:style-references\/(?:samples|benchmarks|community-videos)\/|works\/)/.test(value)&&!/[\u0000-\u001f\\]/.test(value)?value:null;}
export function filterStyleSamples(samples,{query='',group='all',scope='all',category='all',model='all',look='all',kind='all'}={}){const needle=query.trim().toLocaleLowerCase();return styleArray(samples).filter(sample=>(scope==='all'||styleSampleScope(sample)===scope)&&(category==='all'||styleCategoryKey(sample)===category)&&(group==='all'||sample.sceneGroup===group)&&(model==='all'||styleModelKey(sample)===model)&&(look==='all'||styleLookKey(sample)===look)&&(kind==='all'||sample.kind===kind)&&(!needle||[sample.title,styleDirectorName(sample),sample.director?.nameEn,sample.director?.id,sample.sourceLabel,sample.benchmarkTitle,styleModelName(sample),styleLookName(sample),styleCategoryName(sample)].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))).sort((a,b)=>Number(Boolean(b.benchmarkId))-Number(Boolean(a.benchmarkId)));}
export function stylePreference(preference){return {rating:Number.isInteger(preference?.rating)&&preference.rating>=0&&preference.rating<=5?preference.rating:0,notes:typeof preference?.notes==='string'?preference.notes:'',favorite:preference?.favorite===true};}
export function stylePreferenceChanged(draft,saved){return JSON.stringify(stylePreference(draft))!==JSON.stringify(stylePreference(saved));}
export function stylePreferencePayload(workId,sampleId,draft,saved){
 const value=stylePreference(draft),revision=saved?.revision??0;
 if(!Number.isInteger(revision)||revision<0)throw new Error('评价版本未能核实，请重新读取后再保存。');
 if(!draft||!Number.isInteger(draft.rating)||draft.rating<0||draft.rating>5||typeof draft.favorite!=='boolean'||typeof draft.notes!=='string'||draft.notes.length>2000)throw new Error('请使用 0–5 分，并将评价限制在 2000 字以内。');
 return {...(workId?{workId}:{}),sampleId,...value,expectedRevision:revision};
}
export function styleSelectionPayload(workId,sampleId,usage,notes,revision){
 if(!sampleId)throw new Error('请先预览一张参考画面。');
 if(!STYLE_REFERENCE_USAGES.some(item=>item.id===usage))throw new Error('请选择参考用途。');
 if(typeof notes!=='string'||notes.length>2000)throw new Error('参考说明不能超过 2000 字。');
 if(!Number.isInteger(revision)||revision<0)throw new Error('作品参考版本未能核实，请重新读取后再保存。');
 return {workId,sampleId,usage,notes,expectedRevision:revision};
}
export function styleImageVideoPairs(samples){
 const source=styleArray(samples),images=source.filter(sample=>sample.kind==='image');
 return images.flatMap(image=>{
  const prefix=`benchmark:${image.benchmarkId}:`,videos=source.filter(video=>{
   if(video.kind!=='video')return false;
   if(image.benchmarkId&&image.styleId&&typeof image.id==='string'&&image.id.startsWith(prefix)){
    if(video.benchmarkId!==image.benchmarkId||video.styleId!==image.styleId||typeof video.id!=='string'||!video.id.startsWith(prefix)||typeof video.sourceImageId!=='string')return false;
    const sourceId=video.sourceImageId.startsWith('benchmark:')?video.sourceImageId:/^[a-zA-Z0-9_-]+$/.test(video.sourceImageId)?prefix+video.sourceImageId:null;
    return sourceId===image.id;
   }
   if(image.provenance!=='upstream-example'||video.provenance!=='upstream-animation'||image.benchmarkId||video.benchmarkId||typeof image.id!=='string'||!image.id.startsWith('reference:')||video.id!==`community-video:${image.id.slice('reference:'.length)}`||!image.sceneGroup||video.sceneGroup!==image.sceneGroup)return false;
   const imageStyle=image.styleId||image.director?.id;if(!imageStyle||video.styleId!==imageStyle)return false;
   const references=[video.sourceImageId,video.sourceReferenceId].filter(value=>value!==undefined);return references.length>0&&references.every(value=>value===image.id);
  });
  return videos.length?[{id:image.id,image,videos}]:[];
 });
}
export function stylePairForSample(pairs,id){return styleArray(pairs).find(pair=>pair.image.id===id||pair.videos.some(video=>video.id===id))||null;}
export function stylePairedGallerySamples(visible,pairs){
 const imageIds=new Set(styleArray(visible).filter(sample=>sample.kind==='image').map(sample=>sample.id));
 return styleArray(visible).filter(sample=>sample.kind!=='video'||!styleArray(pairs).some(pair=>imageIds.has(pair.image.id)&&pair.videos.some(video=>video.id===sample.id)));
}
export function stylePairSnapshot(pair){return pair?JSON.parse(JSON.stringify(pair)):null;}
export function stylePairMediaReady(sample){return Boolean(styleMediaUrl(sample?.url))&&sample?.available!==false&&['available','ready'].includes(sample?.status);}
export function stylePairSeekTime(requested,duration){return typeof requested==='number'&&Number.isFinite(requested)&&requested>=0&&typeof duration==='number'&&Number.isFinite(duration)&&duration>0?Math.min(requested,duration):null;}
export function styleCardName(sample){return sample?.styleName||styleDirectorName(sample)||sample?.title||'未命名画风';}
export function styleCardPreview(sample,pair,{kind='all',model='all'}={}){return sample?.kind==='image'&&pair&&kind!=='image'?pair.videos.find(video=>stylePairMediaReady(video)&&(model==='all'||styleModelKey(video)===model))||sample:sample?.kind==='video'&&!stylePairMediaReady(sample)&&pair?pair.image:sample;}
export function styleCardReference(sample,pair){return pair?.image||sample?.kind==='image'&&sample||null;}
export function styleMetricFacts(sample){
 const value=sample?.actualMetrics;if(!value||typeof value!=='object')return [];
 const facts=[],positive=number=>typeof number==='number'&&Number.isFinite(number)&&number>0;
 if(positive(value.width)&&positive(value.height))facts.push(`${value.width} × ${value.height}`);
 const duration=value.durationSeconds??value.duration;if(positive(duration))facts.push(`${Number(duration.toFixed(3))} 秒`);
 if(positive(value.fps))facts.push(`${Number(value.fps.toFixed(3))} fps`);
 if(recordedNumber(value.productionMs))facts.push(`生产 ${styleMilliseconds(value.productionMs)}`);
 else if(sample.kind==='image'&&recordedNumber(value.generationMs))facts.push(`出图工具调用 ${styleMilliseconds(value.generationMs)}`);
 return facts;
}
const recordedNumber=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function styleMilliseconds(value){
 if(!recordedNumber(value))return '未记录';
 const seconds=value/1000;if(seconds<60)return `${Number(seconds.toFixed(3))} 秒`;
 const minutes=Math.floor(seconds/60),remaining=Number((seconds%60).toFixed(3));return `${minutes} 分 ${remaining} 秒`;
}
export function styleProductionRecord(sample){
 const metrics=sample?.actualMetrics&&typeof sample.actualMetrics==='object'?sample.actualMetrics:{},rates=metrics.rates&&typeof metrics.rates==='object'?metrics.rates:null,number=(value,unit='')=>recordedNumber(value)?`${Number(value.toFixed(3))}${unit}`:'未记录';
 const rows=[{label:'实际分辨率',value:recordedNumber(metrics.width)&&metrics.width>0&&recordedNumber(metrics.height)&&metrics.height>0?`${metrics.width} × ${metrics.height}`:'未记录'}];
 if(sample?.kind==='video')rows.push({label:'视频轨实际时长',value:number(metrics.durationSeconds??metrics.duration,' 秒')},{label:'容器实际时长',value:number(metrics.containerDurationSeconds,' 秒')},{label:'实际帧数 / 帧率',value:`${number(metrics.frames,' 帧')} / ${number(metrics.fps,' fps')}`},{label:'音轨',value:metrics.hasAudio===true?'已记录存在音轨':metrics.hasAudio===false?'已记录无音轨':'未记录'});
 const timings=[{label:'排队耗时',value:styleMilliseconds(metrics.queueMs)},{label:'整体生产耗时',value:styleMilliseconds(metrics.productionMs)},{label:'服务器工作流耗时',value:styleMilliseconds(metrics.serverExecutionMs)},{label:'提交至登记总耗时',value:styleMilliseconds(metrics.totalMs)}];
 if(sample?.kind==='image'||recordedNumber(metrics.generationMs))timings.push({label:'出图工具调用墙钟',value:styleMilliseconds(metrics.generationMs)});
 const rateRows=sample?.kind==='video'?[{label:'每视频秒所需生产时间',value:number(rates?.secondsPerVideoSecond,' 秒 / 视频秒')},{label:'每生产分钟产出视频',value:number(rates?.videoSecondsPerMinute,' 视频秒 / 生产分钟')},{label:'实际生产帧率',value:number(rates?.productionFps,' 帧 / 生产秒')},{label:'服务器工作流帧率',value:number(rates?.serverFps,' 帧 / 工作流秒')}]:[];
 return {model:styleModelName(sample),modelRevision:typeof metrics.modelRevision==='string'&&metrics.modelRevision?metrics.modelRevision:typeof sample?.modelRevision==='string'&&sample.modelRevision?sample.modelRevision:'未记录',sourceLabel:typeof sample?.sourceLabel==='string'&&sample.sourceLabel?sample.sourceLabel:'未记录',sourceSha256:typeof sample?.sha256==='string'&&/^[a-f0-9]{64}$/i.test(sample.sha256)?sample.sha256:'未记录',rows,timings,rateRows,metrics,parameters:metrics.parameters??null,rates,prompt:typeof sample?.prompt==='string'&&sample.prompt.trim()?sample.prompt:null};
}
