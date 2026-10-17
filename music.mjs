import {mkdir,readFile,writeFile,rename,realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {withGpuLease} from './gpu-lease.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url)),BASE='http://127.0.0.1:19188';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED=['CheckpointLoaderSimple','TextEncodeAceStepAudio1.5','EmptyAceStep1.5LatentAudio','ModelSamplingAuraFlow','ConditioningZeroOut','KSampler','VAEDecodeAudio','SaveAudio'];
const ACTIVE=new Set(['queued','running']),stores=new Map();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const clone=value=>structuredClone(value),now=()=>new Date().toISOString();
function identify(value){if(!UUID.test(value||''))throw fail('作品或配乐任务编号无效');return value;}
function inside(root,target){const rel=relative(root,target);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw fail('配乐文件路径越界',403);return target;}
function json(req,res,status,value){const body=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:body);}
async function bytes(response,limit){const parts=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>limit)throw fail('配乐服务返回内容超过限制',502);parts.push(chunk);}return Buffer.concat(parts);}
async function remoteJson(path,context,{body,timeout=15000}={}){
 const response=await (context.fetcher||context.fetch||fetch)(BASE+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(timeout),...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
 const raw=await bytes(response,8*1024*1024);if(!response.ok)throw fail('GB10 配乐请求失败：HTTP '+response.status+' '+raw.toString('utf8').slice(0,500),502);
 try{return JSON.parse(raw.toString('utf8'));}catch{throw fail('GB10 配乐返回格式无效',502);}
}
async function manifest(context={}){
 const value=context.musicManifest||JSON.parse(await readFile(join(ROOT,'deployment/music-model.json'),'utf8'));
 if(!/^[\w.-]+\.safetensors$/.test(value.fileName)||!/^[a-f0-9]{64}$/i.test(value.sha256))throw fail('配乐模型登记无效',503);
 return clone(value);
}
export async function getMusicCapability(context={}){
 try{
  const model=await manifest(context),nodes=await Promise.all(REQUIRED.map(name=>remoteJson('/object_info/'+name,context)));
  if(nodes.some((entry,index)=>!entry[REQUIRED[index]]))throw fail('GB10 缺少 ACE-Step 配乐核心节点',503);
  const combo=nodes[0].CheckpointLoaderSimple.input?.required?.ckpt_name,options=Array.isArray(combo?.[0])?combo[0]:combo?.[1]?.options;
  if(!options?.includes(model.fileName))throw fail('ACE-Step 配乐权重仍在准备中',503);
  return {available:true,ready:true,model:{id:model.id,name:model.name,fileName:model.fileName,sha256:model.sha256,bytes:model.bytes,revision:model.revision,license:model.license,engine:'ComfyUI',verified:model.deployedSha256===model.sha256,verifiedAt:model.verifiedAt||null},message:'GB10 纯配乐已就绪；使用 ACE-Step 1.5 Turbo 原生音乐流程。'};
 }catch(error){return {available:false,ready:false,model:null,message:error.message,reason:error.message};}
}
export function validateMusicRequest(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['workId','name','prompt','duration','bpm','seed'].includes(key)))throw fail('配乐请求字段无效');
 const workId=identify(body.workId),name=typeof body.name==='string'?body.name.trim():'',prompt=typeof body.prompt==='string'?body.prompt.trim():'';
 if(!name||name.length>120)throw fail('配乐名称须为 1–120 字');if(!prompt||prompt.length>5000)throw fail('请填写 1–5000 字的配乐描述');
 if(typeof body.duration!=='number'||!Number.isFinite(body.duration)||body.duration<10||body.duration>120)throw fail('配乐时长须为 10–120 秒');
 const bpm=body.bpm??90,seed=body.seed??Math.floor(Math.random()*0x100000000);
 if(!Number.isInteger(bpm)||bpm<10||bpm>300)throw fail('BPM 须为 10–300 的整数');if(!Number.isSafeInteger(seed)||seed<0)throw fail('随机种子须为非负安全整数');
 return {workId,name,prompt,duration:body.duration,bpm,seed};
}
export function buildMusicWorkflow(request,model,prefix){
 const value=validateMusicRequest(request);
 if(!model||!/^[\w.-]+\.safetensors$/.test(model.fileName)||typeof prefix!=='string'||prefix!==`rack-music/${value.workId}/${prefix.split('/').at(-1)}`||!UUID.test(prefix.split('/').at(-1)||''))throw fail('配乐模型或输出目录无效');
 return {
  '1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:model.fileName}},
  '2':{class_type:'TextEncodeAceStepAudio1.5',inputs:{clip:['1',1],tags:'Instrumental soundtrack, no vocals, no singing, no speech. '+value.prompt,lyrics:'[instrumental]',seed:value.seed,bpm:value.bpm,duration:value.duration,timesignature:'4',language:'zh',keyscale:'C major',generate_audio_codes:false,cfg_scale:2,temperature:.85,top_p:.9,top_k:0,min_p:0}},
  '3':{class_type:'ModelSamplingAuraFlow',inputs:{model:['1',0],shift:3}},
  '4':{class_type:'ConditioningZeroOut',inputs:{conditioning:['2',0]}},
  '5':{class_type:'EmptyAceStep1.5LatentAudio',inputs:{seconds:value.duration,batch_size:1}},
  '6':{class_type:'KSampler',inputs:{model:['3',0],seed:value.seed,steps:8,cfg:1,sampler_name:'euler',scheduler:'simple',positive:['2',0],negative:['4',0],latent_image:['5',0],denoise:1}},
  '7':{class_type:'VAEDecodeAudio',inputs:{samples:['6',0],vae:['1',2]}},
  '8':{class_type:'SaveAudio',inputs:{audio:['7',0],filename_prefix:prefix+'/audio'}},
 };
}
async function getStore(context){
 const key=resolve(context.dataDir);if(stores.has(key)){const store=await stores.get(key);store.context={...store.context,...context};return store;}
 const operation=(async()=>{
  const base=join(key,'music');await mkdir(join(base,'jobs'),{recursive:true});const canonical=await realpath(base);inside(await realpath(key),canonical);
  let saved;try{saved=JSON.parse(await readFile(join(canonical,'catalog.json'),'utf8'));if(!Array.isArray(saved.jobs))throw fail('本机配乐索引格式无效',500);}catch(error){if(error.code!=='ENOENT')throw error;saved={schemaVersion:1,jobs:[]};}
  const store={base:canonical,context,jobs:saved.jobs,writes:Promise.resolve(),importing:new Set()};
  let recovered=false;for(const job of store.jobs){identify(job.id);if(ACTIVE.has(job.status)){job.status='interrupted';job.finishedAt=now();job.message='本机服务已重启，请核对远端任务；已提交的 GPU 任务可能仍在执行。';recovered=true;}}
  if(recovered)await persist(store);return store;
 })();stores.set(key,operation);try{return await operation;}catch(error){stores.delete(key);throw error;}
}
async function persist(store){
 const snapshot=clone(store.jobs);
 const operation=store.writes.catch(()=>{}).then(async()=>{
  const temporary=join(store.base,'catalog-'+randomUUID()+'.tmp');await writeFile(temporary,JSON.stringify({schemaVersion:1,jobs:snapshot},null,2));await rename(temporary,join(store.base,'catalog.json'));
  for(const job of snapshot){const directory=join(store.base,'jobs',identify(job.id));await mkdir(directory,{recursive:true});inside(store.base,await realpath(directory));const temp=join(directory,randomUUID()+'.tmp');await writeFile(temp,JSON.stringify(job,null,2));await rename(temp,join(directory,'job.json'));}
 });store.writes=operation;return operation;
}
async function update(store,job,changes){Object.assign(job,changes);await persist(store);}
export async function getActiveMusicJobs({dataDir}){const store=await getStore({dataDir});await store.writes;return store.jobs.filter(job=>ACTIVE.has(job.status)).length+[...store.importing].filter(id=>!ACTIVE.has(store.jobs.find(job=>job.id===id)?.status)).length;}
function run(executable,args,timeout=60000){return new Promise((resolveResult,reject)=>{
 const child=spawn(executable,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',finished=false;
 const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolveResult(stdout);};const timer=setTimeout(()=>{child.kill();finish(fail('本机配乐转换或检查超时',504));},timeout);
 child.stdout.on('data',data=>{stdout+=data;if(stdout.length>512*1024){child.kill();finish(fail('配乐探测结果超过限制',502));}});child.stderr.on('data',data=>stderr=(stderr+data).slice(-1500));child.on('error',finish);child.on('close',code=>finish(code===0?null:fail('配乐媒体处理失败：'+stderr,502)));
});}
function executable(context,name){return process.platform==='win32'?join(context.dataDir,'toonflow/ffmpeg/win32-x64',name+'.exe'):name;}
async function decodeAudio(file,target,context){
 if(context.decodeAudio)return context.decodeAudio(file,target);
 await run(executable(context,'ffmpeg'),['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-i',file,'-map','0:a:0','-vn','-c:a','pcm_s16le',target]);
}
export function parseMusicProbe(value,requestedDuration){
 const audio=value.streams?.find(stream=>stream.codec_type==='audio'),duration=Number(audio?.duration??value.format?.duration),sampleRate=Number(audio?.sample_rate),channels=Number(audio?.channels);
 if(!audio||value.streams.some(stream=>stream.codec_type==='video')||!Number.isFinite(duration)||duration<=0||Math.abs(duration-requestedDuration)>.25||!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000||!Number.isInteger(channels)||channels<1||channels>8)throw fail('配乐未通过真实时长、采样率或声道校验',502);
 return {duration,sampleRate,channels,audioCodec:audio.codec_name||null};
}
async function probeAudio(file,duration,context){
 const value=context.probeAudio?await context.probeAudio(file):JSON.parse(await run(executable(context,'ffprobe'),['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file]));
 return parseMusicProbe(value,duration);
}
async function sha256(file){const value=createHash('sha256');for await(const chunk of createReadStream(file))value.update(chunk);return value.digest('hex');}
async function downloadAudio(file,target,job,context){
 if(file?.type!=='output'||file.subfolder!==`rack-music/${job.workId}/${job.id}`||typeof file.filename!=='string'||!/^[-\w.]+\.flac$/.test(file.filename))throw fail('GB10 配乐输出目录与任务不一致',502);
 const response=await (context.fetcher||context.fetch||fetch)(BASE+'/view?'+new URLSearchParams({filename:file.filename,subfolder:file.subfolder,type:'output'}),{redirect:'error',signal:AbortSignal.timeout(120000)});
 if(!response.ok)throw fail('回传配乐失败：HTTP '+response.status,502);const content=await bytes(response,128*1024*1024);
 if(content.length<16||content.subarray(0,4).toString('ascii')!=='fLaC')throw fail('GB10 配乐文件并非有效 FLAC',502);
 await writeFile(target,content,{flag:'wx'});return {bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')};
}
function publicJob(job){return {...clone(job),...(job.status==='succeeded'?{audioUrl:`/api/music/jobs/${job.id}/audio`}:{})};}
async function execute(store,job,queuedMono){
 const context=store.context,started=performance.now();
 try{
  await update(store,job,{status:'running',phase:'checking-model',message:'正在连接 GB10 配乐模型',startedAt:now(),telemetry:{...job.telemetry,queueMs:started-queuedMono}});
  const capability=await getMusicCapability(context);if(!capability.available)throw fail(capability.reason||capability.message,503);
  const model=await manifest(context),workflow=buildMusicWorkflow(job.request,model,`rack-music/${job.workId}/${job.id}`);job.modelSnapshot=clone(model);job.workflow=workflow;await persist(store);
  const submitted=await remoteJson('/prompt',context,{body:{prompt:workflow,client_id:'rack-studio-music'}});identify(submitted.prompt_id);
  await update(store,job,{promptId:submitted.prompt_id,phase:'generating',message:'GB10 正在生成纯配乐'});
  const deadline=Date.now()+(context.waitTimeoutMs??30*60*1000);let history;
  while(Date.now()<deadline){
   const result=await remoteJson('/history/'+job.promptId,context);history=result[job.promptId];
   if(history?.status?.status_str==='error')throw fail('GB10 配乐执行失败：'+JSON.stringify(history.status.messages).slice(0,1200),502);
   if(history?.status?.completed)break;
   await new Promise(resolveWait=>setTimeout(resolveWait,context.pollIntervalMs??2000));
  }
  if(!history?.status?.completed)throw fail('配乐等待超时；远端任务编号 '+job.promptId,504);
  if(JSON.stringify(history.prompt?.[2])!==JSON.stringify(workflow))throw fail('配乐工作流与原始提交快照不一致',502);
  const output=Object.values(history.outputs?.['8']||{}).flat().find(item=>typeof item?.filename==='string'&&item.filename.endsWith('.flac'));if(!output)throw fail('GB10 配乐任务未返回音频',502);
  const directory=join(store.base,'jobs',job.id);await mkdir(directory,{recursive:true});inside(store.base,await realpath(directory));
  await update(store,job,{phase:'returning',message:'正在回传配乐并保存 WAV'});
  const remoteOutput=await downloadAudio(output,join(directory,'source.flac'),job,context),file=join(directory,'audio.wav');await decodeAudio(join(directory,'source.flac'),file,context);
  if((await stat(file)).size>128*1024*1024)throw fail('本机配乐 WAV 超过 128 MB 限制',502);
  const header=await readFile(file);if(header.length<44||header.subarray(0,4).toString('ascii')!=='RIFF'||header.subarray(8,12).toString('ascii')!=='WAVE')throw fail('本机配乐并非有效 WAV',502);
  const measured=await probeAudio(file,job.request.duration,context),events=history.status.messages||[],serverStart=events.find(entry=>entry[0]==='execution_start')?.[1]?.timestamp,serverEnd=events.find(entry=>entry[0]==='execution_success')?.[1]?.timestamp;
  const productionMs=performance.now()-started,outputReadyAt=now(),telemetry={...job.telemetry,source:'measured',productionMs,serverExecutionMs:Number.isFinite(serverStart)&&Number.isFinite(serverEnd)&&serverEnd>=serverStart?serverEnd-serverStart:null,serverStartedAt:Number.isFinite(serverStart)?new Date(serverStart).toISOString():null,serverFinishedAt:Number.isFinite(serverEnd)?new Date(serverEnd).toISOString():null,output:{...measured,bytes:header.length,sha256:await sha256(file)},remoteOutput:{...remoteOutput,file:output},rates:{audioSecondsPerMinute:measured.duration*60000/productionMs,secondsPerAudioSecond:productionMs/1000/measured.duration}};
  await update(store,job,{outputReadyAt,telemetry,phase:'registering',message:'正在归档到作品音乐库'});
  let registeredAudio,registrationError=null;
  if(context.persistAudio)try{registeredAudio=await context.persistAudio({workId:job.workId,file,mimeType:'audio/wav',name:job.name,job:clone(job),category:'music'});}catch(error){registrationError=error.message;}
  await update(store,job,{status:'succeeded',phase:'complete',message:registrationError?'配乐已生成，可试听；作品归档未完成，可重试导入':'配乐已保存，可试听或加入时间轴',registrationError,finishedAt:now(),telemetry:{...telemetry,totalMs:performance.now()-queuedMono},...(registeredAudio===undefined?{}:{registeredAudio:clone(registeredAudio),media:clone(registeredAudio?.media||registeredAudio)})});
 }catch(error){await update(store,job,{status:'failed',phase:'failed',error:error.message,message:error.message,finishedAt:now(),telemetry:{...job.telemetry,productionMs:job.telemetry.productionMs??performance.now()-started,totalMs:performance.now()-queuedMono}}).catch(()=>{});}
}
async function readBody(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32*1024)throw fail('配乐请求内容过大',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('配乐请求 JSON 无效');}}
async function serveAudio(req,res,store,job){
 if(job.status!=='succeeded')throw fail('配乐尚未完成',404);const file=await realpath(join(store.base,'jobs',identify(job.id),'audio.wav'));inside(store.base,file);const info=await stat(file);if(!info.isFile())throw fail('未找到配乐文件',404);
 let start=0,end=info.size-1,status=200;const range=req.headers.range;
 if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||!match[1]&&!match[2]){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}
  if(!match[1]){const tail=Number(match[2]);if(!Number.isSafeInteger(tail)||tail<1){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}start=Math.max(0,info.size-tail);}else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}status=206;
 }
 res.writeHead(status,{'Content-Type':'audio/wav','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, no-cache',...(status===206?{'Content-Range':`bytes ${start}-${end}/${info.size}`}:{})});
 if(req.method==='HEAD'){res.end();return;}const stream=createReadStream(file,{start,end});stream.on('error',error=>res.destroy(error));res.on('close',()=>stream.destroy());stream.pipe(res);
}
export async function handleCreativeMusic(req,res,url,context){
 if(!url.pathname.startsWith('/api/music/'))return false;
 try{
  if(url.pathname==='/api/music/capability'&&['GET','HEAD'].includes(req.method)){json(req,res,200,await getMusicCapability(context));return true;}
  const store=await getStore(context);await store.writes;
  if(url.pathname==='/api/music/generate'&&req.method==='POST'){
   const request=validateMusicRequest(await readBody(req)),catalog=JSON.parse(await readFile(join(context.dataDir,'works/catalog.json'),'utf8'));
   if(!catalog.works?.some(work=>work.id===request.workId))throw fail('作品不存在',404);
   if(store.jobs.some(job=>job.workId===request.workId&&ACTIVE.has(job.status)))throw fail('本作品已有进行中的配乐任务',409);
   if(store.jobs.filter(job=>ACTIVE.has(job.status)).length>=8)throw fail('配乐队列已满，请稍后再试',429);
   const queuedMono=performance.now(),model=await manifest(context),job={id:randomUUID(),workId:request.workId,name:request.name,request,modelSnapshot:model,status:'queued',phase:'queued',message:'已加入本机配乐队列',createdAt:now(),telemetry:{version:1,source:'measured',queueMs:null,productionMs:null,totalMs:null,serverExecutionMs:null,output:null}};
   if(store.jobs.some(item=>item.workId===request.workId&&ACTIVE.has(item.status)))throw fail('本作品已有进行中的配乐任务',409);
   store.jobs.push(job);await persist(store);json(req,res,202,{job:publicJob(job)});
   void withGpuLease(()=>execute(store,job,queuedMono)).catch(async error=>{await update(store,job,{status:'failed',error:error.message,message:error.message,finishedAt:now()}).catch(()=>{});});return true;
  }
  if(url.pathname==='/api/music/jobs'&&['GET','HEAD'].includes(req.method)){const workId=url.searchParams.get('workId');if(workId)identify(workId);json(req,res,200,{jobs:store.jobs.filter(job=>!workId||job.workId===workId).map(publicJob).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});return true;}
  const importMatch=/^\/api\/music\/jobs\/([^/]+)\/import$/.exec(url.pathname);
  if(importMatch&&req.method==='POST'){
   const id=identify(importMatch[1]),job=store.jobs.find(item=>item.id===id);if(!job)throw fail('配乐任务不存在',404);if(job.status!=='succeeded')throw fail('请先完成配乐生成',409);
   if(job.media){json(req,res,200,{job:publicJob(job)});return true;}if(typeof context.persistAudio!=='function')throw fail('作品归档接口尚未就绪',503);if(store.importing.has(id))throw fail('该配乐正在导入作品',409);
   store.importing.add(id);
   try{
    const file=await realpath(join(store.base,'jobs',id,'audio.wav'));inside(store.base,file);if(await sha256(file)!==job.telemetry.output.sha256)throw fail('配乐文件内容已改变，保留原始生产记录，请先核对文件',409);
    const registeredAudio=await context.persistAudio({workId:job.workId,file,mimeType:'audio/wav',name:job.name,job:clone(job),category:'music'});
    await update(store,job,{registeredAudio:clone(registeredAudio),media:clone(registeredAudio?.media||registeredAudio),registrationError:null,message:'配乐已导入作品音乐库'});json(req,res,200,{job:publicJob(job)});
   }catch(error){await update(store,job,{registrationError:error.message}).catch(()=>{});throw error;}finally{store.importing.delete(id);}return true;
  }
  const match=/^\/api\/music\/jobs\/([^/]+)\/audio$/.exec(url.pathname);
  if(match&&['GET','HEAD'].includes(req.method)){const id=identify(match[1]),job=store.jobs.find(item=>item.id===id);if(!job)throw fail('配乐任务不存在',404);await serveAudio(req,res,store,job);return true;}
  throw fail('未找到配乐接口',404);
 }catch(error){if(!res.headersSent)json(req,res,error.status||(error.code==='ENOENT'?404:500),{error:error.message});else res.destroy(error);return true;}
}
