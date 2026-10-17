import {readFile,writeFile,mkdir,rename,lstat,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stores=new Map(),MAX_AUDIO=64*1024*1024;
const MODEL={id:'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',revision:'0c0e3051f131929182e2c023b9537f8b1c68adfe',weightSha256:'38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137'};
const DESIGN_MODEL={id:'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',revision:'5ecdb67327fd37bb2e042aab12ff7391903235d3',weightSha256:'391e8db219f292c515297cdceeb43e4eae67cdde35fa57e79a6a8a532fca0522'};
const BASE_MODEL={id:'Qwen/Qwen3-TTS-12Hz-1.7B-Base',revision:'fd4b254389122332181a7c3db7f27e918eec64e3',weightSha256:'38fc7fc51c5e776e840414b6fd443962e9411b9654888fd7913e4da643cb857c'};
export const ttsSpeakers=[{id:'vivian',name:'Vivian · 明亮女声',description:'明亮、略带锋芒的年轻女声',language:'Chinese'},{id:'serena',name:'Serena · 温柔女声',description:'温暖柔和的年轻女声',language:'Chinese'},{id:'uncle_fu',name:'Uncle Fu · 醇厚男声',description:'沉稳低醇的成熟男声',language:'Chinese'},{id:'dylan',name:'Dylan · 北京男声',description:'清晰自然的年轻北京男声',language:'Chinese'},{id:'eric',name:'Eric · 成都男声',description:'活泼略沙哑的成都男声',language:'Chinese'},{id:'ryan',name:'Ryan · 节奏男声',description:'有节奏和动感的英语男声',language:'English'},{id:'aiden',name:'Aiden · 清亮男声',description:'阳光清晰的美式英语男声',language:'English'},{id:'ono_anna',name:'Ono Anna · 轻巧女声',description:'轻巧活泼的日语女声',language:'Japanese'},{id:'sohee',name:'Sohee · 温暖女声',description:'情绪丰富的韩语女声',language:'Korean'}];
const LANGUAGES=['Chinese','English','Japanese','Korean','German','French','Russian','Portuguese','Spanish','Italian'];
const now=()=>new Date().toISOString(),copy=value=>structuredClone(value);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function json(req,res,status,value){const bytes=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:bytes);}
async function atomic(file,value){const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(temporary,file);}
async function persist(store,job){await atomic(join(store.directory,'catalog.json'),{version:1,jobs:store.jobs});if(job)await atomic(join(store.directory,'jobs',job.id+'.json'),job);}
function serial(store,fn){const next=store.writes.catch(()=>{}).then(fn);store.writes=next.catch(()=>{});return next;}
async function getStore(context){
 if(!context?.dataDir)throw fail('配音数据目录缺失',503);const key=resolve(context.dataDir);
 if(!stores.has(key))stores.set(key,(async()=>{
  const directory=join(key,'tts');await mkdir(join(directory,'jobs'),{recursive:true});await mkdir(join(directory,'outputs'),{recursive:true});
  for(const folder of [directory,join(directory,'jobs'),join(directory,'outputs')])if((await lstat(folder)).isSymbolicLink())throw fail('配音目录不能是符号链接');
  let jobs=[];try{const catalog=JSON.parse(await readFile(join(directory,'catalog.json'),'utf8'));if(catalog.version!==1||!Array.isArray(catalog.jobs))throw new Error('配音索引格式无效');jobs=catalog.jobs;}catch(error){if(error.code!=='ENOENT')throw error;}
  const store={directory,dataDir:key,jobs,writes:Promise.resolve(),queue:[],running:false,registrations:new Map(),context};
  for(const job of jobs)if(!UUID.test(job.id||''))throw fail('配音索引包含无效任务编号',503);
  for(const job of jobs)if(['queued','running'].includes(job.status)){job.status='interrupted';job.finishedAt=now();job.message='应用重启，原配音状态需核对；未自动重复提交';await persist(store,job);}
  return store;
 })());return stores.get(key);
}
function text(value,label,max,required=false){if(typeof value!=='string'||value.length>max||value.includes('\0')||required&&!value.trim())throw fail(label+'须为'+(required?'非空':'')+'文本，最多 '+max+' 字');return value.trim();}
export function validateTtsRequest(body){
 if(!body||Array.isArray(body)||typeof body!=='object')throw fail('配音请求须为对象');if(!UUID.test(body.workId||''))throw fail('配音作品编号无效');
 if(['ref_audio','refAudio','referenceAudio'].some(key=>key in body))throw fail('仅允许本作品已生成的设计声线作为参考');
 if(body.voiceDesignJobId!==undefined){
  if(!UUID.test(body.voiceDesignJobId||''))throw fail('设计声线编号无效');const language=body.language||'Chinese';if(!LANGUAGES.includes(language))throw fail('请选择支持的配音语言');
  return {workId:body.workId,text:text(body.text,'台词',1000,true),voiceDesignJobId:body.voiceDesignJobId,language,performanceInstruction:text(body.performanceInstruction??body.instruct??'','台词表演备注',500),instructionApplied:false,name:text(body.name??'角色配音','配音名称',120,true)};
 }
 const speaker=String(body.speaker||'serena').toLowerCase();if(!ttsSpeakers.some(item=>item.id===speaker))throw fail('请选择已登记的角色音色');
 const language=body.language||'Chinese';if(!LANGUAGES.includes(language))throw fail('请选择支持的配音语言');
 return {workId:body.workId,text:text(body.text,'台词',1000,true),speaker,language,instruct:text(body.instruct??'','表演指令',500),name:text(body.name??'角色配音','配音名称',120,true)};
}
export function validateVoiceDesignRequest(body){
 if(!body||Array.isArray(body)||typeof body!=='object'||!UUID.test(body.workId||''))throw fail('声线设计作品编号无效');
 const language=body.language||'Chinese';if(!LANGUAGES.includes(language))throw fail('请选择支持的声线语言');
 return {workId:body.workId,name:text(body.name??'人物设计声线','声线名称',120,true),voiceDescription:text(body.voiceDescription,'声线描述',2000,true),text:text(body.text,'试音台词',500,true),language};
}
async function bodyJson(req){const parts=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>24*1024)throw fail('配音请求过大',413);parts.push(chunk);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fail('配音请求不是有效JSON');}}
export function inspectTtsWav(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<44||bytes.length>MAX_AUDIO||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw fail('配音输出不是有效 WAV',502);
 if(bytes.readUInt32LE(4)+8>bytes.length)throw fail('WAV 文件不完整',502);
 let fmt=null,dataBytes=0;for(let offset=12;offset+8<=bytes.length;){const size=bytes.readUInt32LE(offset+4),end=offset+8+size;if(end>bytes.length)throw fail('WAV 数据块不完整',502);const kind=bytes.toString('ascii',offset,offset+4);if(kind==='fmt '&&size>=16)fmt={format:bytes.readUInt16LE(offset+8),channels:bytes.readUInt16LE(offset+10),rate:bytes.readUInt32LE(offset+12),blockAlign:bytes.readUInt16LE(offset+20),bits:bytes.readUInt16LE(offset+22)};if(kind==='data')dataBytes+=size;offset=end+(size%2);}
 if(!fmt||fmt.format!==1||![1,2].includes(fmt.channels)||fmt.rate<8000||fmt.rate>96000||![16,24,32].includes(fmt.bits)||fmt.blockAlign!==fmt.channels*fmt.bits/8||!dataBytes||dataBytes%fmt.blockAlign)throw fail('WAV 声道、采样率或样本格式无效',502);
 const frames=dataBytes/fmt.blockAlign,duration=frames/fmt.rate;if(duration<=0||duration>300)throw fail('配音输出时长超出范围',502);
 return {...fmt,frames,duration,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
async function outputFile(store,job){
 const file=join(store.directory,'outputs',job.id+'.wav');if(job.relativePath!=='outputs/'+job.id+'.wav')throw fail('配音文件登记无效',404);
 const canonical=await realpath(file);if(canonical!==file||!(await lstat(file)).isFile()||(await lstat(file)).isSymbolicLink())throw fail('配音输出路径无效',404);return file;
}
async function resolveDesignSource(store,workId,id){
 if(!UUID.test(id||''))throw fail('设计声线编号无效');
 const job=store.jobs.find(item=>item.id===id);
 if(!job||job.request?.workId!==workId)throw fail('设计声线不属于当前作品');
 if(job.kind!=='voice-design'||job.status!=='succeeded'||!job.output?.sha256)throw fail('请选择已完成的声线设计试音');
 const measured=inspectTtsWav(await readFile(await outputFile(store,job)));
 if(measured.sha256!==job.output.sha256)throw fail('设计声线 WAV 在生成后发生变化');
 return {jobId:job.id,workId,sha256:measured.sha256,text:job.request.text,description:job.request.voiceDescription,model:copy(job.model)};
}
export async function resolveCharacterVoiceProfile(dataDir,workId,profile){
 if(!UUID.test(workId||'')||!profile||typeof profile!=='object'||Array.isArray(profile)||profile.engine!=='qwen3-tts')throw fail('角色配音音色无效');
 if(profile.language!==undefined&&profile.language!=='Chinese')throw fail('角色声线目前只支持中文');
 if(profile.mode===undefined||profile.mode==='preset'){
  if(!ttsSpeakers.some(item=>item.id===profile.speaker))throw fail('角色配音音色无效');
  return {engine:'qwen3-tts',...(profile.mode?{mode:'preset'}:{}),speaker:profile.speaker,instruct:text(profile.instruct??'','角色表演指令',500),language:'Chinese'};
 }
 if(profile.mode!=='designed')throw fail('角色声线模式无效');
 const store=await getStore({dataDir});await store.writes;
 const sourceVoice=await resolveDesignSource(store,workId,profile.voiceDesignJobId);
 return {engine:'qwen3-tts',mode:'designed',voiceDesignJobId:sourceVoice.jobId,description:text(profile.description??sourceVoice.description,'人物声线描述',2000),performanceInstruction:text(profile.performanceInstruction??'','台词表演备注',500),language:'Chinese',sourceVoice};
}
async function register(store,job){
 if(!store.context.persistAudio||job.media)return;
 if(store.registrations.has(job.id))return store.registrations.get(job.id);
 const pending=(async()=>{try{const file=await outputFile(store,job),media=await store.context.persistAudio({workId:job.request.workId,file,mimeType:'audio/wav',name:job.request.name,job:copy(job)});await serial(store,async()=>{job.media=media;job.registeredAt=now();delete job.registrationError;await persist(store,job);});}
 catch(error){await serial(store,async()=>{job.registrationError=error.message.slice(0,1000);await persist(store,job);});}})();
 store.registrations.set(job.id,pending);try{await pending;}finally{store.registrations.delete(job.id);}
}
async function pump(store){
 if(store.running)return;store.running=true;
 try{while(store.queue.length){const id=store.queue.shift(),job=store.jobs.find(item=>item.id===id);if(!job)continue;const start=performance.now();
  try{
   await serial(store,async()=>{job.status='running';job.startedAt=now();job.queueMs=Date.now()-Date.parse(job.createdAt);job.phase='waiting-gpu';job.message='等待 GB10 空闲后合成角色配音';await persist(store,job);});
   const runner=store.context.runTts||(await import('./tts-runtime.mjs')).runRemoteTts;
   let last=0,phase=null;
   const result=await runner({dataDir:store.dataDir,jobId:job.id,...job.request,mode:job.kind==='voice-design'?'design':job.kind==='designed-speech'?'clone':'preset',sourceVoice:job.sourceVoice,onProgress:value=>{if(phase===value?.phase&&Date.now()-last<1000)return;last=Date.now();phase=value?.phase;return serial(store,async()=>{if(typeof value?.phase==='string')job.phase=value.phase;if(typeof value?.message==='string')job.message=value.message.slice(0,400);await persist(store,job);});}});
   const expected=join(store.directory,'outputs',job.id+'.wav');if(!result||resolve(result.file)!==expected)throw fail('配音运行器返回了未登记输出路径',502);
   const canonical=await realpath(expected);if(canonical!==expected||(await lstat(expected)).isSymbolicLink())throw fail('配音输出不能是符号链接',502);
   const measured=inspectTtsWav(await readFile(expected));
   await serial(store,async()=>{Object.assign(job,{status:'succeeded',phase:'completed',finishedAt:now(),productionMs:performance.now()-start,totalMs:Date.now()-Date.parse(job.createdAt),relativePath:'outputs/'+job.id+'.wav',url:'/api/tts/jobs/'+job.id+'/audio',output:measured,telemetry:copy(result.telemetry||{}),message:'角色配音已生成并校验，原台词与参数已记录'});await persist(store,job);});
   await register(store,job);
  }catch(error){await serial(store,async()=>{Object.assign(job,{status:'failed',phase:'failed',finishedAt:now(),productionMs:performance.now()-start,totalMs:Date.now()-Date.parse(job.createdAt),error:error.message.slice(0,2000),message:error.message.slice(0,2000)});await persist(store,job);});}
 }}finally{store.running=false;}
}
export async function getActiveTtsJobs({dataDir}={}){const store=await getStore({dataDir});await store.writes;return Math.max(store.jobs.filter(job=>['queued','running'].includes(job.status)).length,store.running?1:0,store.registrations.size);}
async function serveAudio(req,res,file){const size=(await lstat(file)).size;let start=0,end=size-1,status=200;const range=req.headers.range;
 if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||!match[1]&&!match[2]){res.writeHead(416,{'Content-Range':'bytes */'+size});res.end();return;}if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}else start=Math.max(0,size-Number(match[2]));if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){res.writeHead(416,{'Content-Range':'bytes */'+size});res.end();return;}status=206;}
 res.writeHead(status,{'Content-Type':'audio/wav','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=3600',...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});if(req.method==='HEAD'){res.end();return;}await new Promise((done,reject)=>{const stream=createReadStream(file,{start,end});stream.on('error',reject);res.on('close',()=>{stream.destroy();done();});res.on('finish',done);stream.pipe(res);});
}
export async function handleCreativeTts(req,res,url,context){
 if(!url.pathname.startsWith('/api/tts/'))return false;
 try{
  const store=await getStore(context);store.context={...store.context,...context};await store.writes;
  if(url.pathname==='/api/tts/capability'&&req.method==='GET'){const provider=context.getTtsCapability||(await import('./tts-runtime.mjs')).getTtsCapability;const value=await provider({dataDir:context.dataDir});json(req,res,200,{...value,model:MODEL,speakers:ttsSpeakers,languages:LANGUAGES,activeJobs:Math.max(store.jobs.filter(job=>['queued','running'].includes(job.status)).length,store.running?1:0,store.registrations.size)});return true;}
  if(url.pathname==='/api/tts/jobs'&&req.method==='GET'){const workId=url.searchParams.get('workId');if(workId&&!UUID.test(workId))throw fail('作品编号无效');json(req,res,200,{jobs:copy(store.jobs.filter(job=>!workId||job.request.workId===workId).slice().reverse())});return true;}
  if(['/api/tts/generate','/api/tts/design'].includes(url.pathname)&&req.method==='POST'){
   const design=url.pathname.endsWith('/design'),request=(design?validateVoiceDesignRequest:validateTtsRequest)(await bodyJson(req)),kind=design?'voice-design':request.voiceDesignJobId?'designed-speech':'preset-speech';
   const sourceVoice=kind==='designed-speech'?await resolveDesignSource(store,request.workId,request.voiceDesignJobId):undefined;
   const provider=context.getTtsCapability||(await import('./tts-runtime.mjs')).getTtsCapability,capability=await provider({dataDir:context.dataDir}),ready=design?capability.voiceDesign:sourceVoice?capability.referenceVoice:capability;
   if(ready?.available!==true)throw fail(ready?.reason||'GB10 对应配音模型尚未就绪',503);
   const job=await serial(store,async()=>{if(store.jobs.filter(item=>['queued','running'].includes(item.status)).length>=20)throw fail('配音队列已满，请完成后再提交',409);const item={id:randomUUID(),kind,request,model:copy(design?DESIGN_MODEL:sourceVoice?BASE_MODEL:MODEL),...(sourceVoice?{sourceVoice,instructionApplied:false,instructionLimitation:'Base 参考声线模型不支持逐句表演指令；备注仅记录，未传入模型'}:{}),status:'queued',phase:'queued',createdAt:now(),message:design?'已加入人物声线设计队列':'已加入角色配音队列'};store.jobs.push(item);await persist(store,item);return copy(item);});store.queue.push(job.id);json(req,res,202,{job});setImmediate(()=>pump(store).catch(error=>console.error('TTS queue error:',error.message)));return true;
  }
  const match=/^\/api\/tts\/jobs\/([0-9a-f-]{36})(?:\/(audio|import))?$/.exec(url.pathname);if(!match||!UUID.test(match[1]))throw fail('配音接口不存在',404);const job=store.jobs.find(item=>item.id===match[1]);if(!job)throw fail('配音任务不存在',404);
  if(!match[2]&&req.method==='GET'){json(req,res,200,{job:copy(job)});return true;}
  if(match[2]==='audio'&&['GET','HEAD'].includes(req.method)){if(job.status!=='succeeded')throw fail('配音尚未完成',404);await serveAudio(req,res,await outputFile(store,job));return true;}
  if(match[2]==='import'&&req.method==='POST'){if(job.status!=='succeeded')throw fail('配音尚未完成',409);await register(store,job);json(req,res,200,{job:copy(job)});return true;}
  throw fail('配音接口不存在',404);
 }catch(error){if(!res.headersSent)json(req,res,error.status||(error.code==='ENOENT'?404:500),{error:error.message});else res.destroy(error);}return true;
}
