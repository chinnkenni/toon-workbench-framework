import {createHash,randomUUID} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS=['integrated_multimodal_description','overall_soundscape','non_diegetic_music'];
const CJK=/[\u3400-\u9fff\uf900-\ufaff]/u;
export const H3_I2VA_HEADER='For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
const clone=value=>structuredClone(value),now=()=>new Date().toISOString();
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(object(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
export function executionHash(value){return createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(canonical(value))??'null').digest('hex');}
function field(value,label,max){if(typeof value!=='string'||!value.trim()||value.length>max)fail(`${label}须为非空文本，最多 ${max} 字`);return value.trim().replace(/\r\n?/g,'\n');}

/** Validation and formatting only. This does not translate, summarize cards, or call a model. */
export function normalizeExecutionRecipe(value,shot){
 if(!object(value)||Object.keys(value).some(key=>![...FIELDS,'speakers'].includes(key)))fail('H3 执行稿只接受三个官方字段和 speakers；不支持 Ref2VA 或制作记录字段');
 const recipe=Object.fromEntries(FIELDS.map((key,index)=>[key,field(value[key],key,[16000,4000,2000][index])]));
 if(!/^\[Shot 1\](?:\s|$)/.test(recipe.integrated_multimodal_description))fail('英文画面执行稿须以 [Shot 1] 开始');
 const speakers=value.speakers??[];
 if(!Array.isArray(speakers)||speakers.length>20)fail('speakers 最多 20 项');
 const labels=new Set(),characters=new Set();
 recipe.speakers=speakers.map((speaker,index)=>{
  if(!object(speaker)||Object.keys(speaker).some(key=>!['label','characterId'].includes(key))||speaker.label!==`S${index+1}`||!UUID.test(speaker.characterId||''))fail('说话人须依次为 S1、S2，并绑定角色 UUID');
  if(!(shot.characterIds||[]).includes(speaker.characterId)||labels.has(speaker.label)||characters.has(speaker.characterId))fail('说话人须唯一绑定当前分镜角色');
  labels.add(speaker.label);characters.add(speaker.characterId);return {label:speaker.label,characterId:speaker.characterId};
 });
 const spoken=[];
 for(const key of FIELDS){
  const content=recipe[key];
  if(/(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*:|For the target video|How the reference pictures align with the target video/i.test(content))fail('字段内不要粘贴完整模板或其他字段；I2VA 首行由实际首帧自动添加');
  for(const [reference] of content.matchAll(/<\/?\s*(?:Picture|Subject)[^<>]*(?:>|$)/gi)){
   if(key!=='integrated_multimodal_description'||reference!=='<Picture 1>'||!UUID.test(shot.firstFrameMediaId||''))fail('正文参考仅允许当前分镜已绑定单张首帧的 <Picture 1>，且须位于 integrated_multimodal_description；不支持其他参考标签');
  }
  if(key!=='integrated_multimodal_description'&&/<\/?d>|\(S\d+\)/.test(content))fail('对白及说话人标签须位于 integrated_multimodal_description');
  const withoutDialogue=content.replace(/<d>\[Chinese\][^<>]+<\/d>/g,'');
  if(/<\/?d>|\[Chinese\]/.test(withoutDialogue))fail('中文原台词须完整写作 <d>[Chinese]原台词</d>，不可嵌套标签');
  const narration=key==='integrated_multimodal_description'?withoutDialogue.replace(/"[^"\n]*"/g,match=>CJK.test(match)?'':match):withoutDialogue;
  if(CJK.test(narration)||CJK.test(withoutDialogue)&&!/[A-Za-z]{3}/.test(narration.replace(/\[Shot\s+\d+\]/g,'')))fail('H3 执行稿须为英文叙述；中文对白放 <d>[Chinese]...</d>，原文屏幕文字用英文双引号，并用英文描述可见位置；不自动翻译制作脚本');
  for(const match of content.matchAll(/\(S(\d+)\)/g))if(!labels.has('S'+match[1]))fail('执行稿出现未声明的说话人标签');
  for(const match of content.matchAll(/<d>\[Chinese\][^<>]+<\/d>/g)){
   const prefix=content.slice(0,match.index),lastSpeaker=[...prefix.matchAll(/\(S\d+\)/g)].at(-1),lastShot=prefix.lastIndexOf('[Shot ');
   if(!lastSpeaker||lastSpeaker.index<lastShot)fail('每段对白前须在本镜声明稳定的 (S1)/(S2) 说话人');
   spoken.push({label:lastSpeaker[0].slice(1,-1),text:match[0].slice('<d>[Chinese]'.length,-'</d>'.length).trim()});
  }
 }
 const firstSpeakers=new Set();
 for(const line of spoken)if(!firstSpeakers.has(line.label)){if(line.label!==`S${firstSpeakers.size+1}`)fail('执行稿首次发声须按 S1、S2 顺序连续编号；不可让回复先于原对话');firstSpeakers.add(line.label);}
 const cues=shot.productionCues?.cues?.dialogue||[];
 if(cues.length){
  for(const [index,cue] of cues.entries()){
   if(!recipe.speakers.some(item=>item.label===cue.speakerLabel&&item.characterId===cue.speakerId))fail(`执行稿说话人 ${cue.speakerLabel} 与制作对白角色不一致；请修正制作记录或 speakers 绑定`);
   if(spoken[index]?.label!==cue.speakerLabel||spoken[index]?.text!==cue.text.trim())fail(`执行稿第 ${index+1} 句须按制作记录顺序逐字保留 ${cue.speakerLabel} 的原台词（含标点）；请修正执行稿或先明确修改制作记录`);
  }
  if(spoken.length>cues.length)fail('执行稿包含制作记录以外的对白；请先保存完整制作对白，再编译执行稿');
 }
 return recipe;
}

async function mediaSnapshot(work,mediaId,resolveMedia){
 const media=work.studio?.media?.find(item=>item.id===mediaId);if(!media)fail('执行稿绑定的同作品素材已不存在',409);
 try{
  const file=await resolveMedia(media),before=await stat(file);if(!before.isFile()||before.size<1||before.size>64*1024*1024)fail('执行稿绑定素材无效或超过 64 MB',409);
  const bytes=await readFile(file),after=await stat(file);if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)fail('核对期间执行稿绑定素材发生变化，请重新检查',409);
  return {...clone(media),sha256:executionHash(bytes),actualBytes:bytes.length};
 }catch(error){if(error.code==='ENOENT')fail('执行稿绑定素材文件已不存在',409);throw error;}
}

/** Full production references stay in this evidence snapshot, never in the model prompt. */
export async function executionSource(work,shot,{resolveMedia}){
 const libraries=work.studio?.libraries||{};
 const entries=(ids,category)=>ids.map(id=>{const entry=libraries[category]?.find(item=>item.id===id);if(!entry)fail('执行稿绑定设定已不存在',409);return clone(entry);});
 const characters=entries(shot.characterIds||[],'characters'),scene=shot.sceneId?entries([shot.sceneId],'scenes')[0]:null,voices=entries(shot.voiceIds||[],'voices');
 const mediaIds=[...new Set([...characters,...(scene?[scene]:[]),...voices].flatMap(entry=>entry.mediaIds||[]).concat(shot.firstFrameMediaId?[shot.firstFrameMediaId]:[]))];
 const media=[];for(const id of mediaIds)media.push(await mediaSnapshot(work,id,resolveMedia));
 const firstFrame=shot.firstFrameMediaId?media.find(item=>item.id===shot.firstFrameMediaId):null;if(firstFrame&&firstFrame.type!=='image')fail('H3 当前仅支持单张图片首帧',409);
 const bindingSnapshot={characterIds:clone(shot.characterIds||[]),sceneId:shot.sceneId||null,voiceIds:clone(shot.voiceIds||[]),firstFrameMediaId:shot.firstFrameMediaId||null,characters,scene,voices,media};
 const cues=shot.productionCues?{schemaVersion:shot.productionCues.schemaVersion,revision:shot.productionCues.revision,cues:clone(shot.productionCues.cues)}:null;
 const sourceSnapshot={workId:work.id,shotId:shot.id,episodeId:shot.episodeId,style:work.style||'',production:{title:shot.title,visual:shot.visualInstructions??shot.prompt??'',legacyPromptHash:executionHash(shot.prompt||''),sound:shot.soundInstructions||'',music:shot.musicInstructions||'',skillIds:clone(shot.skillIds||[]),skillSnapshot:clone(shot.skillSnapshot||[]),productionCues:cues},generation:{duration:shot.duration,ratio:shot.ratio,resolution:shot.resolution}};
 return {bindingSnapshot,sourceSnapshot,bindingFingerprint:executionHash(bindingSnapshot),sourceFingerprint:executionHash(sourceSnapshot)};
}

export async function previewExecution(work,shot,recipeValue,context){
 const sourceRecipe=normalizeExecutionRecipe(recipeValue,shot),source=await executionSource(work,shot,context);
 const prompt=(shot.firstFrameMediaId?H3_I2VA_HEADER+'\n\n':'')+FIELDS.map(key=>`${key}: ${sourceRecipe[key]}`).join('\n\n');
 if(prompt.length>24000)fail('H3 最终执行稿超过 24000 字');
 return {schemaVersion:1,mode:shot.firstFrameMediaId?'I2VA':'T2VA',prompt,hash:executionHash(prompt),sourceRecipe,recipeHash:executionHash(sourceRecipe),...source,warnings:['这是确定性格式校验与组装；英文创作由 Codex 提供，不保证画质或口型。','当前 H3 CFG=1，negative 不提供普通 CFG 负向引导；将约束写成可观察的正向状态。']};
}

export async function executionState(work,shot,context){
 const executionPrompt=shot.executionPrompt||null;
 if(!executionPrompt)return {shotId:shot.id,executionPrompt:null,status:{mode:'legacy',state:'missing',reasons:[]}};
 const reasons=[],compilation=executionPrompt.compilation,lock=executionPrompt.lock;
 if(compilation){
  try{const source=await executionSource(work,shot,context);if(source.bindingFingerprint!==compilation.bindingFingerprint)reasons.push('角色、场景、声音或参考素材已改变');if(source.sourceFingerprint!==compilation.sourceFingerprint)reasons.push('制作记录或生成参数已改变');}catch(error){reasons.push(error.message);}
  if(executionHash(executionPrompt.draft?.recipe)!==compilation.recipeHash)reasons.push('执行稿草案已改变');
  if(executionHash(compilation.prompt)!==compilation.hash)reasons.push('已编译执行稿校验失败');
 }
 const locked=Boolean(compilation&&lock?.compilationId===compilation.id&&lock?.hash===compilation.hash);
 return {shotId:shot.id,executionPrompt:clone(executionPrompt),status:{mode:'compiled',state:reasons.length?'stale':locked?'locked':compilation?'compiled':'draft',reasons}};
}

export async function changeExecution(work,shot,operation,body,context){
 if(!object(body))fail('执行稿请求须为 JSON 对象');
 const existing=shot.executionPrompt,revision=existing?.revision||0;
 if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==revision)fail('执行稿版本已变化，请重新读取后再保存',409);
 const next=existing?clone(existing):{schemaVersion:1,revision:0,draft:null,compilation:null,lock:null,history:[]};
 if(operation==='draft'){
  const recipe=normalizeExecutionRecipe(body.recipe,shot);next.draft={recipe,updatedAt:now()};
 }else if(operation==='compile'){
  if(next.history.length>=100)fail('当前分镜执行稿已达 100 个不可变版本；保留旧记录，不再追加',409);
  const recipe=body.recipe??next.draft?.recipe,preview=await previewExecution(work,shot,recipe,context);
  const compilation={id:randomUUID(),version:next.history.length+1,createdAt:now(),...preview};next.draft={recipe:clone(preview.sourceRecipe),updatedAt:now()};next.compilation=compilation;next.history.push(clone(compilation));next.lock=null;
 }else if(operation==='lock'){
  if(!next.compilation||body.expectedHash!==next.compilation.hash)fail('待锁定执行稿 hash 不匹配，请先编译并检查最终原文',409);
  const state=await executionState(work,shot,context);if(state.status.state==='stale')fail('执行稿来源已变化：'+state.status.reasons.join('；')+'。请重新编译、检查和锁版',409);
  next.lock={compilationId:next.compilation.id,hash:next.compilation.hash,lockedAt:now()};
 }else fail('执行稿操作不存在',404);
 next.revision=revision+1;shot.executionPrompt=next;return await executionState(work,shot,context);
}

export async function compiledExecutionForJob(work,shot,context){
 const state=await executionState(work,shot,context);if(state.status.state!=='locked')fail('最终 H3 执行稿尚未锁版或已过期：'+(state.status.reasons.join('；')||state.status.state)+'。请检查、编译并锁版后生成',409);
 const compilation=shot.executionPrompt.compilation;
 return {...clone(compilation),executionMode:'compiled',compilationId:compilation.id,lockedAt:shot.executionPrompt.lock.lockedAt,lockedRevision:shot.executionPrompt.revision};
}
