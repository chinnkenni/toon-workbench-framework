import {readFile,writeFile,mkdir,rename,stat,lstat,realpath,unlink} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {ASR_LIMITS,asrSha256,getWhisperCapability,probeAsrSource,runWhisperAsr} from './asr-runtime.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,stores=new Map(),ACTIVE=new Set(['queued','running']);
const now=()=>new Date().toISOString(),clone=value=>structuredClone(value),object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const asrLimitations=['自动转写可能漏字、错字或产生幻听；不匹配须结合原音试听，不直接证明模型没有说出。','分段时码来自识别模型，不是逐字精确对齐，也不检测说话人、声龄、情绪或口型。','期望台词仅在识别后比对，从不作为 initial prompt 或写回作品台词。'];
function id(value){if(typeof value!=='string'||!UUID.test(value))throw fail('作品、素材或转写任务编号无效');return value.toLowerCase();}
function inside(base,target,allowSame=false){const part=relative(base,target);if((!part&&!allowSame)||part.startsWith('..')||isAbsolute(part))throw fail('转写文件路径越界',403);return target;}
async function safePath(root,target,{directory=false,create=false}={}){
 inside(root,target);let current=root;for(const part of relative(root,target).split(/[\\/]/)){
  current=join(current,part);let info;try{info=await lstat(current);}catch(error){if(error.code!=='ENOENT'||!create)throw error;await mkdir(current);info=await lstat(current);}
  if(info.isSymbolicLink())throw fail('转写路径不接受符号链接或目录联接',403);
  if(current!==target&&!info.isDirectory())throw fail('转写路径祖先不是目录',403);
 }
 const canonical=await realpath(target);inside(root,canonical);const info=await stat(canonical);if(directory?!info.isDirectory():!info.isFile())throw fail('转写路径类型无效',403);return canonical;
}
async function boundedJson(file,max=32*1024*1024){const info=await stat(file);if(!info.isFile()||info.size>max)throw fail('转写索引或结果超过限制',500);return JSON.parse(await readFile(file,'utf8'));}
async function atomicJson(root,file,value){inside(root,file);const body=JSON.stringify(value,null,2);if(Buffer.byteLength(body)>32*1024*1024)throw fail('转写记录超过限制',500);await safePath(root,dirname(file),{directory:true});try{await safePath(root,file);}catch(error){if(error.code!=='ENOENT')throw error;}const temporary=file+'.'+randomUUID()+'.tmp';try{await writeFile(temporary,body,{flag:'wx',mode:0o600});await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}}
function serial(store,fn){const pending=store.writes.then(fn);store.writes=pending.catch(()=>{});return pending;}
async function persist(store,job){
 if(job)await atomicJson(store.root,join(store.base,'jobs',job.id+'.json'),job);
 await atomicJson(store.root,join(store.base,'catalog.json'),{schemaVersion:1,jobs:store.jobs});
}
async function getStore(context){
 const key=resolve(context.dataDir);if(stores.has(key)){const store=await stores.get(key);store.context={...store.context,...context};return store;}
 const pending=(async()=>{
  const root=await realpath(key),base=await safePath(root,join(root,'asr'),{directory:true,create:true});
  await safePath(root,join(base,'jobs'),{directory:true,create:true});await safePath(root,join(base,'outputs'),{directory:true,create:true});
  let catalog;try{const file=await safePath(root,join(base,'catalog.json'));catalog=await boundedJson(file);if(!object(catalog)||!Array.isArray(catalog.jobs)||catalog.jobs.length>10000)throw fail('转写索引无效',500);}catch(error){if(error.code!=='ENOENT')throw error;catalog={schemaVersion:1,jobs:[]};}
  const store={root,base,jobs:catalog.jobs,context,writes:Promise.resolve(),running:false,pending:0};
  for(const job of store.jobs){id(job.id);id(job.workId);if(ACTIVE.has(job.status)){job.status='interrupted';job.finishedAt=now();job.error='本机服务重启，转写任务已中断；不会自动重投。';job.message=job.error;await persist(store,job);}}
  return store;
 })();stores.set(key,pending);try{return await pending;}catch(error){stores.delete(key);throw error;}
}
export async function getAsrCapability(context={}){const capability=context.getAsrCapability?await context.getAsrCapability(context):await getWhisperCapability(context);const {_paths,...safe}=capability;return safe;}
export async function getActiveAsrJobs(context){const store=await getStore(context);await store.writes;return store.jobs.filter(job=>ACTIVE.has(job.status)).length+store.pending;}
export function validateAsrRequest(body){
 if(!object(body)||Object.keys(body).some(key=>!['workId','source','expectedLines'].includes(key)))throw fail('转写请求字段无效');
 const workId=id(body.workId),source=body.source;
 if(!object(source)||Object.keys(source).some(key=>!['kind','id'].includes(key))||!['asset','media','export'].includes(source.kind))throw fail('请选择本作品已登记的音视频或成功导出');
 const expected=body.expectedLines??[];if(!Array.isArray(expected)||expected.length>ASR_LIMITS.expectedLines)throw fail('期望台词数量超过限制');
 let total=0;const seen=new Set();const expectedLines=expected.map((line,index)=>{
  if(!object(line)||Object.keys(line).some(key=>!['id','text'].includes(key))||typeof line.text!=='string'||!line.text.trim()||line.text.length>2000)throw fail('期望台词格式无效');
  const key=line.id??String(index+1);if(typeof key!=='string'||!key||key.length>120||seen.has(key))throw fail('期望台词编号无效或重复');seen.add(key);total+=line.text.length;return {id:key,text:line.text};
 });if(total>24000)throw fail('期望台词总长超过限制');return {workId,source:{kind:source.kind,id:id(source.id)},expectedLines};
}
export function compareAsrTranscript(transcript,expectedLines=[]){
 const text=typeof transcript?.text==='string'?transcript.text:'';
 const normalized=value=>value.replace(/[\p{White_Space}\p{P}]/gu,'');
 const actual=normalized(text),expected=expectedLines.map(line=>line.text).join('');
 return {method:'literal-and-whitespace-punctuation-only',exactTranscriptMatch:expectedLines.length?text===expected:null,normalizedTranscriptMatch:expectedLines.length?actual===normalized(expected):null,lines:expectedLines.map(line=>({...line,rawExact:text.includes(line.text),normalized:normalized(line.text)?actual.includes(normalized(line.text)):null})),warning:asrLimitations[0]};
}
async function resolveSource(store,request){
 const catalogPath=await safePath(store.root,join(store.root,'works/catalog.json')),catalog=await boundedJson(catalogPath),work=catalog.works?.find(entry=>entry.id?.toLowerCase()===request.workId);if(!work)throw fail('作品不存在',404);
 const workspace=join(store.root,'toonflow/workspaces','works-'+request.workId);
 if(work.workspacePath&&resolve(work.workspacePath)!==resolve(workspace))throw fail('作品工作区登记无效',403);
 const {kind,id:sourceId}=request.source,source=(kind==='asset'?work.assets:kind==='media'?work.studio?.media:work.studio?.exports)?.find(entry=>entry.id?.toLowerCase()===sourceId);
 if(!source||kind==='export'&&source.status!=='succeeded')throw fail('音视频不属于该作品，或导出未成功',404);
 const path=source.relativePath;
 const allowed=kind==='asset'?/^assets\/generated\/video[0-9a-f-]{36}\.mp4$/i:kind==='export'?new RegExp('^exports/export'+sourceId+'\\.mp4$','i'):new RegExp('^assets/imported/'+sourceId+'\\.(wav|mp3|m4a|flac|ogg|aac|mp4)$','i');
 if(typeof path!=='string'||!allowed.test(path)||kind!=='export'&&!['audio','video'].includes(source.type))throw fail('转写源登记不是有效音视频路径',403);
 const canonicalWorkspace=await safePath(store.root,workspace,{directory:true}),sourcePath=await safePath(store.root,join(canonicalWorkspace,path));inside(canonicalWorkspace,sourcePath);
 const info=await stat(sourcePath);if(info.size<=0||info.size>ASR_LIMITS.sourceBytes)throw fail('转写源大小超过限制',413);
 const probe=await probeAsrSource(sourcePath,store.context),sha256=await asrSha256(sourcePath),after=await stat(sourcePath);
 if(info.size!==after.size||info.mtimeMs!==after.mtimeMs||info.ctimeMs!==after.ctimeMs)throw fail('校验过程中音视频发生变化',409);
 return {sourcePath,snapshot:{...request.source,workId:work.id,workTitle:work.title??null,name:source.name||source.title||source.filename||sourceId,relativePath:path,bytes:info.size,sha256,probe,selectedAt:now(),selectionSnapshot:clone(source)}};
}
function publicJob(job){return clone(job);}
async function drain(store){
 if(store.running)return;store.running=true;
 try{
  for(;;){let job;await serial(store,async()=>{job=store.jobs.find(entry=>entry.status==='queued');if(job){job.status='running';job.startedAt=now();job.message='正在本机 CPU 提取音轨并转写';await persist(store,job);}});if(!job)break;
   const started=performance.now();try{
    const source=await resolveSource(store,job.request);if(source.snapshot.sha256!==job.sourceSnapshot.sha256)throw fail('排队后的源文件已变化；未转写新内容',409);
    const outputDir=await safePath(store.root,join(store.base,'outputs',job.id),{directory:true,create:true});
    const result=await (store.context.runAsr||runWhisperAsr)({sourcePath:source.sourcePath,outputDir,request:clone(job.request),sourceSnapshot:clone(job.sourceSnapshot),context:store.context,capability:clone(job.capabilitySnapshot),onProgress:async value=>serial(store,async()=>{job.executionSnapshot=clone(value.execution);job.audio=clone(value.audio??null);await persist(store,job);})});
    if(!object(result)||!object(result.transcript)||typeof result.transcript.text!=='string'||!Array.isArray(result.transcript.segments)||Buffer.byteLength(JSON.stringify(result))>ASR_LIMITS.resultBytes)throw fail('转写运行结果无效或过大',502);
    const record={jobId:job.id,workId:job.workId,source:clone(job.sourceSnapshot),audio:clone(result.audio??null),execution:clone(result.execution??null),transcript:clone(result.transcript),comparison:compareAsrTranscript(result.transcript,job.request.expectedLines),limitations:asrLimitations};
    const relativePath='outputs/'+job.id+'/result.json';await atomicJson(store.root,join(store.base,relativePath),record);
    const finishedAt=now();await serial(store,async()=>{Object.assign(job,{status:'succeeded',finishedAt,message:'转写已完成；台词与声音效果仍须结合原音判断',audio:record.audio,executionSnapshot:record.execution,result:{relativePath,sha256:await asrSha256(join(store.base,relativePath)),text:record.transcript.text,segments:record.transcript.segments,comparison:record.comparison},telemetry:{queueMs:Date.parse(job.startedAt)-Date.parse(job.createdAt),productionMs:performance.now()-started,totalMs:Date.parse(finishedAt)-Date.parse(job.createdAt),source:'local-cpu-asr'}});await persist(store,job);});
   }catch(error){await serial(store,async()=>{job.status='failed';job.finishedAt=now();job.error=String(error.message||'转写失败').slice(0,2000);job.message=job.error;job.executionSnapshot=clone(error.asrExecution??{engine:job.capabilitySnapshot.engine,device:'cpu',model:job.capabilitySnapshot.model,runtime:job.capabilitySnapshot.runtime,args:null,initialPrompt:null,startedAt:job.startedAt,finishedAt:job.finishedAt,inferenceStartedAt:null});job.audio=clone(error.asrAudio??null);job.telemetry={queueMs:Date.parse(job.startedAt)-Date.parse(job.createdAt),productionMs:performance.now()-started,totalMs:Date.parse(job.finishedAt)-Date.parse(job.createdAt),source:'local-cpu-asr'};await persist(store,job);});}
  }
 }finally{store.running=false;}
}
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>64*1024)throw fail('转写请求超过 64 KB',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw fail('转写请求必须是 JSON');}}
function json(req,res,status,value,headers={}){const data=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-store',...headers});res.end(req.method==='HEAD'?undefined:data);}
function query(url,allowed){for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw fail('转写查询参数无效');}
export async function handleAsr(req,res,url,context){
 if(url.pathname!=='/api/asr'&&!url.pathname.startsWith('/api/asr/'))return false;
 try{
  if(url.pathname==='/api/asr/capability'){if(!['GET','HEAD'].includes(req.method))throw fail('该路径只支持读取',405);query(url,[]);json(req,res,200,await getAsrCapability(context));return true;}
  const store=await getStore(context);
  if(url.pathname==='/api/asr/transcribe'&&req.method==='POST'){
   query(url,[]);const request=validateAsrRequest(await body(req));store.pending++;
   try{const capability=await getAsrCapability(store.context);if(!capability.ready)throw fail(capability.message||'本机转写尚未就绪',503);const source=await resolveSource(store,request);
    const job={id:randomUUID(),workId:request.workId,kind:'transcription',status:'queued',createdAt:now(),startedAt:null,finishedAt:null,request,sourceSnapshot:source.snapshot,capabilitySnapshot:capability,executionSnapshot:null,telemetry:null,result:null,error:null,message:'已加入本机 CPU 转写队列'};
    await serial(store,async()=>{if(store.jobs.filter(entry=>ACTIVE.has(entry.status)).length>=20)throw fail('本机转写队列已满',429);if(store.jobs.length>=10000)throw fail('转写历史达到限制，请保留并迁移归档',409);store.jobs.push(job);try{await persist(store,job);}catch(error){store.jobs=store.jobs.filter(entry=>entry.id!==job.id);throw error;}});
    json(req,res,202,{job:publicJob(job)});void drain(store).catch(error=>{store.lastError=String(error.message).slice(0,2000);});
   }finally{store.pending--;}return true;
  }
  if(url.pathname==='/api/asr/jobs'&&['GET','HEAD'].includes(req.method)){query(url,['workId']);const workId=id(url.searchParams.get('workId'));await store.writes;json(req,res,200,{jobs:store.jobs.filter(job=>job.workId===workId).slice().reverse().map(publicJob)});return true;}
  const match=/^\/api\/asr\/jobs\/([^/]+)(\/result)?$/.exec(url.pathname);
  if(match&&['GET','HEAD'].includes(req.method)){
   query(url,match[2]?['download']:[]);const jobId=id(match[1]);await store.writes;const job=store.jobs.find(entry=>entry.id===jobId);if(!job)throw fail('转写任务不存在',404);
   if(!match[2]){json(req,res,200,{job:publicJob(job)});return true;}
   const download=url.searchParams.get('download');if(download!==null&&download!=='1')throw fail('转写下载参数无效');if(job.status!=='succeeded'||job.result?.relativePath!==`outputs/${job.id}/result.json`)throw fail('转写结果尚未就绪',409);
   const file=await safePath(store.root,join(store.base,job.result.relativePath));if(await asrSha256(file)!==job.result.sha256)throw fail('转写结果 SHA256 已变化',409);json(req,res,200,await boundedJson(file,ASR_LIMITS.resultBytes),download?{'Content-Disposition':`attachment; filename="asr-${job.id}.json"`}:{});return true;
  }
  throw fail('转写路径或方法无效',req.method==='POST'||['GET','HEAD'].includes(req.method)?404:405);
 }catch(error){json(req,res,error.status||500,{error:error.code==='ENOENT'?'本机登记文件不存在':error.message});return true;}
}
