import {readFile, writeFile, mkdir, rename, stat, realpath, rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {performance} from 'node:perf_hooks';
import {resolveCreativeSkills} from './creative-skills.mjs';
import {resolveCharacterVoiceProfile} from './tts.mjs';
import {normalizeExportOptions} from './timeline-renderer.mjs';
import {hydrateOpEd,getOpEdState,createOpEdEntry,appendOpEdVersion,applyOpEdVersion,detachOpEdVersion,preserveOpEdReferences} from './op-ed.mjs';
import {executionState,previewExecution,changeExecution} from './h3-execution.mjs';
import {getProductionCues,saveProductionCues} from './production-cues.mjs';
import {hasAudioAutomation,normalizeAudioAutomation} from './audio-envelope.mjs';
import {resolveExportTimeline} from './export-timeline.mjs';
import {freezeStoryboardSelection} from './storyboard-snapshot.mjs';
import {normalizeClipReframe,assertReframeExport} from './clip-reframe.mjs';
import {freezeReframeSelection} from './reframe-snapshot.mjs';
import {scheduleArchiveOnExport} from './work-archive.mjs';

const archiveCallbacks=new Map();
export const getPendingArchiveCallbacks=dataDir=>archiveCallbacks.get(resolve(dataDir))||0;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES=['characters','scenes','voices','music','sfx'];
const MAX_UPLOAD=64*1024*1024;
const formats={
 'image/png':['png','image','png_pipe'],'image/jpeg':['jpg','image','mjpeg'],'image/webp':['webp','image','webp_pipe'],
 'audio/wav':['wav','audio','wav'],'audio/x-wav':['wav','audio','wav'],'audio/mpeg':['mp3','audio','mp3'],'audio/mp4':['m4a','audio','mov'],
 'audio/flac':['flac','audio','flac'],'audio/ogg':['ogg','audio','ogg'],'audio/aac':['aac','audio','aac'],'video/mp4':['mp4','video','mov'],
};
const now=()=>new Date().toISOString();
const clone=value=>structuredClone(value);
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function ident(value){if(!UUID.test(value||''))fail('作品素材或分镜编号无效');return value;}
function text(value,label,max=10000,required=false){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))fail(`${label}${required?'不能为空，且':''}最多 ${max} 字`);return value.trim();}
function number(value,label,min,max){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail(`${label}必须在 ${min}–${max} 之间`);return value;}
function inside(directory,...parts){const path=resolve(directory,...parts),rel=relative(resolve(directory),path);if(!rel||rel.startsWith('..')||isAbsolute(rel))fail('作品素材路径越界');return path;}
function ids(value,label){if(!Array.isArray(value)||value.length>50)fail(label+'最多选择 50 项');return [...new Set(value.map(ident))];}
function episode(work,episodeId){ident(episodeId);const found=work.episodes.find(item=>item.id===episodeId);if(!found)fail('分集不属于当前作品');return found;}
function shot(work,shotId){ident(shotId);const found=work.shots.find(item=>item.id===shotId);if(!found)fail('分镜不存在',404);return found;}
function idleShot(work,item){if(work.jobs.some(job=>job.shotId===item.id&&['queued','running'].includes(job.status)))fail('分镜生成中，请完成后再修改',409);}
const titleClip=(role,title,subtitle='')=>({id:randomUUID(),type:'title',role,title,subtitle,duration:2,trimStart:0,muted:false,enabled:true});
function ensureShotTimelineSlot(work,item){
 const timeline=work.studio.timelines[item.episodeId],existing=timeline.clips.find(clip=>clip.type==='shot'&&clip.shotId===item.id);
 if(existing)return existing;
 const clip={id:randomUUID(),type:'shot',role:null,shotId:item.id,title:item.title,subtitle:'',duration:item.duration,trimStart:0,muted:false,enabled:true};
 timeline.clips.splice(Math.max(1,timeline.clips.length-1),0,clip);
 // Validate inside the caller's serial transaction without replacing the timeline:
 // legacy/manual confirmations and new splits share the same editable limits,
 // while existing clip IDs, cuts and OP/ED reference metadata remain untouched.
 validateTimeline(work,item.episodeId,timeline);return clip;
}
export function hydrateStudio(work){
 if(!object(work.studio))work.studio={};const studio=work.studio;
 if(!object(studio.scripts))studio.scripts={};if(!object(studio.libraries))studio.libraries={};
 for(const category of CATEGORIES)if(!Array.isArray(studio.libraries[category]))studio.libraries[category]=[];
 if(!Array.isArray(studio.media))studio.media=[];if(!object(studio.timelines))studio.timelines={};if(!Array.isArray(studio.exports))studio.exports=[];
 for(const item of work.episodes||[])if(!studio.timelines[item.id])studio.timelines[item.id]={width:1280,height:720,fps:24,clips:[titleClip('intro',work.title,item.title),titleClip('outro','未完待续',work.title)],audio:[]};
 hydrateOpEd(work);
 for(const item of work.shots||[]){item.characterIds??=[];item.sceneId??=null;item.voiceIds??=[];item.firstFrameMediaId??=null;item.skillIds??=[];item.skillSnapshot??=[];item.approvalStatus??='draft';}
 return studio;
}
function mediaById(work,mediaId,type){ident(mediaId);const media=hydrateStudio(work).media.find(item=>item.id===mediaId);if(!media||type&&media.type!==type)fail('所选素材不属于这个作品或类型不匹配');return media;}
export async function studioMediaPath(directory,media){
 ident(media?.id);const extension=formats[media.mimeType]?.[0];
 if(!extension||media.relativePath!==`assets/imported/${media.id}.${extension}`)fail('作品素材登记路径无效');
 const root=await realpath(directory),file=await realpath(inside(root,media.relativePath));inside(root,relative(root,file));return file;
}
function sniff(bytes,mime){
 if(mime==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(mime==='image/jpeg')return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(mime==='image/webp')return bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
 if(mime.includes('wav'))return bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE';
 if(mime==='audio/flac')return bytes.subarray(0,4).toString()==='fLaC';
 if(mime==='audio/ogg')return bytes.subarray(0,4).toString()==='OggS';
 if(mime.endsWith('/mp4'))return bytes.subarray(4,8).toString()==='ftyp';
 return mime==='audio/mpeg'?(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&224)===224):mime==='audio/aac'&&bytes[0]===255&&(bytes[1]&246)===240;
}
export async function probeUpload(file,dataDir,mimeType){
 const executable=process.platform==='win32'?join(dataDir,'toonflow','ffmpeg','win32-x64','ffprobe.exe'):'ffprobe';
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(executable,['-v','error','-protocol_whitelist','file,pipe','-f',formats[mimeType][2],'-i',file,'-show_streams','-show_format','-of','json'],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',done=false;const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(stdout);};
  const timer=setTimeout(()=>{child.kill();finish(Object.assign(new Error('校验本机素材超时'),{status:504}));},20000);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>256*1024){child.kill();finish(new Error('素材探测结果超过限制'));}});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1000);});
  child.on('error',error=>finish(error.code==='ENOENT'?Object.assign(new Error('本机 FFprobe 尚未安装，无法校验上传素材'),{status:503}):error));
  child.on('close',code=>finish(code===0?null:Object.assign(new Error('上传内容不是可读取的图片、音频或视频'+(stderr?'：'+stderr:'')),{status:400})));
 });
 let probe;try{probe=JSON.parse(result);}catch{fail('素材探测结果无效');}
 return normalizeProbe(probe,formats[mimeType][1]);
}
export function normalizeProbe(probe,type){
 const streams=Array.isArray(probe?.streams)?probe.streams:[],video=streams.find(item=>item.codec_type==='video'),audio=streams.find(item=>item.codec_type==='audio');
 if(type==='audio'&&(!audio||video)||type!=='audio'&&!video)fail('上传文件与声明的素材类型不匹配');
 const duration=[video?.duration,audio?.duration,probe.format?.duration].map(Number).find(value=>Number.isFinite(value)&&value>0),width=Number(video?.width),height=Number(video?.height);
 if(video&&(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>16384||height>16384||width*height>80_000_000))fail('上传画面尺寸无效或过大');
 if(type!=='image'&&(!Number.isFinite(duration)||duration<=0||duration>7200))fail('音视频时长必须在 0–7200 秒之间');
 return {width:video?width:null,height:video?height:null,duration:type==='image'?null:duration,hasAudio:Boolean(audio)};
}
async function upload(req,url,store,workId,deps){
 const mimeType=(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();if(!formats[mimeType])fail('仅支持 PNG/JPEG/WebP 图片、常见音频和 MP4 视频，不支持 SVG',415);
 const name=text(url.searchParams.get('name')||'导入素材','素材名称',180,true);if(Number(req.headers['content-length'])>MAX_UPLOAD)fail('素材不能超过 64 MB',413);
 let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_UPLOAD)fail('素材不能超过 64 MB',413);chunks.push(chunk);}if(!size)fail('上传素材不能为空');
 const bytes=Buffer.concat(chunks);if(!sniff(bytes,mimeType))fail('文件内容与素材类型不匹配');
 const directory=deps.workspace(store,workId);await mkdir(directory,{recursive:true});const root=await realpath(directory),folder=inside(root,'assets','imported');await mkdir(folder,{recursive:true});const canonicalFolder=await realpath(folder);inside(root,relative(root,canonicalFolder));
 const mediaId=randomUUID(),relativePath=`assets/imported/${mediaId}.${formats[mimeType][0]}`,target=join(canonicalFolder,mediaId+'.'+formats[mimeType][0]),temporary=target+'.'+randomUUID()+'.tmp';
 try{
  await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});
  const details=await(store.context.probeUpload||probeUpload)(temporary,store.context.dataDir,mimeType);
  // Test transports return the same normalized shape; production always uses FFprobe.
  if(!object(details)||formats[mimeType][1]!=='image'&&!(details.duration>0)||formats[mimeType][1]!=='audio'&&!(details.width>0&&details.height>0))fail('素材校验未返回实际尺寸或时长');
  await rename(temporary,target);
  const media={id:mediaId,name,type:formats[mimeType][1],mimeType,relativePath,bytes:size,...details,url:`/api/works/${workId}/studio/media/${mediaId}`,createdAt:now()};
  const work=await deps.serial(store,async()=>{const work=deps.workById(store,workId);hydrateStudio(work).media.push(media);work.updatedAt=now();await deps.persist(store);return deps.presentWork(work);});
  return {media,work,studio:work.studio};
 }catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error;}
}

export function splitScript(source){
 const input=text(source,'剧本',100000,true).replace(/\r\n?/g,'\n');
 const pieces=input.split(/\n\s*\n|\n(?=(?:第[一二三四五六七八九十百\d]+[场幕]|场景[：:]|场次[：:]|内景|外景|INT\.|EXT\.|SCENE\s+))/i).map(item=>item.trim()).filter(Boolean);
 if(pieces.length>120)fail('单次最多拆分 120 个段落，请按分集保存');return {text:input,hash:createHash('sha256').update(input).digest('hex'),pieces};
}
function bindingEntries(work,item){const libraries=hydrateStudio(work).libraries;return {characters:item.characterIds.map(key=>libraries.characters.find(entry=>entry.id===key)).filter(Boolean),scene:libraries.scenes.find(entry=>entry.id===item.sceneId)||null,voices:item.voiceIds.map(key=>libraries.voices.find(entry=>entry.id===key)).filter(Boolean)};}
async function validateBindings(store,workId,work,body,deps){
 const studio=hydrateStudio(work),changes={};
 if('skillIds'in body){changes.skillSnapshot=await resolveCreativeSkills(store.context.dataDir,body.skillIds);changes.skillIds=changes.skillSnapshot.map(item=>item.id);}
 for(const [field,category]of[['characterIds','characters'],['voiceIds','voices']])if(field in body){changes[field]=ids(body[field],field);if(changes[field].some(key=>!studio.libraries[category].some(entry=>entry.id===key)))fail('所选设定不属于当前作品');}
 if('sceneId'in body){changes.sceneId=body.sceneId?ident(body.sceneId):null;if(changes.sceneId&&!studio.libraries.scenes.some(entry=>entry.id===changes.sceneId))fail('场景设定不属于当前作品');}
 if('firstFrameMediaId'in body){changes.firstFrameMediaId=body.firstFrameMediaId?ident(body.firstFrameMediaId):null;if(changes.firstFrameMediaId){const media=mediaById(work,changes.firstFrameMediaId,'image');if(media.bytes>25*1024*1024)fail('GB10 首帧参考不能超过 25 MB');await studioMediaPath(deps.workspace(store,workId),media);}}
 return changes;
}
function promptFields(work,item,body){
 const visual=text(body.visual??item.visualInstructions??item.prompt,'画面描述',15000,true),sound=text(body.sound??item.soundInstructions??'','同期声音',5000),music=text(body.music??item.musicInstructions??'','配乐',5000);
 const prompt=buildH3Prompt(work,item,{visual,sound,music});if(prompt.length>24000)fail('设定与提示词合计超过 24000 字，请精简后再组装');
 return {prompt,visualInstructions:visual,soundInstructions:sound,musicInstructions:music,promptSnapshot:{method:'h3-structured-template',createdAt:now(),...clone(bindingEntries(work,item)),firstFrameMediaId:item.firstFrameMediaId,skills:clone(item.skillSnapshot||[])}};
}
export function buildH3Prompt(work,item,{visual,sound,music}){
 const entries=bindingEntries(work,item),locks=[...entries.characters,entries.scene].filter(entry=>entry&&entry.locked!==false);
 const descriptions=locks.map(entry=>`${entry.name}：${[entry.description,entry.lockedTraits&&'固定特征：'+entry.lockedTraits,entry.negativeConstraints&&'避免：'+entry.negativeConstraints].filter(Boolean).join('；')}`).join('\n');
 const voices=entries.voices.filter(entry=>entry.locked!==false).map(entry=>`${entry.name}：${entry.voiceStyle||entry.lockedTraits||entry.description}`).join('；');
 const reference=item.firstFrameMediaId?'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n':'';
 const skills=(item.skillSnapshot||[]).filter(skill=>!skill.referenceOnly).map(skill=>`${skill.name}（v${skill.version}）：${skill.instructions}`).join('\n');
 return reference+`integrated_multimodal_description: [Shot 1] ${visual}${work.style?'\n视觉风格：'+work.style:''}${descriptions?'\n本镜锁定设定：\n'+descriptions:''}${skills?'\n创作指导（不作为对白）：\n'+skills:''}\n\noverall_soundscape: ${sound||'自然环境声，不添加额外对白。'}${voices?'\n音色设定：'+voices:''}\n\nnon_diegetic_music: ${music||'N/A'}`;
}

function validateClip(work,episodeId,value,index,total,fps){
 if(!object(value))fail('时间轴镜头格式无效');ident(value.id);if(!['title','shot','media'].includes(value.type))fail('时间轴镜头类型无效');
 const role=value.role??null;if(role!==null&&!['intro','outro'].includes(role))fail('片头片尾角色无效');
 if(index===0&&role!=='intro'||index===total-1&&role!=='outro'||index>0&&index<total-1&&role!==null)fail('时间轴必须保留首位片头和末位片尾');
 if(role&&value.type==='shot')fail('片头片尾须使用标题卡或导入素材');
 const clip={id:value.id,type:value.type,role,title:text(value.title??'','镜头标题',180),subtitle:text(value.subtitle??'','镜头副标题',500),duration:Math.max(1,Math.round(number(value.duration,'镜头时长',1/fps,600)*fps))/fps,trimStart:number(value.trimStart??0,'入点',0,600),muted:value.muted===true,enabled:value.enabled!==false};
 if(value.type==='shot'){const item=shot(work,value.shotId);if(item.episodeId!==episodeId)fail('时间轴分镜不属于该分集');clip.shotId=item.id;if(value.assetId){ident(value.assetId);const asset=work.assets.find(a=>a.id===value.assetId&&a.shotId===item.id);if(!asset||!item.assetIds.includes(asset.id))fail('指定成片不属于当前分镜');clip.assetId=asset.id;}}
 if(value.type==='media'){const media=mediaById(work,value.mediaId);if(!['image','video'].includes(media.type))fail('镜头只支持图片或视频素材');clip.mediaId=media.id;if(media.type==='video'&&clip.trimStart>=media.duration)fail('镜头入点已超过视频结尾');}
 const reframe=normalizeClipReframe(value.reframe,{work,clip});if(reframe)clip.reframe=reframe;
 return clip;
}
export function validateTimeline(work,episodeId,value,{allowEmpty=false}={}){
 episode(work,episodeId);if(!object(value)||!Array.isArray(value.clips)||value.clips.length<2||value.clips.length>200||!Array.isArray(value.audio)||value.audio.length>64)fail('时间轴需包含片头片尾，最多 200 个画面片段和 64 条声音');
 const width=number(value.width,'导出宽度',64,1920),height=number(value.height,'导出高度',64,1920);if(!Number.isInteger(width)||!Number.isInteger(height)||width%2||height%2)fail('导出尺寸必须为偶数整数');
 if(![24,30].includes(value.fps))fail('导出帧率支持 24 或 30');
 const clips=value.clips.map((clip,index)=>validateClip(work,episodeId,clip,index,value.clips.length,value.fps)),duration=clips.filter(clip=>clip.enabled).reduce((sum,clip)=>sum+clip.duration,0);
 if((!allowEmpty&&duration<=0)||duration>600)fail('导出总时长须在 0–600 秒之间');
 const audio=value.audio.map(item=>{if(!object(item)||!['voice','music','sfx'].includes(item.kind))fail('声音轨类型无效');ident(item.id);const media=mediaById(work,item.mediaId,'audio');const entry={id:item.id,kind:item.kind,mediaId:media.id,start:number(item.start,'声音开始时间',0,600),trimStart:number(item.trimStart??0,'声音入点',0,600),duration:number(item.duration,'声音时长',1/48000,600),gain:number(item.gain??1,'音量',0,2),loop:item.loop===true,enabled:item.enabled!==false};if(entry.trimStart>=media.duration||!entry.loop&&entry.trimStart+entry.duration>media.duration+0.1)fail('声音裁剪超出素材长度');if(entry.start>=duration||entry.start+entry.duration>duration+0.1)fail('声音超出整片长度，请调整开始时间或时长');if(hasAudioAutomation(item))Object.assign(entry,normalizeAudioAutomation(item,entry.duration));return entry;});
 if(new Set([...clips,...audio].map(item=>item.id)).size!==clips.length+audio.length)fail('时间轴条目编号重复');
 return {width,height,fps:value.fps,clips,audio,updatedAt:now()};
}

async function serveFile(req,res,file,mimeType){
 const info=await stat(file);if(!info.isFile()||info.size<1)fail('作品素材不存在',404);const size=info.size;
 let start=0,end=size-1,status=200;
 if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!match||!match[1]&&!match[2]){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}if(!match[1])start=Math.max(0,size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(size-1,Number(match[2]));}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start||!match[1]&&Number(match[2])===0){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}status=206;}
 const headers={'Content-Type':mimeType,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'};if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${size}`;res.writeHead(status,headers);if(req.method==='HEAD'){res.end();return;}await pipeline(createReadStream(file,{start,end}),res).catch(error=>{if(!res.destroyed)res.destroy(error);});
}
async function exportVideo(req,res,store,workId,exportId,deps){
 ident(exportId);const work=deps.workById(store,workId),job=hydrateStudio(work).exports.find(item=>item.id===exportId);if(!job||job.status!=='succeeded')fail('该导出尚未完成或不存在',404);
 if(job.relativePath!==`exports/export${exportId}.mp4`)fail('导出文件登记无效');const root=await realpath(deps.workspace(store,workId)),file=await realpath(inside(root,job.relativePath));inside(root,relative(root,file));await serveFile(req,res,file,'video/mp4');
}
function startExport(store,workId,exportId,snapshot,deps){
 const archiveKey=resolve(store.context.dataDir);archiveCallbacks.set(archiveKey,getPendingArchiveCallbacks(archiveKey)+1);
 setImmediate(async()=>{
  const update=fields=>deps.serial(store,async()=>{const work=deps.workById(store,workId),job=hydrateStudio(work).exports.find(item=>item.id===exportId);Object.assign(job,fields);work.updatedAt=now();await deps.persist(store);});
  const started=performance.now();try{
   await update({status:'running',startedAt:now(),progress:1,message:'正在本机合成时间轴'});
   const renderer=store.context.renderTimeline||(await import('./timeline-renderer.mjs')).renderTimeline;
   const job=snapshot.studio.exports.find(item=>item.id===exportId);let progressAt=0,lastPhase=null;
   const result=await renderer({work:snapshot,episodeId:job.episodeId,timelineSnapshot:clone(job.timelineSnapshot),selectionSnapshot:clone(job.selectionSnapshot),workspaceDirectory:deps.workspace(store,workId),dataDir:store.context.dataDir,exportId,exportOptions:job.exportOptions,upscaleSource:store.context.upscaleSource,onProgress:value=>{if(value?.phase===lastPhase&&Date.now()-progressAt<1000)return;progressAt=Date.now();lastPhase=value?.phase;const fields={message:typeof value?.message==='string'?value.message.slice(0,300):'正在本机合成时间轴'};if(typeof value?.phase==='string')fields.phase=value.phase;if(value?.phase==='segments'&&Number.isInteger(value?.completed))fields.completedClips=value.completed;if(value?.phase==='segments'&&Number.isInteger(value?.total))fields.totalClips=value.total;for(const key of ['completedFrames','totalFrames'])if(Number.isInteger(value?.[key])&&value[key]>=0)fields[key]=value[key];if(typeof value?.phaseStartedAt==='string')fields.phaseStartedAt=value.phaseStartedAt;if(typeof value?.aiElapsedMs==='number'&&Number.isFinite(value.aiElapsedMs)&&value.aiElapsedMs>=0)fields.aiElapsedMs=value.aiElapsedMs;update(fields).catch(()=>{});}});
   if(result.relativePath!==`exports/export${exportId}.mp4`)throw new Error('合成器返回了越界或无效路径');
   await update({...result,status:'succeeded',progress:100,finishedAt:now(),productionMs:performance.now()-started,url:`/api/works/${workId}/studio/exports/${exportId}/video`,message:job.exportOptions?.mode==='storyboard'?'故事板静态预演已导出；计划对白不是实际配音或口型':job.exportOptions?.enhance==='ai-1080p'?'1080P 发布版已导出，原镜头、审片和素材完整保留':'本机成片已导出，原镜头和素材完整保留'});
   try{await scheduleArchiveOnExport({...store.context,nasRoot:store.context.archiveRoot},workId,exportId);}catch{console.error('成片已保存，NAS自动备份未能登记；请在制作档案中核对并手动备份。');}
  }catch(error){await update({status:'failed',finishedAt:now(),productionMs:performance.now()-started,progress:0,message:error.message.slice(0,2000),error:error.message.slice(0,2000)}).catch(failure=>console.error('本机成片导出日志保存失败：',failure.message));}finally{const remaining=getPendingArchiveCallbacks(archiveKey)-1;if(remaining>0)archiveCallbacks.set(archiveKey,remaining);else archiveCallbacks.delete(archiveKey);}
 });
}

/** Runs only after the host server has checked mutation Origin/Host. */
export async function handleStudio(req,res,url,store,workId,deps){
 const action=url.pathname.split('/studio')[1]?.replace(/^\//,'')||'';await store.writes;
 const initial=deps.workById(store,workId);hydrateStudio(initial);
 const executionMatch=/^shots\/([^/]+)\/execution-prompt(?:\/(draft|preview|compile|lock))?$/.exec(action);
 const executionContext={resolveMedia:media=>studioMediaPath(deps.workspace(store,workId),media)};
 const cuesMatch=/^shots\/([^/]+)\/production-cues$/.exec(action);
 if(cuesMatch&&['GET','HEAD'].includes(req.method)){const work=clone(deps.workById(store,workId)),value=getProductionCues(work,shot(work,cuesMatch[1]));if(req.method==='HEAD'){const bytes=Buffer.from(JSON.stringify(value));res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end();}else deps.json(res,200,value);return true;}
 if(executionMatch&&['GET','HEAD'].includes(req.method)&&!executionMatch[2]){await store.writes;const work=clone(deps.workById(store,workId)),value=await executionState(work,shot(work,executionMatch[1]),executionContext);if(req.method==='HEAD'){const bytes=Buffer.from(JSON.stringify(value));res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end();}else deps.json(res,200,value);return true;}
 if(req.method==='GET'&&!action){deps.json(res,200,{studio:clone(initial.studio),work:deps.presentWork(initial)});return true;}
 if(['GET','HEAD'].includes(req.method)&&action==='op-ed'){const value=getOpEdState(initial);if(req.method==='HEAD'){const bytes=Buffer.from(JSON.stringify(value));res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end();}else deps.json(res,200,value);return true;}
 if(req.method==='GET'&&action==='export-capability'){const capability=await(store.context.getUpscaleCapability||(await import('./ai-upscale.mjs')).getUpscaleCapability)({dataDir:store.context.dataDir});deps.json(res,200,{...capability,clipReframe:{available:true,coordinateSpace:'original-source-pixels',modes:['video'],enhance:['none']}});return true;}
 const mediaMatch=/^media\/([^/]+)$/.exec(action),exportMatch=/^exports\/([^/]+)\/video$/.exec(action);
 if(['GET','HEAD'].includes(req.method)&&mediaMatch){const media=mediaById(initial,mediaMatch[1]);let file;try{file=await studioMediaPath(deps.workspace(store,workId),media);}catch(error){if(error.code==='ENOENT')fail('本机素材文件不存在',404);throw error;}await serveFile(req,res,file,media.mimeType);return true;}
 if(['GET','HEAD'].includes(req.method)&&exportMatch){await exportVideo(req,res,store,workId,exportMatch[1],deps);return true;}
 if(req.method!=='POST')fail('未找到本机制作接口',404);
 if(action==='media'){const result=await upload(req,url,store,workId,deps);deps.json(res,201,result);return true;}
 const body=await deps.readBody(req);
 if(executionMatch?.[2]==='preview'){await store.writes;const work=clone(deps.workById(store,workId)),item=shot(work,executionMatch[1]),state=await executionState(work,item,executionContext),preview=await previewExecution(work,item,body.recipe??item.executionPrompt?.draft?.recipe,executionContext);deps.json(res,200,{...state,preview});return true;}
 if(action==='export'){
  if(Object.keys(body).some(key=>!['episodeId','exportOptions','timelineOverride'].includes(key)))fail('导出请求包含不支持的字段');
  const selected=episode(initial,body.episodeId),timeline=resolveExportTimeline(initial,selected.id,body.timelineOverride,validateTimeline),options=normalizeExportOptions(body.exportOptions,timeline);assertReframeExport(timeline,options);
  if(options.enhance==='ai-1080p'){const capability=await(store.context.getUpscaleCapability||(await import('./ai-upscale.mjs')).getUpscaleCapability)({dataDir:store.context.dataDir});if(capability?.available!==true)fail(typeof capability?.reason==='string'?capability.reason:'AI 超分引擎尚未就绪，请先使用普通审片导出',503);}
 }
 let extra={},status=200,exportSnapshot=null;
 const work=await deps.serial(store,async()=>{
  const work=deps.workById(store,workId),studio=hydrateStudio(work);
  if(cuesMatch){
   const item=shot(work,cuesMatch[1]);idleShot(work,item);extra=await saveProductionCues(work,item,body,{dataDir:store.context.dataDir,...executionContext});if(!extra.unchanged){item.approvalStatus='draft';item.updatedAt=now();}extra.shot=clone(item);
  }else if(executionMatch?.[2]){
   const item=shot(work,executionMatch[1]);idleShot(work,item);extra=await changeExecution(work,item,executionMatch[2],body,executionContext);extra.shot=clone(item);item.updatedAt=now();
  }else if(action==='op-ed/templates'||/^op-ed\/templates\/[^/]+\/versions$/.test(action)||action==='op-ed/apply'||action==='op-ed/detach'){
   const candidate=clone(work),context={validateTimeline,resolveMedia:media=>studioMediaPath(deps.workspace(store,workId),media)};
   if(action==='op-ed/templates')extra=await createOpEdEntry(candidate,body,context);
   else if(action==='op-ed/apply')extra=await applyOpEdVersion(candidate,body,context);
   else if(action==='op-ed/detach')extra=detachOpEdVersion(candidate,body);
   else{const entryId=action.split('/')[2];extra=await appendOpEdVersion(candidate,entryId,body,context);}
   work.studio=candidate.studio;
  }else if(action==='script'||action==='script/split'){
   const selected=episode(work,body.episodeId),value=action==='script/split'?splitScript(body.text):{text:text(body.text,'剧本',100000)};
   const current=studio.scripts[selected.id]||{text:'',splitSources:[]};current.text=value.text;current.updatedAt=now();current.splitSources??=[];studio.scripts[selected.id]=current;
   if(action==='script/split'){
    const previous=current.splitSources.find(item=>item.sourceHash===value.hash);
    if(previous)extra={createdShotIds:previous.shotIds,alreadySplit:true,method:'rule-paragraphs'};
    else{let count=work.shots.filter(item=>item.episodeId===selected.id).length;const createdShotIds=[];for(const piece of value.pieces){const timestamp=now(),item={id:randomUUID(),episodeId:selected.id,title:piece.split('\n')[0].slice(0,100)||'分镜 '+(count+1),prompt:piece,duration:4,ratio:'16:9',resolution:'352P',number:++count,status:'draft',assetIds:[],characterIds:[],sceneId:null,voiceIds:[],firstFrameMediaId:null,approvalStatus:'draft',sourceHash:value.hash,createdAt:timestamp,updatedAt:timestamp};work.shots.push(item);ensureShotTimelineSlot(work,item);createdShotIds.push(item.id);}current.splitSources.push({sourceHash:value.hash,shotIds:createdShotIds,createdAt:now()});extra={createdShotIds,alreadySplit:false,method:'rule-paragraphs'};}
   }
  }else if(action.startsWith('libraries/')){
   const category=action.slice('libraries/'.length);if(!CATEGORIES.includes(category))fail('素材库分类无效');const input=object(body.entry)?body.entry:body;
   const entry={id:input.id?ident(input.id):randomUUID(),name:text(input.name,'素材设定名称',120,true),description:text(input.description??'','描述',10000),lockedTraits:text(input.lockedTraits??'','固定特征',10000),negativeConstraints:text(input.negativeConstraints??'','禁止变化',10000),mediaIds:ids(input.mediaIds??[],'设定参考'),locked:input.locked!==false,voiceStyle:text(input.voiceStyle??'','音色风格',2000),updatedAt:now()};
   if('voiceProfile'in input){if(category!=='characters')fail('角色音色只能保存在角色卡');entry.voiceProfile=input.voiceProfile===null?null:await resolveCharacterVoiceProfile(store.context.dataDir,workId,input.voiceProfile);}
   if('skillIds'in input){
    const scenarios=category==='characters'?['character','character-writing']:category==='scenes'?['scene']:null;
    if(!scenarios)fail('设计技能只能保存在角色或场景设定');if(!Array.isArray(input.skillIds))fail('设计技能须为已登记技能编号数组');
    const snapshot=await(deps.resolveCreativeSkills||resolveCreativeSkills)(store.context.dataDir,input.skillIds);
    if(snapshot.some(skill=>!scenarios.includes(skill.scenario)))fail(category==='characters'?'角色设定只能选择人物设计或人物塑造技能':'场景设定只能选择场景设计技能');
    entry.skillIds=snapshot.map(skill=>skill.id);entry.skillSnapshot=snapshot;
   }
   for(const key of entry.mediaIds)mediaById(work,key,['characters','scenes'].includes(category)?'image':'audio');
   const existing=studio.libraries[category].find(item=>item.id===entry.id);if(input.id&&!existing)fail('该设定不属于当前作品',404);if(existing)Object.assign(existing,entry);else studio.libraries[category].push({...entry,createdAt:now()});extra={entry:clone(existing||studio.libraries[category].at(-1))};status=existing?200:201;
  }else if(/^shots\/[^/]+\/(bind|confirm|prompt|save)$/.test(action)){
   const [,shotId,operation]=/^shots\/([^/]+)\/(bind|confirm|prompt|save)$/.exec(action),item=shot(work,shotId);idleShot(work,item);
   if(operation==='bind'){
    const changes=await validateBindings(store,workId,work,body,deps);
    Object.assign(item,changes,{approvalStatus:'draft',updatedAt:now()});
   }else if(operation==='save'){
    const metadata=deps.shotFields({title:body.title??item.title,duration:body.duration??item.duration,ratio:body.ratio??item.ratio,resolution:body.resolution??item.resolution},true),bindings=await validateBindings(store,workId,work,body,deps),candidate={...item,...metadata,...bindings},fields=promptFields(work,candidate,body);
    const changes={...metadata,...bindings,...fields},changed=Object.entries(changes).some(([key,value])=>key!=='promptSnapshot'&&JSON.stringify(item[key])!==JSON.stringify(value));
    Object.assign(item,changes,changed?{approvalStatus:'draft',status:'draft'}:{});extra={prompt:item.prompt,method:'h3-structured-template'};
   }else if(operation==='confirm'){
    if(!item.prompt.trim())fail('请先填写分镜画面或提示词');item.approvalStatus='confirmed';item.approvedAt=now();ensureShotTimelineSlot(work,item).title=item.title;
   }else{
    Object.assign(item,promptFields(work,item,body),{approvalStatus:'draft'});extra={prompt:item.prompt,method:'h3-structured-template'};
   }
   item.updatedAt=now();extra.shot=clone(item);
  }else if(action==='timeline'){
   episode(work,body.episodeId);studio.timelines[body.episodeId]=preserveOpEdReferences(work,validateTimeline(work,body.episodeId,body.timeline),studio.timelines[body.episodeId]);
  }else if(action==='export'){
   const selected=episode(work,body.episodeId);if(studio.exports.some(job=>job.episodeId===selected.id&&['queued','running'].includes(job.status)))fail('本集已有进行中的本机合成任务',409);
   const timeline=resolveExportTimeline(work,selected.id,body.timelineOverride,validateTimeline),exportOptions=normalizeExportOptions(body.exportOptions,timeline),storyboard=exportOptions.mode==='storyboard';assertReframeExport(timeline,exportOptions);
   const selectionSnapshot=storyboard?await freezeStoryboardSelection(work,selected.id,timeline,deps.workspace(store,workId),exportOptions):work.shots.filter(item=>item.episodeId===selected.id).map(item=>({shotId:item.id,selectedAssetId:item.selectedAssetId||item.assetIds.at(-1)||null}));
   if(!storyboard){const reframes=await freezeReframeSelection(work,timeline,deps.workspace(store,workId));selectionSnapshot.push(...reframes);}
   const job={id:randomUUID(),episodeId:selected.id,status:'queued',progress:0,message:storyboard?'已加入本机故事板静态预演任务':exportOptions.enhance==='ai-1080p'?'已加入 AI 1080P 发布版导出任务':'已加入本机合成任务',createdAt:now(),exportOptions,...(body.timelineOverride===undefined?{}:{timelineSource:'override'}),timelineSnapshot:clone(timeline),selectionSnapshot};studio.exports.push(job);extra={exportJob:clone(job)};exportSnapshot=clone(work);status=202;
  }else fail('未找到本机制作接口',404);
  work.updatedAt=now();await deps.persist(store);return deps.presentWork(work);
 });
 deps.json(res,status,{work,studio:work.studio,...extra});if(exportSnapshot)startExport(store,workId,extra.exportJob.id,exportSnapshot,deps);return true;
}
