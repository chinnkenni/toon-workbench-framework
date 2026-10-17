import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {collectComfyTelemetry} from './comfy-telemetry.mjs';

const positive=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;
export function elapsed(start,end){const value=Date.parse(end)-Date.parse(start);return Number.isFinite(value)&&value>=0?value:null;}
export function calculateRates(output,productionMs,serverExecutionMs){
 const seconds=positive(output?.durationSeconds),frames=positive(output?.frames),production=positive(productionMs),server=positive(serverExecutionMs);
 return {
  productionFps:frames&&production?frames/(production/1000):null,
  secondsPerVideoSecond:seconds&&production?(production/1000)/seconds:null,
  videoSecondsPerMinute:seconds&&production?seconds*60000/production:null,
  serverFps:frames&&server?frames/(server/1000):null,
 };
}
export function parseProbe(probe){
 const video=probe.streams?.find(s=>s.codec_type==='video');if(!video)throw new Error('成片中未检测到视频轨');
 const rational=value=>{if(typeof value!=='string')return positive(value);const [n,d]=value.split('/').map(Number);return positive(d?n/d:n);};
 const frames=positive(video.nb_read_frames)||positive(video.nb_frames),fps=rational(video.avg_frame_rate)||rational(video.r_frame_rate);
 const durationSeconds=positive(video.duration)||(frames&&fps?frames/fps:null);
 if(!durationSeconds)throw new Error('无法读取视频轨实际时长');
 return {durationSeconds,containerDurationSeconds:positive(probe.format?.duration),width:positive(video.width),height:positive(video.height),frames,fps,hasAudio:Boolean(probe.streams?.some(s=>s.codec_type==='audio'))};
}
export async function probeMedia(file,dataDir){
 const executable=process.platform==='win32'?join(dataDir,'toonflow','ffmpeg','win32-x64','ffprobe.exe'):'ffprobe';
 const output=await new Promise((resolve,reject)=>{
  const child=spawn(executable,['-v','error','-count_frames','-show_entries','stream=codec_type,width,height,nb_frames,nb_read_frames,avg_frame_rate,r_frame_rate,duration:format=duration','-of','json',file],{windowsHide:true});
  let stdout='',stderr='',done=false;const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(stdout);};
  const timer=setTimeout(()=>{child.kill();finish(new Error('读取成片指标超时'));},20000);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>128*1024){child.kill();finish(new Error('媒体指标输出超过限制'));}});
  child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-1000));child.on('error',finish);child.on('close',code=>finish(code===0?null:new Error(stderr||'FFprobe 无法读取成片')));
 });
 return parseProbe(JSON.parse(output));
}
async function sha256(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export function initialTelemetry(job){
 return {version:1,source:'legacy-timestamps',queueMs:elapsed(job.createdAt,job.startedAt),productionMs:elapsed(job.startedAt,job.outputReadyAt||job.finishedAt),totalMs:elapsed(job.createdAt,job.finishedAt),output:null,rates:calculateRates(null,null,null),parameters:null};
}
export async function measureGeneration({job,file,bytes,baseUrl,dataDir,context={},productionMs,outputReadyAt}){
 const telemetry={...initialTelemetry(job),source:productionMs===undefined?'legacy-timestamps':'measured',productionMs:productionMs??elapsed(job.startedAt,job.outputReadyAt||job.finishedAt),outputReadyAt:outputReadyAt||job.outputReadyAt||null,warnings:[]};
 try{telemetry.output=await (context.probeMedia||probeMedia)(file,dataDir);}catch(error){telemetry.warnings.push('实际媒体指标不可用：'+error.message);}
 try{
  const hash=await sha256(file);telemetry.sha256=hash;
  const previous=job.telemetry;
  if(previous?.sha256&&previous.sha256!==hash)return {...structuredClone(previous),artifactChanged:true,observedSha256:hash,warnings:[...(previous.warnings||[]),'成片文件内容已变化，保留原始生产记录，未用修改后的视频覆盖速率。']};
  if(previous?.sha256===hash&&previous.provenance?.source==='comfyui-history-sha256'&&previous.parameters&&Number.isFinite(previous.serverExecutionMs)){
   for(const field of ['promptId','serverExecutionMs','serverStartedAt','serverFinishedAt','parameters','provenance'])telemetry[field]=structuredClone(previous[field]);
  }
  else if(baseUrl){const server=await collectComfyTelemetry({fetcher:context.fetch||fetch,baseUrl,sha256:hash,bytes,request:job.request,startedAt:job.startedAt,finishedAt:outputReadyAt||job.outputReadyAt||job.finishedAt,legacy:telemetry.source==='legacy-timestamps'});Object.assign(telemetry,server);}
  else telemetry.unavailable='GB10 隧道未就绪，未取得服务器执行参数与时间';
 }catch(error){telemetry.unavailable='服务器执行指标不可用：'+error.message;}
 telemetry.rates=calculateRates(telemetry.output,telemetry.productionMs,telemetry.serverExecutionMs);
 return telemetry;
}
export async function writeGenerationAudit(directory,job){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.id||''))throw new Error('生产日志任务编号无效');
 const folder=join(directory,'generation-logs');await mkdir(folder,{recursive:true});
 const file=join(folder,job.id+'.json'),temporary=file+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,JSON.stringify({version:1,job},null,2),{mode:0o600});await rename(temporary,file);
}
export const measurementDefinitions={
 productionMs:'本机开始调用至正式接口返回成片已保存，包含模型加载、远端等待、生成、轮询与回传；历史任务按原开始/完成时间回算。',
 totalMs:'本机提交至后台最终登记完成，包含本机排队和指标采集。',
 serverExecutionMs:'ComfyUI execution_start 至 execution_success 的服务器工作流墙钟时间，含加载、推理、解码及编码，不是纯 GPU 内核时间。',
 output:'FFprobe 对实际成片视频轨测量；帧数及视频时长可能因音画对齐而不同于请求值。',
 rates:'productionFps=成片实际帧数/生产秒；secondsPerVideoSecond=生产秒/视频轨实际秒；videoSecondsPerMinute=视频轨实际秒×60/生产秒；serverFps使用服务器工作流秒。',
};
