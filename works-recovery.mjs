import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,realpath,mkdir,open,link,unlink} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {expectedVideo,graphParameters,executionTimes} from './comfy-telemetry.mjs';
import {probeMedia,calculateRates} from './generation-telemetry.mjs';
import {studioMediaPath} from './studio.mjs';

const BASE='http://127.0.0.1:19188';
const MODEL='MiniMax-H3-GB10';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_VIDEO=100*1024*1024;
const NEGATIVE='blurry, low quality, deformed, inconsistent character, camera shake';
const clone=value=>structuredClone(value);
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
const within=(base,file)=>{const rel=relative(base,file);if(!rel||rel.startsWith('..')||isAbsolute(rel))fail('恢复媒体路径越界');return file;};

async function roots(dataDir,workId){
 const data=await realpath(dataDir),directory=resolve(dataDir,'toonflow','workspaces','works-'+workId),root=await realpath(directory);
 within(data,root);if((await lstat(directory)).isSymbolicLink())fail('恢复工作区不能使用目录链接');return {data,root};
}
async function folder(root,...parts){
 let current=root;
 for(const part of parts){current=join(current,part);try{const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())fail('恢复目录不能是文件或目录链接');}catch(error){if(error.code!=='ENOENT')throw error;await mkdir(current);}
  within(root,await realpath(current));
 }
 return current;
}
async function fingerprint(file){
 const before=await lstat(file);if(!before.isFile()||before.isSymbolicLink())fail('恢复媒体必须为普通文件');
 const hash=createHash('sha256');let bytes=0;for await(const part of createReadStream(file)){bytes+=part.length;hash.update(part);}
 const after=await lstat(file);if(before.size!==bytes||after.size!==bytes||before.mtimeMs!==after.mtimeMs||after.isSymbolicLink())fail('恢复媒体在核对期间发生变化');
 return {sha256:hash.digest('hex'),bytes};
}
function fixedParameters(parameters,save){return parameters&&parameters.weightDtype==='default'&&parameters.steps===20&&parameters.cfg===1&&parameters.denoise===1&&parameters.sampler==='euler'&&parameters.scheduler==='simple'&&parameters.shiftVideo===12&&parameters.shiftAudio===3&&parameters.negativePrompt===NEGATIVE&&save?.filename_prefix==='rack/toonflow_h3'&&save?.format==='auto'&&save?.codec==='auto';}

/** Only reads the fixed SSH tunnel. Never submits a provider or ComfyUI job. */
function remoteReader(fetcher){
 const deadline=Date.now()+60000;
 return async(path,{max,collect=false,write,mime}={})=>{
  const remaining=Math.min(15000,deadline-Date.now());if(remaining<=0)fail('恢复核对超过时间限制');
  const response=await fetcher(BASE+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(remaining)});
  if(!response.ok)fail('无法读取原 GB10 记录或产物（HTTP '+response.status+'）');
  if(mime&&(response.headers.get('content-type')||'').split(';')[0]!==mime){await response.body?.cancel();fail('原 GB10 产物媒体类型不匹配');}
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max)){await response.body?.cancel();fail('原 GB10 产物超过核对上限');}
  const chunks=[],hash=createHash('sha256');let bytes=0;
  for await(const chunk of response.body||[]){const part=Buffer.from(chunk);bytes+=part.length;if(bytes>max||Date.now()>deadline)fail('原 GB10 产物超过核对大小或时间限制');hash.update(part);if(collect)chunks.push(part);if(write){let offset=0;while(offset<part.length){const result=await write.write(part,offset,part.length-offset);if(!result.bytesWritten)fail('无法完整暂存原视频');offset+=result.bytesWritten;}}}
  if(!bytes||length!==null&&bytes!==Number(length))fail('原 GB10 产物字节不完整');
  return {bytes,sha256:hash.digest('hex'),...(collect?{data:Buffer.concat(chunks)}:{})};
 };
}
async function firstFrame(work,job,root){
 const request=job.request.firstFrame;if(!request){if(job.bindingSnapshot?.firstFrameMediaId)fail('原任务首帧证据不完整');return null;}
 if(typeof request.path!=='string'||!/^assets\/imported\/[a-f0-9-]{36}\.(png|jpe?g|webp)$/i.test(request.path))fail('原任务首帧路径无效');
 const media=work.studio?.media?.find(item=>item.type==='image'&&item.relativePath===request.path&&item.mimeType===request.mimeType);
 if(!media||!job.bindingSnapshot?.firstFrameMediaId||media.id!==job.bindingSnapshot.firstFrameMediaId)fail('无法确认原任务同作品首帧');
 const file=await studioMediaPath(root,media);within(root,file);const digest=await fingerprint(file);
 if(digest.bytes>25*1024*1024||digest.bytes<8||media.sha256&&media.sha256!==digest.sha256)fail('原任务首帧已变化或无效');
 return {file,mediaId:media.id,...digest};
}
function frameName(workflow,outputId,requiresFrame){
 // Follow the same output graph already checked by graphParameters.
 const save=workflow[outputId]?.inputs,video=workflow[String(save?.video?.[0])]?.inputs,decode=workflow[String(video?.images?.[0])]?.inputs,sampler=workflow[String(decode?.samples?.[0])]?.inputs,positive=workflow[String(sampler?.positive?.[0])]?.inputs;
 const ref=positive?.first_frame;if(!requiresFrame)return ref===undefined?null:false;
 if(!Array.isArray(ref)||ref.length!==2||ref[1]!==0)return false;const node=workflow[String(ref[0])];
 if(node?.class_type!=='LoadImage'||typeof node.inputs?.image!=='string'||!/^rack-frame-[0-9]+\.png$/.test(node.inputs.image))return false;
 return node.inputs.image;
}
function originalTiming(job){return {queueMs:job.telemetry?.queueMs??null,productionMs:job.telemetry?.productionMs??null,totalMs:job.telemetry?.totalMs??null};}

export async function verifyRecoveredVideo({dataDir,work,job}){
 if(job.status!=='succeeded'||job.recovery?.version!==1||!job.assetId||job.recovery.original?.status!=='interrupted')fail('仅可恢复已中断的原视频任务');
 const asset=work.assets.find(item=>item.id===job.assetId&&item.jobId===job.id&&item.shotId===job.shotId);
 if(!asset||asset.relativePath!==`assets/generated/video${job.id}.mp4`)fail('已恢复产物关联不完整，请人工核对');
 const {root}=await roots(dataDir,work.id),source=resolve(root,asset.relativePath);if((await lstat(source)).isSymbolicLink())fail('已恢复视频不能替换为文件链接');const file=within(root,await realpath(source));
 const digest=await fingerprint(file);if(digest.sha256!==job.recovery.output?.sha256||digest.bytes!==job.recovery.output?.bytes)fail('已恢复原视频文件发生变化，未重新下载或替换');
 return {asset:clone(asset),job:clone(job),alreadyRecovered:true,recovered:false};
}

/** Returns a validated file/evidence, leaving catalog mutation to the existing serial writer. */
export async function prepareVideoRecovery({dataDir,work,job,server,fetcher=fetch,probe=probeMedia,claimedPromptIds=[],otherJobs=[]}){
 if(!UUID.test(work.id)||!UUID.test(job.id)||job.workId!==work.id||job.status!=='interrupted'||job.assetId||job.modelId!==MODEL)fail('仅可恢复已中断且未登记成片的主 GB10 H3 原任务');
 if(!server||server.id!==job.serverId||!server.online||server.serviceLinks?.comfyui!==BASE||!job.serverSnapshot?.host||server.host!==job.serverSnapshot.host)fail('原任务主 GB10 绑定或在线隧道无法确认');
 const expected=expectedVideo(job.request),localStart=Date.parse(job.startedAt),interruptedAt=Date.parse(job.finishedAt);
 if(!expected||!Number.isFinite(localStart)||!Number.isFinite(interruptedAt)||interruptedAt<localStart)fail('原请求或中断时间证据不完整');
 const {root}=await roots(dataDir,work.id),frame=await firstFrame(work,job,root),read=remoteReader(fetcher),historyResponse=await read('/history?max_items=100',{max:8*1024*1024,collect:true});
 let history;try{history=JSON.parse(historyResponse.data.toString('utf8'));}catch{fail('GB10 历史记录格式无效');}
 if(!history||typeof history!=='object'||Array.isArray(history))fail('GB10 历史记录格式无效');
 const candidates=[];
 for(const [promptId,record]of Object.entries(history)){
  if(!UUID.test(promptId)||record.status?.status_str!=='success'||record.status?.completed!==true||record.prompt?.[1]!==promptId||record.prompt?.[3]?.client_id!=='rack-toonflow')continue;
  const times=executionTimes(record,promptId);if(!times||times.start<localStart-30000||times.start>interruptedAt+30000||times.finish>Date.now()+30000)continue;
  for(const [outputId,output]of Object.entries(record.outputs||{})){
   const workflow=record.prompt?.[2],parameters=graphParameters(workflow,outputId,job.request,expected);
   if(!fixedParameters(parameters,workflow?.[outputId]?.inputs))continue;
   const inputName=frameName(workflow,outputId,Boolean(frame));if(inputName===false)continue;
   for(const files of Object.values(output||{})){if(!Array.isArray(files))continue;for(const file of files){
    if(!file||file.type!=='output'||file.subfolder!=='rack'||typeof file.filename!=='string'||!/^toonflow_h3_[A-Za-z0-9_-]+\.mp4$/.test(file.filename))continue;
    if(!candidates.some(item=>item.promptId===promptId&&item.file.filename===file.filename))candidates.push({promptId,parameters,times,file:{filename:file.filename,subfolder:'rack',type:'output'},inputName});
   }}
  }
 }
 if(candidates.length>8)fail('原任务候选过多，未按时间先后猜选');
 const matches=[],inputHashes=new Map();
 for(const candidate of candidates){if(frame){if(!inputHashes.has(candidate.inputName))inputHashes.set(candidate.inputName,await read('/view?'+new URLSearchParams({filename:candidate.inputName,type:'input'}),{max:25*1024*1024}));const input=inputHashes.get(candidate.inputName);if(input.bytes!==frame.bytes||input.sha256!==frame.sha256)continue;}matches.push(candidate);}
 if(matches.length!==1)fail(matches.length?'多个远端成功任务与原请求和首帧完全匹配，未猜选':'未找到原请求、完整工作流和首帧唯一匹配的成功产物');
 const match=matches[0];if(claimedPromptIds.includes(match.promptId))fail('该远端产物已被其他任务登记，未重复认领');
 const competing=otherJobs.some(other=>{if(other.id===job.id||other.serverId!==job.serverId||other.modelId!==job.modelId)return false;const savedId=other.recovery?.promptId||other.telemetry?.promptId;if(savedId&&savedId!==match.promptId)return false;const a=other.request,b=job.request;if(!a||a.prompt?.trim()!==b.prompt.trim()||a.duration!==b.duration||a.ratio!==b.ratio||a.resolution!==b.resolution||Boolean(a.firstFrame)!==Boolean(b.firstFrame))return false;const start=Date.parse(other.startedAt),end=Date.parse(other.finishedAt);return Number.isFinite(start)&&match.times.start>=start-30000&&(!Number.isFinite(end)||match.times.start<=end+30000);});
 if(competing)fail('另一本机任务具有相同请求和重叠执行窗口且归属未确认，未认领远端产物');
 const generated=await folder(root,'assets','generated');await folder(root,'generation-logs');
 const relativePath=`assets/generated/video${job.id}.mp4`,target=join(generated,'video'+job.id+'.mp4'),temporary=join(generated,'recovery-'+job.id+'-'+randomUUID()+'.tmp');
 let handle,created=false;
 try{
  handle=await open(temporary,'wx');const digest=await read('/view?'+new URLSearchParams(match.file),{max:MAX_VIDEO,write:handle,mime:'video/mp4'});await handle.sync();await handle.close();handle=null;
  const prefix=await open(temporary,'r');try{const bytes=Buffer.alloc(12);await prefix.read(bytes,0,12,0);if(digest.bytes<16||bytes.toString('ascii',4,8)!=='ftyp')fail('原 GB10 输出不是合法 MP4');}finally{await prefix.close();}
  const output=await probe(temporary,dataDir);if(output.width!==expected.width||output.height!==expected.height||output.fps!==24||!Number.isSafeInteger(output.frames)||output.frames<expected.requestedFrames||output.frames>expected.requestedFrames+24||!output.hasAudio||!Number.isFinite(output.durationSeconds)||Math.abs(output.durationSeconds-output.frames/24)>0.02)fail('原视频实测尺寸、帧率、帧数或音轨与 H3 输出不符');
  if(frame){const current=await fingerprint(frame.file);if(current.sha256!==frame.sha256||current.bytes!==frame.bytes)fail('原首帧在恢复期间发生变化');}
  if(work.assets.some(asset=>asset.relativePath===relativePath&&asset.jobId!==job.id))fail('恢复目标路径已有其他任务产物');
  try{await link(temporary,target);created=true;}catch(error){if(error.code!=='EEXIST')throw error;const existing=await fingerprint(target);within(root,await realpath(target));if(existing.sha256!==digest.sha256||existing.bytes!==digest.bytes)fail('恢复目标已有不同文件，未覆盖原件');}
  await unlink(temporary);
  const recoveredAt=new Date().toISOString(),original={status:job.status,progress:job.progress,message:job.message,finishedAt:job.finishedAt,...(job.error!==undefined?{error:job.error}:{}),telemetry:clone(job.telemetry||null)},recovery={version:1,recoveredAt,original,promptId:match.promptId,method:'unique-original-request-fixed-workflow-and-input-sha256',requestSha256:createHash('sha256').update(JSON.stringify(job.request)).digest('hex'),...(frame?{firstFrame:{mediaId:frame.mediaId,sha256:frame.sha256,bytes:frame.bytes,remoteFilename:match.inputName}}:{}),remoteArtifact:match.file,output:{...digest, ...output},serverStartedAt:new Date(match.times.start).toISOString(),serverFinishedAt:new Date(match.times.finish).toISOString(),serverExecutionMs:match.times.finish-match.times.start};
  const timing=originalTiming(job),telemetry={...clone(job.telemetry||{}),version:1,source:'recovered-artifact',...timing,output,sha256:digest.sha256,promptId:match.promptId,serverExecutionMs:recovery.serverExecutionMs,serverStartedAt:recovery.serverStartedAt,serverFinishedAt:recovery.serverFinishedAt,parameters:match.parameters,rates:calculateRates(output,timing.productionMs,recovery.serverExecutionMs),provenance:{source:'comfyui-history-sha256',matchedBy:recovery.method,sha256:digest.sha256,bytes:digest.bytes,remoteArtifact:match.file,observedAt:recoveredAt,executionScope:'server-workflow-wall-clock',timestampSource:'ComfyUI execution_start/execution_success milliseconds'},warnings:[...(job.telemetry?.warnings||[]),'原任务中断后找回原产物；本机缺失耗时未以恢复时间或服务器耗时补算。']};
  const asset={id:randomUUID(),shotId:job.shotId,jobId:job.id,type:'video',mimeType:'video/mp4',filename:'video'+job.id+'.mp4',relativePath,bytes:digest.bytes,sha256:digest.sha256,url:`/api/works/${work.id}/assets/`,createdAt:recoveredAt,recoveredAt};asset.url+=asset.id;
  return {asset,telemetry,recovery,cleanup:async()=>{if(created)await unlink(target).catch(()=>{});}};
 }catch(error){if(created)await unlink(target).catch(()=>{});throw error;}finally{await handle?.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
}
