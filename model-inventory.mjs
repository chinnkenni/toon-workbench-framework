import {readFrameworkGpuConfig} from './framework-config.mjs';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {readLocalCpuModel,localCpuEvidence} from './local-model-inventory.mjs';

const GB10=readFrameworkGpuConfig({required:false})||{host:null,user:null,port:22},SHA=/^[a-f0-9]{64}$/i;
const array=value=>Array.isArray(value)?value:[],clone=value=>structuredClone(value);
const stamp=value=>{if(value===null||value===undefined||value==='')return null;const date=new Date(typeof value==='number'?value*1000:value);return Number.isFinite(date.getTime())?date.toISOString():null;};
const loaders={UNETLoader:['diffusion_models','视频/扩散权重'],CLIPLoader:['text_encoders','文本编码器'],DualCLIPLoader:['text_encoders','文本编码器'],VAELoader:['vae','画面/声音解码器'],CheckpointLoaderSimple:['checkpoints','完整模型'],UpscaleModelLoader:['upscale_models','图像/视频超分'],LoraLoader:['loras','风格/角色 LoRA'],ControlNetLoader:['controlnet','结构控制'],CLIPVisionLoader:['clip_vision','视觉编码器'],StyleModelLoader:['style_models','风格模型']};
async function readJson(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function relativeModelPath(value){return typeof value==='string'&&!value.startsWith('/')&&!value.includes('\\')&&!value.split('/').some(part=>part==='..'||part==='.')&&value.length<500?value:null;}

/** Discover pinned metadata without executing download scripts or trusting it as installation evidence. */
export async function readModelRegistry(rootDir){
 const models=[],errors=[],directory=join(rootDir,'deployment');
 try{
  const source=await readFile(join(directory,'download-models.py'),'utf8'),revision=source.match(/^REVISION\s*=\s*['"]([a-f0-9]+)['"]/m)?.[1];
  const files=[...source.matchAll(/\(\s*['"]([^'"]+\.safetensors)['"]\s*,\s*(\d+)\s*,\s*['"]([a-f0-9]{64})['"]\s*\)/g)].map(([,path,bytes,sha256])=>({path,bytes:Number(bytes),sha256}));
  if(files.length)models.push({id:'minimax-h3',name:'MiniMax H3',category:'video',purpose:'文生视频 / 首帧图生视频 / 同步声音',engine:'ComfyUI',version:'0.30.0',revision,repository:'Comfy-Org/MiniMax-H3',sourceUrl:'https://huggingface.co/Comfy-Org/MiniMax-H3',metadataSource:'deployment/download-models.py',files,binding:GB10});
 }catch(error){if(error.code!=='ENOENT')errors.push({source:'download-models.py',error:error.message});}
 for(const filename of (await readdir(directory)).filter(name=>/-(?:model|manifest)\.json$/.test(name)).sort())try{
  const value=await readJson(join(directory,filename));if(!value)continue;
  if(value.executionHost==='windows-local'){
   const model=value.model,runtime=value.runtime,validFile=file=>relativeModelPath(file?.path)&&Number(file.bytes)>0&&SHA.test(file.sha256||'');
   if(value.device!=='cpu'||value.id!=='whisper-small-cpu'||runtime?.engine!=='whisper.cpp'||!validFile(model)||!relativeModelPath(runtime.executablePath)||!SHA.test(runtime.sha256||'')||!Array.isArray(runtime.files)||!runtime.files.length||runtime.files.length>64||!runtime.files.every(validFile)||!relativeModelPath(value.receiptPath)||typeof model.revision!=='string'||!model.revision)throw new Error('本机 CPU ASR 固定清单格式无效');
   models.push({id:value.id,name:value.name||'Whisper Small 多语（Windows CPU）',category:'asr',kind:'speech-recognition',purpose:'已登记媒体台词转写校验（Windows 本机 CPU）',executionHost:'windows-local',device:'cpu',engine:'whisper.cpp',version:runtime.version||null,revision:model.revision,repository:model.repository||null,sourceUrl:model.sourceUrl||null,license:value.license||null,metadataSource:'deployment/'+filename,files:[{path:model.path,bytes:model.bytes,sha256:model.sha256}],runtime,receiptPath:value.receiptPath,binding:{host:'127.0.0.1',name:'本机 Windows',device:'cpu'},verifiedAt:value.verifiedAt||null});
   continue;
  }
  const nested=value.model&&typeof value.model==='object'?value.model:null,isTts=/^tts-/.test(filename);
  let files=array(nested?.files||value.files).filter(item=>relativeModelPath(item.path)&&Number(item.bytes)>0).map(item=>({path:item.path,bytes:Number(item.bytes),sha256:item.sha256}));
  if(!files.length&&value.fileName&&Number(value.bytes)>0){const prefix=value.hostModelPath?.split('/h3-data/models/')[1];files=[{path:relativeModelPath(prefix||value.fileName),bytes:Number(value.bytes),sha256:value.sha256}].filter(item=>item.path);}
  if(!files.length)continue;
  const category=isTts?'tts':filename==='music-model.json'?'music':filename==='upscale-model.json'?'upscale':value.category||'other';
  models.push({id:value.id||nested?.id||filename.replace(/\.json$/,''),name:value.name||nested?.id||filename,category,kind:value.kind||null,directory:isTts&&/^[a-z0-9-]+$/.test(value.directory||'model')?value.directory||'model':null,purpose:value.purpose||(value.kind==='voice-design'?'按人物性格设计声线':value.kind==='reference-voice'?'复用设计声线生成台词':{tts:'角色对白 / 预置音色 / 情绪指导',music:'纯配乐生成',upscale:'原始视频 AI 超分'}[category]||'自动发现的模型清单'),engine:value.engine||(isTts?'qwen-tts':value.runtime?.package)||'未知',version:value.engineComfyVersion||value.runtime?.version||value.release||null,revision:value.revision||nested?.revision||value.release||null,repository:value.repository||nested?.id||null,sourceUrl:value.sourceUrl||array(value.sources)[1]||(isTts?'https://huggingface.co/'+(value.id||nested?.id):null),license:value.license||nested?.license||null,metadataSource:'deployment/'+filename,files,binding:value.binding||GB10,verifiedAt:value.verifiedAt||null,deployedSha256:value.deployedSha256||null});
 }catch(error){errors.push({source:filename,error:error.message});}
 return {models,errors};
}

/** One bounded SSH read: no hashing, model loads, downloads, writes or GPU work. */
export function modelProbeScript(models){
 const spec=Buffer.from(JSON.stringify(models.filter(model=>model.executionHost!=='windows-local').map(model=>({id:model.id,category:model.category,directory:model.directory,files:model.files})))).toString('base64');
 return String.raw`import base64,concurrent.futures,datetime,json,pathlib,time,urllib.request
ROOT=pathlib.Path.home()/'ai-stack'
MODELS=ROOT/'h3-data/models'
SPEC=json.loads(base64.b64decode('${spec}'))
LOADERS=json.loads('${JSON.stringify(loaders)}')
def read(path):
 try:
  if path.stat().st_size>262144:return None
  return json.loads(path.read_text())
 except Exception:return None
def stat(path):
 try:
  if not path.resolve().is_relative_to(ROOT.resolve()):return {'error':'outside model workspace'}
  info=path.stat()
  return {'exists':path.is_file(),'bytes':info.st_size,'mtime':info.st_mtime,'mtimeNs':str(info.st_mtime_ns)}
 except FileNotFoundError:return {'exists':False,'bytes':0}
 except Exception as error:return {'error':str(error)}
def inspect(path):
 result=stat(path)
 if not result.get('exists'):
  part=stat(path.with_suffix(path.suffix+'.part'))
  result['partialBytes']=part.get('bytes',0)
 receipt=path.with_suffix(path.suffix+'.verified.json')
 result['receipt']=read(receipt)
 result['receiptMtime']=stat(receipt).get('mtime')
 return result
def node(name):
 try:
  with urllib.request.urlopen('http://127.0.0.1:8188/object_info/'+name,timeout=2) as response:
   data=json.loads(response.read(2*1024*1024))
  required=data.get(name,{}).get('input',{}).get('required',{})
  choices=[]
  for field,combo in required.items():
   values=combo[0] if isinstance(combo,list) and len(combo)>0 and isinstance(combo[0],list) else combo[1].get('options',[]) if isinstance(combo,list) and len(combo)>1 and isinstance(combo[1],dict) else []
   for filename in values:
    if isinstance(filename,str) and filename.lower().endswith(('.safetensors','.ckpt','.pth','.pt','.bin','.gguf')) and not filename.startswith(('/','\\')) and '..' not in filename.replace('\\','/').split('/'):
     relative=LOADERS[name][0]+'/'+filename.replace('\\','/')
     choices.append({'path':relative,'fileName':filename,'loader':name,'field':field,'purpose':LOADERS[name][1],'file':inspect(MODELS/relative)})
  return name,{'recognized':name in data,'choices':choices}
 except Exception as error:return name,{'recognized':False,'error':str(error),'choices':[]}
statuses={name:read(ROOT/path) for name,path in {'h3':'deployment-status.json','smoke':'smoke-status.json','music':'music-model-status.json','tts':'h3-data/tts/provision-status.json'}.items()}
for model in SPEC:
 if model['category']=='tts':
  directory=model.get('directory') or 'model'
  statusname='provision-status.json' if directory=='model' else directory.removesuffix('-model')+'-status.json'
  statuses[model['id']]=read(ROOT/'h3-data/tts'/statusname)
for status in statuses.values():
 if isinstance(status,dict):
  for entry in status.get('files',[]):
   if 'mtimeNs' in entry:entry['mtimeNs']=str(entry['mtimeNs'])
files={}
for model in SPEC:
 for entry in model['files']:
  root=ROOT/'h3-data/tts'/(model.get('directory') or 'model') if model['category']=='tts' else MODELS
  files[model['id']+'/'+entry['path']]=inspect(root/entry['path'])
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
 nodes=dict(pool.map(node,LOADERS))
version=None
try:
 with urllib.request.urlopen('http://127.0.0.1:8188/system_stats',timeout=2) as response:version=json.loads(response.read(262144)).get('system',{}).get('comfyui_version')
except Exception:pass
print(json.dumps({'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'statuses':statuses,'files':files,'nodes':nodes,'comfyVersion':version}))
`;
}

function verification(model,entry,file,remote){
 if(!file?.exists)return {status:'unknown',checkedAt:null,reason:file?.error||'文件尚未完整到达'};
 if(file.bytes!==entry.bytes)return {status:'changed',checkedAt:null,reason:'实际大小与固定清单不同，需要重新校验'};
 const tts=model.category==='tts'?(remote.statuses?.[model.id]||(model.directory==='model'?remote.statuses?.tts:null)):null,ttsFile=array(tts?.files).find(item=>item.path===entry.path),receipt=ttsFile||file.receipt;
 if(ttsFile&&tts.revision!==model.revision)return {status:'unknown',checkedAt:null,reason:'TTS 校验凭据的固定 revision 与清单不同'};
 const verifiedAt=ttsFile?stamp(tts.completedAt||tts.updatedAt):stamp(receipt?.verifiedAt||file.receiptMtime);
 if(receipt&&SHA.test(entry.sha256||'')&&receipt.sha256===entry.sha256&&(!model.revision||!receipt.revision||receipt.revision===model.revision)){
  const changed=ttsFile?String(ttsFile.mtimeNs)!==String(file.mtimeNs):file.mtime>Number(file.receiptMtime||Date.parse(verifiedAt)/1000)+.001;
  if(changed)return {status:'changed',checkedAt:verifiedAt,reason:'文件修改时间晚于校验凭据，需要重新校验'};
  return {status:'passed',checkedAt:verifiedAt,source:ttsFile?'TTS provision SHA256 receipt':'model .verified.json receipt'};
 }
 if(model.files.length===1&&model.deployedSha256===entry.sha256&&model.verifiedAt){
  if(file.mtime>Date.parse(model.verifiedAt)/1000+.001)return {status:'changed',checkedAt:model.verifiedAt,reason:'文件修改时间晚于登记校验时间，需要重新校验'};
  return {status:'passed',checkedAt:model.verifiedAt,source:'已登记的远端 SHA256 部署证据'};
 }
 return {status:'unknown',checkedAt:null,reason:'没有与当前文件匹配的 SHA256 校验凭据'};
}
function jobSummary(job,workId){return {id:job.id,workId:workId||job.request?.workId||job.workId||null,status:job.status,createdAt:job.createdAt||null,finishedAt:job.finishedAt||null,message:job.error||job.message||null,productionMs:job.productionMs??job.telemetry?.productionMs??job.renderMs??null};}
export function modelEvidence(model,{works=[],tts=[],music=[],asr=[]},server){
 if(model.executionHost==='windows-local'&&model.category==='asr')return localCpuEvidence(model,asr);
 let jobs=[],proof=null;
 if(model.category==='video'){
  jobs=works.flatMap(work=>array(work.jobs).filter(job=>job.serverId===server?.id||job.serverSnapshot?.host===server?.host).map(job=>jobSummary(job,work.id)));
  proof=works.flatMap(work=>array(work.jobs)).findLast(job=>job.status==='succeeded'&&(job.serverId===server?.id||job.serverSnapshot?.host===server?.host)&&job.telemetry?.output?.width>0&&job.telemetry?.output?.frames>0&&job.telemetry?.provenance?.source==='comfyui-history-sha256');
 }else if(model.category==='upscale'){
  for(const work of works)for(const job of array(work.studio?.exports))if(job.exportOptions?.enhance==='ai-1080p'){
   jobs.push(jobSummary(job,work.id));
   if(job.status==='succeeded'&&job.enhancement?.method==='real-esrgan'&&array(job.enhancement.sources).some(source=>source.status==='succeeded'&&source.model?.sha256===model.files[0]?.sha256&&source.output?.width>source.input?.width))proof=job;
  }
 }else if(model.category==='tts'){
  jobs=tts.filter(job=>job.model?.revision===model.revision||job.telemetry?.revision===model.revision).map(job=>jobSummary(job));
  proof=tts.findLast(job=>job.status==='succeeded'&&job.telemetry?.revision===model.revision&&job.telemetry?.weightSha256===model.files.find(file=>file.path==='model.safetensors')?.sha256&&Number(job.output?.duration)>0&&job.telemetry?.torch);
 }else if(model.category==='music'){
  jobs=music.filter(job=>job.modelSnapshot?.sha256===model.files[0]?.sha256||job.modelSnapshot?.revision===model.revision).map(job=>jobSummary(job));
  proof=music.findLast(job=>job.status==='succeeded'&&job.modelSnapshot?.sha256===model.files[0]?.sha256&&job.telemetry?.output?.duration>0&&Number.isFinite(job.telemetry?.serverExecutionMs));
 }
 jobs.sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
 return {jobs:jobs.slice(0,5),counts:{total:jobs.length,active:jobs.filter(job=>['queued','running'].includes(job.status)).length,succeeded:jobs.filter(job=>job.status==='succeeded').length,failed:jobs.filter(job=>['failed','interrupted'].includes(job.status)).length},gpuInference:{validated:Boolean(proof),checkedAt:proof?.finishedAt||proof?.renderFinishedAt||null,jobId:proof?.id||null,message:proof?'已找到当前固定权重的真实成功生产记录':'尚无匹配当前固定权重的真实推理成功证据'}};
}

/** Cache and single-flight cover every browser and the background sampler together. */
export function createModelInventory({rootDir,dataDir,getServers,readRemote,getTtsCapability,intervalMs=30000,clock=()=>Date.now()}){
 let cached=null,pending=null,at=-Infinity;
 async function sample(){
  if(pending)return pending;
  if(cached&&clock()-at<intervalMs)return cached;
  pending=(async()=>{
   const sampleStarted=clock(),checkedAt=new Date(sampleStarted).toISOString(),registry=await readModelRegistry(rootDir),servers=getServers(),server=servers.find(item=>item.host===GB10.host&&item.user===GB10.user&&Number(item.port||22)===GB10.port);
   const bound=server?{id:server.id,name:server.name,host:server.host,user:server.user,port:server.port||22}:null;
   const localModels=registry.models.filter(model=>model.executionHost==='windows-local'),remoteModels=registry.models.filter(model=>model.executionHost!=='windows-local');
   const [probe,cap,catalog,tts,music,asr,local]=await Promise.allSettled([
    server&&remoteModels.length?readRemote(server,modelProbeScript(remoteModels)):Promise.reject(new Error('尚未接入已授权 GB10 或没有远端登记模型')),
    server&&getTtsCapability?getTtsCapability():Promise.resolve(null),
    readJson(join(dataDir,'works','catalog.json')),readJson(join(dataDir,'tts','catalog.json')),readJson(join(dataDir,'music','catalog.json')),readJson(join(dataDir,'asr','catalog.json')),
    Promise.all(localModels.map(async model=>({id:model.id,value:await readLocalCpuModel(model,{rootDir,dataDir,checkedAt})})))
   ]);
   let remote=null,error=null;
   if(probe.status==='fulfilled')try{remote=typeof probe.value==='string'?JSON.parse(probe.value):probe.value;if(!remote||!remote.files||!remote.nodes)throw new Error('远端模型采样格式无效');}catch(failure){error=failure.message;remote=null;}
   else error=probe.reason.message;
   const evidence={works:catalog.status==='fulfilled'?array(catalog.value?.works):[],tts:tts.status==='fulfilled'?array(tts.value?.jobs):[],music:music.status==='fulfilled'?array(music.value?.jobs):[],asr:asr.status==='fulfilled'?array(asr.value?.jobs):[]},ttsCap=cap.status==='fulfilled'?cap.value:null,localSamples=new Map(local.status==='fulfilled'?local.value.map(item=>[item.id,item.value]):[]);
   const models=registry.models.map(model=>{
    if(model.executionHost==='windows-local'){
     const sampled=localSamples.get(model.id)||{registered:true,executionHost:'windows-local',device:'cpu',binding:model.binding,bindingMatched:true,checkedAt,reachable:false,state:'unknown',download:{bytes:null,total:model.files.reduce((sum,file)=>sum+file.bytes,0),status:'unknown'},verification:{status:'unknown',verifiedFiles:0,totalFiles:model.files.length,checkedAt:null},engineStatus:{name:model.engine,version:model.version,recognized:null,checkedAt:null},files:model.files.map(file=>({...file,actualBytes:null,exists:null,verification:{status:'unknown',checkedAt:null,reason:'本机采样未知'}})),error:local.status==='rejected'?local.reason.message:'本机采样未知',lastKnown:null};
     return {...model,...sampled,...modelEvidence(model,evidence,null)};
    }
    const matched=server&&model.binding.host===server.host&&(!model.binding.user||model.binding.user===server.user),current=Boolean(remote&&matched),status=remote?.statuses?.[model.category==='video'?'h3':model.category==='tts'?model.id:model.category],modelCap=model.kind==='voice-design'?ttsCap?.voiceDesign:model.kind==='reference-voice'?ttsCap?.referenceVoice:ttsCap,files=model.files.map(entry=>{
     const file=current?remote.files[model.id+'/'+entry.path]:null;return {...entry,actualBytes:file?.exists?file.bytes:file?.partialBytes??null,exists:current?file?.exists===true:null,mtime:stamp(file?.mtime),verification:current?verification(model,entry,file,remote):{status:'unknown',checkedAt:null,reason:error||'主机绑定未就绪'}};
    });
    const complete=files.every(file=>file.exists&&file.actualBytes===file.bytes),passed=files.every(file=>file.verification.status==='passed'),changed=files.some(file=>file.verification.status==='changed'),choices=current?Object.values(remote.nodes).flatMap(node=>array(node.choices)):[];
    const recognized=current?(model.category==='tts'?modelCap?.available===true:files.every(file=>choices.some(choice=>choice.path===file.path))):null;
    const total=model.files.reduce((sum,file)=>sum+file.bytes,0),observed=files.reduce((sum,file)=>sum+(file.actualBytes||0),0),reported=Number.isFinite(status?.bytes)?status.bytes:0,bytes=current?Math.min(total,Math.max(observed,complete?0:reported)):null,metrics=modelEvidence(model,evidence,bound);
    if(model.category==='video'&&current&&remote.statuses?.smoke?.stage==='passed'&&passed&&!metrics.gpuInference.validated)metrics.gpuInference={validated:true,checkedAt:stamp(remote.statuses.smoke.updatedAt),jobId:remote.statuses.smoke.promptId||null,message:'GB10 远端真实出片与音轨 smoke 验证通过'};
    const previous=cached?.models.find(item=>item.id===model.id);
    return {...model,registered:true,binding:bound,bindingMatched:Boolean(matched),checkedAt,reachable:current,state:!current?'unknown':status?.stage==='failed'?'failed':!complete?'downloading':changed?'changed':passed&&recognized?'ready':'pending',download:{bytes,total,status:!current?'unknown':complete?'complete':status?.stage||'pending',updatedAt:stamp(status?.updatedAt)},verification:{status:!current?'unknown':changed?'changed':passed?'passed':'pending',verifiedFiles:files.filter(file=>file.verification.status==='passed').length,totalFiles:files.length,checkedAt:files.map(file=>file.verification.checkedAt).filter(Boolean).sort().at(-1)||null},engineStatus:{name:model.engine,version:current&&model.engine==='ComfyUI'?remote.comfyVersion||model.version:model.version,recognized,checkedAt:current?remote.checkedAt:null,message:model.category==='tts'?modelCap?.reason||modelCap?.message||null:null},files,...metrics,error:!current?error||'此部署未绑定到当前主机':status?.error||modelCap?.available===false&&model.category==='tts'&&modelCap.reason||null,lastKnown:!current&&previous?.reachable?{checkedAt:previous.checkedAt,download:previous.download,verification:previous.verification}:!current?previous?.lastKnown||null:null};
   });
   if(remote&&bound){
    const known=new Set(remoteModels.flatMap(model=>model.category==='tts'?[]:model.files.map(file=>file.path))),discovered=new Map();
    for(const [loader,node] of Object.entries(remote.nodes))for(const choice of array(node.choices)){
     if(known.has(choice.path))continue;
     const key=choice.path,prior=discovered.get(key);if(prior){prior.loaders.push(loader);continue;}
     discovered.set(key,{id:'discovered:'+key,name:choice.fileName,category:'discovered',purpose:choice.purpose,registered:false,metadataSource:null,revision:null,sourceUrl:null,files:[{path:key,bytes:choice.file?.bytes||null,actualBytes:choice.file?.bytes||null,verification:{status:'unknown',checkedAt:null,reason:'未登记来源，未执行校验'}}],binding:bound,bindingMatched:true,checkedAt,reachable:true,state:'unregistered',download:{bytes:choice.file?.bytes||null,total:null,status:'discovered'},verification:{status:'unknown',verifiedFiles:0,totalFiles:1,checkedAt:null},engineStatus:{name:'ComfyUI',version:remote.comfyVersion||null,recognized:true,checkedAt:remote.checkedAt},loaders:[loader],jobs:[],counts:{total:0,active:0,succeeded:0,failed:0},gpuInference:{validated:false,checkedAt:null,jobId:null,message:'未登记来源 / 未执行校验 / 未验证推理'},error:null});
    }models.push(...discovered.values());
   }else for(const previous of cached?.models||[])if(!previous.registered)models.push({...previous,reachable:false,state:'unknown',checkedAt,engineStatus:{...previous.engineStatus,recognized:null,checkedAt:null},download:{...previous.download,bytes:null,status:'unknown'},error:error||'远端未连接，保留上次发现记录',lastKnown:{checkedAt:previous.checkedAt,download:previous.download}});
   const readErrors=[['作品记录',catalog],['配音记录',tts],['配乐记录',music],['转写记录',asr],['本机模型',local]].filter(([,value])=>value.status==='rejected').map(([source,value])=>({source,error:value.reason.message}));
   cached={schemaVersion:1,checkedAt,intervalSeconds:intervalMs/1000,binding:bound,reachable:Boolean(remote),error,models,metadataErrors:[...registry.errors,...readErrors],counts:{registered:models.filter(model=>model.registered).length,discovered:models.filter(model=>!model.registered).length,ready:models.filter(model=>model.state==='ready').length,activeJobs:models.reduce((sum,model)=>sum+model.counts.active,0)}};at=sampleStarted;return cached;
  })().finally(()=>{pending=null;});return pending;
 }
 return {sample,get snapshot(){return cached;}};
}
