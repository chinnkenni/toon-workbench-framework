import {readFile,writeFile,mkdir,realpath,stat,rename,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {withGpuLease} from './gpu-lease.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url)),BASE='http://127.0.0.1:19188';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,MAX_BYTES=256*1024*1024,CHUNK_FRAMES=24;
const NODE_NAMES=['LoadVideo','VideoTemporalCrop','GetVideoComponents','UpscaleModelLoader','ImageUpscaleWithModel','CreateVideo','SaveVideo'];
let capabilityCache=null;
const active=new Map();
const fail=(message,status=502)=>Object.assign(new Error(message),{status});
function inside(base,target){const value=relative(base,target);if(!value||value.startsWith('..')||isAbsolute(value))throw fail('超分文件路径越界',400);return target;}
function safePart(value){return typeof value==='string'&&value.length<300&&!value.includes('\\')&&!value.includes('\0')&&!value.split('/').some(part=>!part||part==='.'||part==='..')&&!value.startsWith('/')&&!value.includes(':');}
export async function sha256File(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function modelManifest(){const value=JSON.parse(await readFile(join(ROOT,'deployment','upscale-model.json'),'utf8'));if(!/^[A-Za-z0-9_.-]+\.pth$/.test(value.fileName)||! /^[a-f0-9]{64}$/.test(value.sha256)||value.nativeScale!==4)throw fail('超分模型登记无效',503);return value;}
async function jsonRequest(path,{body,timeout=20000,fetcher=fetch}={}){
 const response=await fetcher(BASE+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(timeout),...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
 const chunks=[];let size=0;for await(const bytes of response.body){size+=bytes.length;if(size>8*1024*1024)throw fail('GB10 返回数据超过限制');chunks.push(bytes);}
 const text=Buffer.concat(chunks).toString('utf8');if(!response.ok)throw fail('GB10 超分请求失败：HTTP '+response.status+' '+text.slice(0,900));return JSON.parse(text);
}
export async function getUpscaleCapability({dataDir,fetcher=fetch,force=false}={}){
 if(!force&&fetcher===fetch&&capabilityCache&&Date.now()-capabilityCache.at<15000)return capabilityCache.value;
 let value;try{
  const model=await modelManifest(),nodes=await Promise.all(NODE_NAMES.map(name=>jsonRequest('/object_info/'+name,{fetcher,timeout:5000})));
  if(nodes.some((node,index)=>!node[NODE_NAMES[index]]))throw fail('GB10 缺少视频超分核心节点',503);
  const combo=nodes[3].UpscaleModelLoader.input.required.model_name,available=Array.isArray(combo[0])?combo[0]:combo[1]?.options;
  if(!available?.includes(model.fileName))throw fail('GB10 超分模型尚未就绪',503);
  value={available:true,ready:true,engine:'ComfyUI',model:{name:model.name,fileName:model.fileName,sha256:model.sha256,nativeScale:model.nativeScale,sourceUrl:model.sourceUrl,verified:model.evidence.localAndRemoteHashesMatch,verifiedAt:model.evidence.checkedDate},message:'动漫视频 AI ×4 超分，在原始视频上处理后合成 1080P。'};
 }catch(error){value={available:false,ready:false,reason:error.message,message:error.message};}
 if(fetcher===fetch)capabilityCache={at:Date.now(),value};return value;
}
export function buildUpscaleWorkflow({inputFile,startFrame,length,modelFile,prefix}){
 if(!safePart(inputFile)||!safePart(prefix)||!/^[-\w.]+\.pth$/.test(modelFile)||!Number.isInteger(startFrame)||startFrame<0||startFrame>99999||!Number.isInteger(length)||length<1||length>CHUNK_FRAMES)throw fail('超分工作流参数无效',400);
 return {
  '1':{class_type:'LoadVideo',inputs:{file:inputFile}},
  '2':{class_type:'VideoTemporalCrop',inputs:{video:['1',0],start_frame:startFrame,length}},
  '3':{class_type:'GetVideoComponents',inputs:{video:['2',0]}},
  '4':{class_type:'UpscaleModelLoader',inputs:{model_name:modelFile}},
  '5':{class_type:'ImageUpscaleWithModel',inputs:{image:['3',0],upscale_model:['4',0]}},
  '6':{class_type:'CreateVideo',inputs:{images:['5',0],fps:['3',2]}},
  '7':{class_type:'SaveVideo',inputs:{video:['6',0],filename_prefix:prefix,format:'mp4',codec:'h264','codec.encoding':'re-encode','codec.encoding.crf':15}},
 };
}
function run(executable,args,{cwd,timeout=300000}={}){return new Promise((resolve,reject)=>{
 const child=spawn(executable,args,{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let output='',error='',done=false;
 const finish=err=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(output);};
 const timer=setTimeout(()=>{child.kill();finish(fail('本机超分媒体处理超时',504));},timeout);
 child.stdout.on('data',bytes=>{output+=bytes;if(output.length>1024*1024){child.kill();finish(fail('媒体探测结果超过限制'));}});child.stderr.on('data',bytes=>{error=(error+bytes).slice(-3000);});child.on('error',finish);child.on('close',code=>finish(code===0?null:fail('超分视频检查或封装失败：'+error)));
});}
async function probeVideo(executable,file){const result=JSON.parse(await run(executable,['-v','error','-protocol_whitelist','file,pipe','-count_frames','-show_streams','-show_format','-of','json',file])),video=result.streams.find(stream=>stream.codec_type==='video'),audio=result.streams.find(stream=>stream.codec_type==='audio');
 const [n,d]=String(video?.avg_frame_rate||'0/1').split('/').map(Number),fps=n/d,frames=Number(video?.nb_read_frames)||Number(video?.nb_frames),duration=Number(video?.duration)||frames/fps;
 return {width:Number(video?.width),height:Number(video?.height),frames,fps,duration,hasVideo:!!video,hasAudio:!!audio,videoCodec:video?.codec_name,audioCodec:audio?.codec_name};
}
export function validateUpscaleMedia(source,result,scale=4){
 if(![source.width,source.height,source.frames,source.fps,source.duration,result.width,result.height,result.frames,result.fps,result.duration,scale].every(value=>Number.isFinite(value)&&value>0)||!Number.isInteger(source.frames)||!Number.isInteger(result.frames))throw fail('超分媒体缺少有效的实际帧数、帧率或时长');
 if(!result.hasVideo||result.width!==source.width*scale||result.height!==source.height*scale||result.frames!==source.frames||Math.abs(result.fps-source.fps)>.001||Math.abs(result.duration-source.duration)>1/source.fps+.005||source.hasAudio&&!result.hasAudio)throw fail('AI 超分未通过实际分辨率、帧数、时长或音轨校验');
 return true;
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function downloadOutput(file,target){
 if(file.type!=='output'||!safePart(file.filename)||!safePart(file.subfolder)||!file.filename.endsWith('.mp4')||!file.subfolder.startsWith('rack-upscale/'))throw fail('GB10 超分输出登记无效');
 const response=await fetch(BASE+'/view?'+new URLSearchParams({filename:file.filename,subfolder:file.subfolder,type:'output'}),{redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw fail('回传超分结果失败：HTTP '+response.status);
 let size=0;const chunks=[];for await(const bytes of response.body){size+=bytes.length;if(size>MAX_BYTES)throw fail('单批超分结果超过 256 MB');chunks.push(bytes);}if(!size)throw fail('超分结果为空');const data=Buffer.concat(chunks);await writeFile(target,data,{flag:'wx'});return {bytes:size,sha256:createHash('sha256').update(data).digest('hex')};
}
async function executeChunk(workflow,{onProgress,completed,total,audit,saveAudit}){
 const submitted=await jsonRequest('/prompt',{body:{prompt:workflow,client_id:'rack-studio-upscale'}});if(!UUID.test(submitted.prompt_id||''))throw fail('GB10 没有返回有效超分任务编号');
 const task={promptId:submitted.prompt_id,startFrame:completed,frames:workflow['2'].inputs.length,submittedAt:new Date().toISOString()};audit.tasks.push(task);await saveAudit();
 const deadline=Date.now()+60*60_000;
 while(Date.now()<deadline){
  let history;try{history=(await jsonRequest('/history/'+task.promptId))[task.promptId];}catch(error){throw fail(error.message+'；已提交的超分任务编号：'+task.promptId);}
  if(history?.status?.status_str==='error')throw fail('GB10 超分失败（任务 '+task.promptId+'）：'+JSON.stringify(history.status.messages).slice(0,1600));
  if(history?.status?.completed){
   if(JSON.stringify(history.prompt?.[2])!==JSON.stringify(workflow))throw fail('超分任务工作流与提交快照不一致');
   const files=Object.values(history.outputs?.['7']||{}).flat();const file=files.find(item=>item?.filename?.endsWith('.mp4'));if(!file)throw fail('超分任务结束但没有视频输出：'+task.promptId);
   const events=history.status.messages||[],start=events.find(item=>item[0]==='execution_start')?.[1]?.timestamp,end=events.find(item=>item[0]==='execution_success')?.[1]?.timestamp;
   Object.assign(task,{finishedAt:new Date().toISOString(),output:file,serverExecutionMs:Number.isFinite(start)&&end>=start?end-start:null});await saveAudit();return {file,task};
  }
  await onProgress?.({phase:'upscaling',completedFrames:completed,totalFrames:total,message:`GB10 正在超分 ${completed} / ${total} 帧；任务 ${task.promptId.slice(0,8)}`});await delay(2000);
 }
 throw fail('超分等待超过 60 分钟；已提交的任务编号：'+task.promptId,504);
}
export async function upscaleTimelineSource(options){
 const {file,record,probe:declared,workId,exportId,dataDir,workspaceDirectory,onProgress}=options;
 if(!UUID.test(workId||'')||!UUID.test(exportId||''))throw fail('超分作品或任务编号无效',400);
 const workspace=await realpath(workspaceDirectory),source=await realpath(file);inside(workspace,source);const info=await stat(source);if(!info.isFile()||info.size>MAX_BYTES)throw fail('超分输入须为 256 MB 内的作品视频',400);
 const model=await modelManifest(),sourceSha256=await sha256File(source),key=model.sha256+'-'+sourceSha256;
 const cachePath=join(workspace,'.rack-upscale-cache');await mkdir(cachePath,{recursive:true});const cache=await realpath(cachePath);inside(workspace,cache);
 const target=join(cache,key+'.mp4'),evidence=join(cache,key+'.json'),ffmpeg=join(dataDir,'toonflow','ffmpeg','win32-x64','ffmpeg.exe'),ffprobe=join(dataDir,'toonflow','ffmpeg','win32-x64','ffprobe.exe');
 try{const telemetry=JSON.parse(await readFile(evidence,'utf8')),output=await realpath(target);inside(cache,output);if(telemetry.status==='succeeded'&&telemetry.sourceSha256===sourceSha256&&telemetry.model.sha256===model.sha256&&telemetry.outputSha256===await sha256File(output)){const probe=await probeVideo(ffprobe,output);validateUpscaleMedia(telemetry.input,probe,4);return {file:output,probe,telemetry:{...telemetry,cacheHit:true,cacheReusedAt:new Date().toISOString()}};}}catch(error){if(error.code!=='ENOENT'&&error.status)throw error;}
 const lockKey=workspace+'|'+key;
 if(active.has(lockKey)){const result=await active.get(lockKey);return {...result,telemetry:{...result.telemetry,cacheHit:true}};}
 const operation=withGpuLease(async()=>{
  const capability=await getUpscaleCapability({dataDir,force:true});if(!capability.available)throw fail(capability.reason,503);
  const input=await probeVideo(ffprobe,source);if(!input.hasVideo||!Number.isInteger(input.frames)||input.frames<1||input.frames>18000||!input.fps||input.duration>600||input.width>2048||input.height>2048)throw fail('当前超分支持 600 秒内、2048 像素以内的有效视频源',400);
  const started=performance.now(),attempt=join(cache,exportId+'-'+randomUUID());await mkdir(attempt);inside(cache,await realpath(attempt));
  const audit={schemaVersion:1,method:'real-esrgan',engine:'ComfyUI',model:capability.model,sourceId:record?.id||null,sourceSha256,input,workId,exportId,startedAt:new Date().toISOString(),status:'running',tasks:[],chunkFrames:CHUNK_FRAMES,cacheHit:false};
  const auditFile=join(cache,exportId+'-'+sourceSha256+'.attempt.json'),saveAudit=()=>writeFile(auditFile,JSON.stringify(audit,null,2));await saveAudit();
  try{
   await onProgress?.({phase:'upscaling',completedFrames:0,totalFrames:input.frames,message:'正在将本镜原始视频送往 GB10 超分'});
   const form=new FormData(),subfolder='rack-upscale/'+workId+'/'+exportId;form.set('image',new Blob([await readFile(source)],{type:'video/mp4'}),sourceSha256+'.mp4');form.set('subfolder',subfolder);form.set('type','input');
   const response=await fetch(BASE+'/upload/image',{method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw fail('上传原视频失败：HTTP '+response.status);const uploaded=await response.json();if(uploaded.name!==sourceSha256+'.mp4'||uploaded.subfolder!==subfolder||uploaded.type!=='input')throw fail('GB10 上传路径与本次任务不一致');
   let index=0;for(let startFrame=0;startFrame<input.frames;startFrame+=CHUNK_FRAMES){
    const length=Math.min(CHUNK_FRAMES,input.frames-startFrame),workflow=buildUpscaleWorkflow({inputFile:subfolder+'/'+uploaded.name,startFrame,length,modelFile:model.fileName,prefix:`rack-upscale/${workId}/${exportId}/${sourceSha256}-${index}`});
    const result=await executeChunk(workflow,{onProgress,completed:startFrame,total:input.frames,audit,saveAudit});Object.assign(result.task,{download:await downloadOutput(result.file,join(attempt,`part-${index}.mp4`))});await saveAudit();
    await onProgress?.({phase:'upscaling',completedFrames:startFrame+length,totalFrames:input.frames,message:`GB10 已超分 ${startFrame+length} / ${input.frames} 帧`});index++;
   }
   await writeFile(join(attempt,'parts.ffconcat'),'ffconcat version 1.0\n'+Array.from({length:index},(_,i)=>`file 'part-${i}.mp4'\n`).join(''));
   await run(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-f','concat','-safe','1','-i','parts.ffconcat','-i',source,'-map','0:v:0','-map','1:a?','-c','copy','-movflags','+faststart','upscaled.mp4'],{cwd:attempt});
   const resultFile=join(attempt,'upscaled.mp4'),output=await probeVideo(ffprobe,resultFile);validateUpscaleMedia(input,output,4);
   Object.assign(audit,{status:'succeeded',finishedAt:new Date().toISOString(),productionMs:performance.now()-started,serverExecutionMs:audit.tasks.every(task=>task.serverExecutionMs!==null)?audit.tasks.reduce((sum,task)=>sum+task.serverExecutionMs,0):null,output,outputSha256:await sha256File(resultFile),outputBytes:(await stat(resultFile)).size,audioMethod:'original-stream-copy',postResize:'Final timeline uses Lanczos contain after model inference; titles are rendered natively at export size.'});
   // This task owns a unique temporary directory; successful caches are immutable by content key.
   try{await stat(target);throw fail('超分缓存已存在但校验不匹配，请保留证据后检查');}catch(error){if(error.code!=='ENOENT')throw error;}
   await rename(resultFile,target);await writeFile(evidence,JSON.stringify(audit,null,2));await saveAudit();return {file:target,probe:output,telemetry:audit};
  }catch(error){Object.assign(audit,{status:'failed',error:error.message,finishedAt:new Date().toISOString(),productionMs:performance.now()-started});await saveAudit().catch(()=>{});throw error;}
  finally{inside(cache,attempt);await rm(attempt,{recursive:true,force:true});}
 });active.set(lockKey,operation);try{return await operation;}finally{active.delete(lockKey);}
}
