const list=value=>Array.isArray(value)?value:[];
const TERMINAL=new Set(['succeeded','failed','interrupted']);

/** Use persisted dialogue only; local editor drafts and visual prose are never ASR hints. */
export function savedTranscriptionLines(shot){
 if(shot?.productionCues)return {source:`已保存的逐镜对白${Number.isInteger(shot.productionCues.revision)?` · 修订 ${shot.productionCues.revision}`:''}`,lines:list(shot.productionCues.cues?.dialogue).filter(cue=>typeof cue.text==='string'&&cue.text.trim()).map(cue=>({...(cue.id?{id:cue.id}:{}),text:cue.text}))};
 const text=shot?.executionPrompt?.compilation?.sourceRecipe?.integrated_multimodal_description;
 const lines=typeof text==='string'?[...text.matchAll(/<d>\s*\[Chinese\]([\s\S]*?)<\/d>/g)].map(match=>({text:match[1].trim()})).filter(line=>line.text):[];
 return {source:lines.length?'已保存编译稿中的中文原句':'未记录可提取的原句',lines};
}

export function transcriptionPayload(workId,assetId,text=''){
 if(!workId||!assetId)throw new Error('请先选择当前作品的视频版本。');
 if(typeof text!=='string')throw new Error('核对原句格式无效。');
 const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 if(lines.length>200||text.length>20000||lines.some(line=>line.length>2000))throw new Error('原句请保持在200行、每行2000字、合计20000字以内。');
 return {workId,source:{kind:'asset',id:assetId},...(lines.length?{expectedLines:lines.map(line=>({text:line}))}:{})};
}

export function transcriptionJobsForAsset(jobs,workId,assetId){
 return list(jobs).filter(job=>job.workId===workId&&job.request?.source?.kind==='asset'&&job.request.source.id===assetId).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
}
export function mergeTranscriptionJob(current,next){
 if(!next)return current;
 if(current?.id===next.id&&TERMINAL.has(current.status)&&!TERMINAL.has(next.status))return current;
 return next;
}
export function transcriptionIsActive(job){return job?.status==='queued'||job?.status==='running';}
export function transcriptionTime(seconds){
 if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0)return '未记录';
 const milliseconds=Math.round(seconds*1000),whole=Math.floor(milliseconds/1000);
 return `${String(Math.floor(whole/60)).padStart(2,'0')}:${String(whole%60).padStart(2,'0')}.${String(milliseconds%1000).padStart(3,'0')}`;
}
export function transcriptionLineState(line){
 if(line?.rawExact===true)return {label:'原句检出',color:'green'};
 if(line?.normalized===true)return {label:'规范化后检出',color:'amber'};
 if(line?.rawExact===false||line?.normalized===false)return {label:'未检出 · 请试听',color:'amber'};
 return {label:'未记录',color:'gray'};
}

/** Derived QC only: never clamp model offsets, remove repeated words, or rewrite its evidence. */
export function transcriptionQuality({full,job,segments}={}){
 const measured=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
 const sourceDuration=measured(full?.source?.probe?.duration)??measured(job?.sourceSnapshot?.probe?.duration);
 const inputDuration=measured(full?.audio?.duration)??measured(job?.audio?.duration)??sourceDuration;
 const rows=list(segments),outOfBounds=[],repeated=[];
 for(let index=0;index<rows.length;index++){
  const row=rows[index];
  if(inputDuration!==null&&typeof row.end==='number'&&Number.isFinite(row.end)&&row.end>inputDuration+0.05)outOfBounds.push(index);
  const text=typeof row.text==='string'?row.text.replace(/\s+/g,''):'';
  const previous=typeof rows[index-1]?.text==='string'?rows[index-1].text.replace(/\s+/g,''):'';
  if(text&&text===previous)repeated.push(index);
 }
 const reasons=[outOfBounds.length?'识别时码超出实测原音时长':'',repeated.length?'相邻识别文本重复':''].filter(Boolean);
 return {inputDuration,sourceDuration,outOfBounds,repeated,warning:reasons.length?`${reasons.join('，')}；可能幻听，须听原音。原始转写和时码完整保留。`:null};
}
