const FIELDS=['integrated_multimodal_description','overall_soundscape','non_diegetic_music'];

/** A model-ready recipe is always explicit; production notes are never translated here. */
export function executionRecipe(value){
 const source=value?.draft?.recipe||value?.compilation?.sourceRecipe||value||{};
 return Object.fromEntries([...FIELDS.map(key=>[key,typeof source[key]==='string'?source[key]:'']),['speakers',Array.isArray(source.speakers)?source.speakers.map(speaker=>({label:String(speaker.label||''),characterId:String(speaker.characterId||'')})):[]]]);
}

export function recipeSignature(value){return JSON.stringify(executionRecipe(value));}

export function executionPayload(action,{recipe,revision=0,hash}={}){
 if(action==='preview')return {recipe:executionRecipe(recipe)};
 if(!Number.isInteger(revision)||revision<0)throw new Error('执行稿修订号无效，请刷新后重试。');
 if(action==='lock'){
  if(typeof hash!=='string'||!/^[a-f\d]{64}$/i.test(hash))throw new Error('请先保存编译，再锁定明确的执行稿。');
  return {expectedRevision:revision,expectedHash:hash};
 }
 if(action!=='draft'&&action!=='compile')throw new Error('未知的执行稿操作。');
 const next=executionRecipe(recipe);
 if(!next.integrated_multimodal_description.trim())throw new Error('请先填写英文画面与动作执行稿。');
 if(next.speakers.some(item=>!/^S[1-9]\d*$/.test(item.label)||!item.characterId))throw new Error('请为每个说话标签选择本镜绑定的角色。');
 if(new Set(next.speakers.map(item=>item.label)).size!==next.speakers.length||new Set(next.speakers.map(item=>item.characterId)).size!==next.speakers.length)throw new Error('说话标签和角色不能重复绑定。');
 return {expectedRevision:revision,recipe:next};
}

export async function submitExecutionPrompt({api,workId,shotId,action,recipe,revision,hash}){
 if(!workId||!shotId)throw new Error('请先选定作品和分镜。');
 return api(`/api/works/${workId}/studio/shots/${shotId}/execution-prompt/${action}`,executionPayload(action,{recipe,revision,hash}));
}

export function executionState({status,dirty=false,recipeDirty=false,loading=false}){
 if(loading)return {label:'正在核对',color:'gray',canGenerate:false};
 if(dirty)return {label:'制作资料未保存',color:'amber',canGenerate:false};
 if(recipeDirty)return {label:'执行稿有未保存修改',color:'amber',canGenerate:false};
 const state=status?.state||'missing';
 const labels={missing:'未编译',draft:'执行稿草稿',compiled:'已编译 · 待锁版',locked:'已锁版',stale:'已过期 · 需重新编译'};
 return {label:labels[state]||'待核对',color:state==='locked'?'green':state==='stale'?'amber':'gray',canGenerate:state==='locked'};
}

/** Measurements only belong to the selected media's recorded generation, never a request estimate. */
export function selectedVideoMeasurement(jobs,assetId){
 const job=Array.isArray(jobs)?jobs.find(item=>item.assetId===assetId&&item.status==='succeeded'):null;
 if(!job)return null;
 const output=job.telemetry?.output||{},number=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
 return {jobId:job.id,requestedSeconds:number(job.request?.duration),durationSeconds:number(output.durationSeconds),frames:number(output.frames),fps:number(output.fps)};
}
