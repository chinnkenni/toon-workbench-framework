import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {resolveCharacterVoiceProfile} from './tts.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value),clone=value=>structuredClone(value);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(value,label,max=2000)=>{if(typeof value!=='string'||value.length>max)fail(`${label}最多 ${max} 字`);return value.trim();};
const id=value=>{if(!UUID.test(value||''))fail('对白或声音编号无效');return value;};
const blank=()=>({visualPlan:{camera:'',visibleState:'',props:'',performance:'',timing:''},dialogue:[],ambience:[],sfx:[],music:[]});
function timing(value){const start=value.planStart??null,end=value.planEnd??null;for(const item of [start,end])if(item!==null&&(typeof item!=='number'||!Number.isFinite(item)||item<0||item>600))fail('计划时间须在 0–600 秒之间或留空');if(start!==null&&end!==null&&end<=start)fail('计划结束时间应晚于开始时间');return {planStart:start,planEnd:end};}
function array(value,label){if(value===undefined)return [];if(!Array.isArray(value)||value.length>64)fail(label+'最多 64 条');return value;}
function current(shot){const value=shot.productionCues;if(value===undefined)return null;if(!plain(value)||value.schemaVersion!==1||!Number.isSafeInteger(value.revision)||!Array.isArray(value.versions)||!plain(value.cues))fail('分镜制作脚本记录损坏，未覆盖原记录',409);return value;}
export function getProductionCues(work,shot){const saved=current(shot);return {shotId:shot.id,productionCues:saved?clone(saved):{schemaVersion:1,revision:0,cues:blank(),versions:[]},characters:clone(work.studio?.libraries?.characters||[]),audioMedia:clone((work.studio?.media||[]).filter(item=>item.type==='audio')),limitations:{modelCalls:false,autoTimelinePlacement:false,h3MixedAudio:'H3 原音轨为混合音轨；不能独立关对白而保留环境声。',designedVoicePerformance:'Qwen3-TTS Base 复用设计声线时不支持逐句表演指令，表演仅作制作备注。'}};}

export async function saveProductionCues(work,shot,body,{dataDir,resolveMedia,resolveVoiceProfile=resolveCharacterVoiceProfile}={}){
 if(!plain(body)||!Number.isSafeInteger(body.expectedRevision)||!plain(body.cues))fail('请提供 expectedRevision 与完整 cues');const old=current(shot),revision=old?.revision??0;
 if(body.expectedRevision!==revision)fail('逐镜制作脚本已有新修订，请刷新后再保存',409);if((old?.versions.length??0)>=100)fail('当前分镜制作脚本已达 100 个版本，请保留现有记录',409);
 const raw=body.cues,visual=raw.visualPlan??{};if(!plain(visual))fail('可见画面计划格式无效');const cues=blank();for(const key of Object.keys(cues.visualPlan))cues.visualPlan[key]=text(visual[key]??'','画面计划',4000);
 let tts=[];if(dataDir)try{const catalog=JSON.parse(await readFile(join(dataDir,'tts','catalog.json'),'utf8'));if(!Array.isArray(catalog.jobs))fail('配音来源索引格式无效',409);tts=catalog.jobs;}catch(error){if(error.code!=='ENOENT')throw error;}
 const cache=new Map(),mediaList=work.studio?.media||[],characters=work.studio?.libraries?.characters||[];
 async function mediaSnapshot(mediaId){
  if(cache.has(mediaId))return clone(cache.get(mediaId));const media=mediaList.find(item=>item.id===id(mediaId)&&item.type==='audio');if(!media)fail('声音只可选择同作品登记的音频');if(typeof resolveMedia!=='function')fail('声音文件校验器未就绪',503);
  if(typeof media.duration!=='number'||!Number.isFinite(media.duration)||media.duration<=0)fail('声音缺少实测时长，请先完成素材导入');const file=await resolveMedia(media),before=await stat(file);if(!before.isFile()||before.size<1||before.size>64*1024*1024)fail('声音源文件无效');let bytes=0;const hash=createHash('sha256');for await(const part of createReadStream(file)){bytes+=part.length;hash.update(part);}const after=await stat(file),sha256=hash.digest('hex');if(before.size!==bytes||after.size!==bytes||before.mtimeMs!==after.mtimeMs||media.sha256&&media.sha256!==sha256)fail('声音文件在登记后或核对时发生变化',409);
  const job=tts.find(item=>item.status==='succeeded'&&item.request?.workId===work.id&&(typeof item.media==='string'?item.media:item.media?.id)===media.id);if(job?.output?.sha256&&job.output.sha256!==sha256)fail('声音文件与当次配音产物 SHA 不一致',409);
  const source=job?{type:'tts-job',jobId:job.id,kind:job.kind,model:clone(job.model??null),text:job.request?.text??null,performanceInstruction:job.request?.performanceInstruction??job.request?.instruct??'',instructionApplied:typeof job.instructionApplied==='boolean'?job.instructionApplied:job.kind==='designed-speech'?false:null}: {type:'imported-audio',jobId:null,model:null,instructionApplied:null};
  const result={mediaId:media.id,name:media.name,mimeType:media.mimeType,sha256,bytes,durationSeconds:media.duration,measurement:'registered-media-probe',source};cache.set(mediaId,result);return clone(result);
 }
 const labels=new Map(),speakers=new Map(),allIds=new Set();
 function cueId(value){const key=value===undefined?randomUUID():id(value);if(allIds.has(key))fail('制作脚本条目编号重复');allIds.add(key);return key;}
 for(const value of array(raw.dialogue,'对白')){
  if(!plain(value))fail('对白格式无效');const speakerId=id(value.speakerId),character=characters.find(item=>item.id===speakerId);if(!character)fail('说话人须为当前作品角色');if(typeof value.speakerLabel!=='string'||!/^S[1-9][0-9]?$/.test(value.speakerLabel))fail('说话人标签使用 S1、S2 等稳定编号');const label=value.speakerLabel;
  if(labels.has(label)&&labels.get(label)!==speakerId||speakers.has(speakerId)&&speakers.get(speakerId)!==label)fail('同一说话人编号必须稳定对应同一个角色');if(!speakers.has(speakerId)&&label!=='S'+(speakers.size+1))fail('说话人按首次发声顺序从 S1 连续编号');labels.set(label,speakerId);speakers.set(speakerId,label);
  const cue={id:cueId(value.id),speakerId,speakerLabel:label,text:text(value.text??'','原台词',2000),delivery:text(value.delivery??'','表演说明',2000),...timing(value),anchor:{kind:'shot-start',description:''},performanceSource:text(value.performanceSource??'','表演说明来源',1000),lockVoice:value.lockVoice===true,voiceSnapshot:null,takeMediaIds:[],takes:[],selectedTakeMediaId:null};
  if(!cue.text)fail('原台词不能为空');const anchor=value.anchor??{};if(!plain(anchor)||anchor.kind!==undefined&&!['shot-start','event'].includes(anchor.kind))fail('对齐锚点须为镜头起点或可见事件');cue.anchor={kind:anchor.kind??'shot-start',description:text(anchor.description??'','对齐锚点',1000)};if(cue.anchor.kind==='event'&&!cue.anchor.description)fail('事件锚点需要描述可见触发');
  if(value.lockVoice!==undefined&&typeof value.lockVoice!=='boolean'||value.relockVoice!==undefined&&typeof value.relockVoice!=='boolean')fail('声线锁定选项须为布尔值');
  if(cue.lockVoice){const prior=old?.cues.dialogue?.find(item=>item.id===cue.id&&item.speakerId===speakerId);if(prior?.lockVoice&&prior.voiceSnapshot&&value.relockVoice!==true)cue.voiceSnapshot=clone(prior.voiceSnapshot);else{if(!character.voiceProfile)fail('请先为该角色保存并试听声线，再锁定对白声线');const profile=await resolveVoiceProfile(dataDir,work.id,clone(character.voiceProfile));cue.voiceSnapshot={versionId:digest(profile),lockedAt:new Date().toISOString(),characterId:speakerId,profile:clone(profile),instructionControl:profile.mode!=='designed',performanceControl:profile.mode==='designed'?'notes-only':'provider-instruction-capability',note:'这是声线来源锁定；逐句表演是否送入模型仍以当次 TTS 任务记录为准。'};}}
  if(!Array.isArray(value.takeMediaIds??[])||(value.takeMediaIds??[]).length>12)fail('每句最多保留 12 个声音候选');cue.takeMediaIds=[...new Set((value.takeMediaIds??[]).map(id))];for(const key of cue.takeMediaIds)cue.takes.push(await mediaSnapshot(key));if(value.selectedTakeMediaId){cue.selectedTakeMediaId=id(value.selectedTakeMediaId);if(!cue.takeMediaIds.includes(cue.selectedTakeMediaId))fail('选用配音必须来自本句已有候选');}cues.dialogue.push(cue);
 }
 for(const layer of ['ambience','sfx','music'])for(const value of array(raw[layer],'声音分层')){if(!plain(value))fail('声音分层格式无效');const cue={id:cueId(value.id),name:text(value.name??'','声音名称',120),note:text(value.note??'','声音说明',2000),...timing(value),mediaId:value.mediaId?id(value.mediaId):null,mediaSnapshot:null};if(!cue.name&&!cue.note&&!cue.mediaId)fail('声音条目需要名称、说明或音频素材');if(cue.mediaId)cue.mediaSnapshot=await mediaSnapshot(cue.mediaId);cues[layer].push(cue);}
 if(old&&JSON.stringify(old.cues)===JSON.stringify(cues))return {productionCues:clone(old),unchanged:true};
 const timestamp=new Date().toISOString(),version={id:randomUUID(),version:revision+1,createdAt:timestamp,sha256:digest(cues),cues:clone(cues)};
 shot.productionCues={schemaVersion:1,revision:revision+1,updatedAt:timestamp,cues,versions:[...(old?.versions??[]),version]};return {productionCues:clone(shot.productionCues),unchanged:false};
}
