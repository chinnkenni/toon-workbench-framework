import {readFile,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const array=value=>Array.isArray(value)?value:[];
const text=value=>typeof value==='string'&&value.length?value:null;
const measured=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const firstMeasured=(...values)=>values.map(measured).find(value=>value!==null)??null;
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const copy=value=>structuredClone(value);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const sameId=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

export const productionDefinitions={
 source:'只读聚合持久任务快照；不调用 GPU、探测当前模型、修改任务或用当前设置补写历史。缺失或无效测量为 null，不从时间戳重新回算。',
 queueMs:'各原始任务记录的排队时间。TTS 的 GPU lease 等待另见 leaseWaitMs，可能已包含在该任务 productionMs 内，不能再次相加。',
 productionMs:'原任务记录的生产墙钟耗时，包含该入口原有的等待、加载、推理、回传或转换范围；导出为整体耗时，已包含源超分与合成，不与 stages 或 renderMs 相加。',
 totalMs:'原任务保存的总计耗时，终点依原入口定义。TTS 截至 WAV 校验与任务登记，之后声音入库另看 registeredAt；不回算、不补加入库等待。未记录时为 null。',
 serverExecutionMs:'原 ComfyUI 工作流 execution_start 到 execution_success 的墙钟耗时，含加载、推理、解码和编码，不是纯 GPU 内核时间。',
 modelLoadMs:'原 TTS 运行器测量的模型加载墙钟耗时；缺失为 null。',
 synthesisMs:'原 TTS 运行器测量的语音合成墙钟耗时，不等同于纯 GPU 内核时间。',
 transferMs:'原运行器保存的产物回传耗时；缺失为 null。',
 renderMs:'原合成器记录的墙钟耗时。AI 导出时该计时范围可能包含源超分，不能当纯本机编码耗时，不能与整体 productionMs 或源阶段相加。',
 stages:'每个源的超分证据。cacheHit=true 时，本次 productionMs/serverExecutionMs 为 null，首次计算的记录仅列 historicalOriginMs/historicalOriginServerExecutionMs，不计为本次 GPU 执行。',
 model:'只采用当次任务保存的模型 ID、文件名、revision、权重 SHA256；缺失不取当前部署清单补齐。产物 SHA256 不会冒充模型 SHA256。',
 models:'models 包含本条模型及已记录依赖。role=source-voice-design 是历史参考声线模型，未在本条重复调用；speech-tokenizer 是依赖文件。未独立测量的依赖不得分摊或重复计入任务耗时。',
 output:'仅使用保存的实际媒体测量，不以请求时长或计划分辨率代替。TTS frames 是 PCM 采样帧数，视频 frames 是视频帧数。',
 warnings:'某源 catalog 不存在视为空；JSON 损坏、结构错误、不可读或路径越界时略过该源并返回 warnings，其余来源继续展示。',
 pagination:'默认每页100条，limit为1–200、offset为非负整数，按提交时间倒序；download=1忽略分页，下载该作品全部记录。',
};

function modelSnapshot(value,fallback={}){
 const source=object(value)?value:{};
 const result={name:text(source.name)||text(source.label)||text(source.fileName)||text(source.id)||text(fallback.name)||text(fallback.id),id:text(source.id)||text(fallback.id)||text(source.fileName),revision:text(source.revision)||text(fallback.revision),sha256:text(source.sha256)||text(source.weightSha256)||text(fallback.sha256)||text(fallback.weightSha256)};
 return Object.values(result).some(value=>value!==null)?result:null;
}
function timing(job,telemetry={}){
 telemetry=object(telemetry)?telemetry:{};
 return {queueMs:firstMeasured(telemetry.queueMs,job.queueMs),productionMs:firstMeasured(telemetry.productionMs,job.productionMs),totalMs:firstMeasured(telemetry.totalMs,job.totalMs),serverExecutionMs:firstMeasured(telemetry.serverExecutionMs,job.serverExecutionMs),modelLoadMs:measured(telemetry.modelLoadMs),synthesisMs:measured(telemetry.synthesisMs),transferMs:measured(telemetry.transferMs),renderMs:firstMeasured(job.renderMs,telemetry.renderMs),leaseWaitMs:measured(telemetry.leaseWaitMs),comfyQueueWaitMs:measured(telemetry.comfyQueueWaitMs),remoteTotalMs:measured(telemetry.remoteTotalMs),source:text(telemetry.source)};
}
function output(value={},url=null){
 const source=object(value)?value:{};
 return {duration:firstMeasured(source.durationSeconds,source.duration),width:measured(source.width),height:measured(source.height),fps:measured(source.fps),frames:measured(source.frames),sampleRate:firstMeasured(source.sampleRate,source.rate,source.audioSampleRate),channels:firstMeasured(source.channels,source.audioChannels),url};
}
function baseRecord(job,kind,workId,work,title){
 return {id:job.id,kind,status:text(job.status)||'unknown',workId,workTitle:text(work?.title)||text(work?.name),title:text(title),createdAt:stamp(job.createdAt),startedAt:stamp(job.startedAt),finishedAt:stamp(job.finishedAt),registeredAt:stamp(job.registeredAt),model:null,models:[],params:copy(object(job.request)?job.request:{}),timing:timing(job,job.telemetry),output:output(),stages:[],raw:copy(job)};
}
function videoRecord(job,work){
 const t=object(job.telemetry)?job.telemetry:{},p=object(t.parameters)?t.parameters:{},record=baseRecord(job,'video',work.id,work,job.shotTitle||array(work.shots).find(shot=>shot.id===job.shotId)?.title||'视频生成');
 record.model=modelSnapshot(job.modelSnapshot||job.model,{id:job.modelId,name:p.modelFile||job.modelId,revision:job.serverSnapshot?.modelRevision});
 record.models=[record.model,...['textEncoder','videoVae','audioVae'].filter(key=>text(p[key])).map(key=>({...modelSnapshot({name:p[key],id:p[key]}),role:key}))].filter(Boolean);
 if(object(t.parameters))record.params.executed=copy(t.parameters);
 const asset=array(work.assets).find(item=>item.id===job.assetId||item.jobId===job.id);
 record.output=output(t.output,asset&&UUID.test(asset.id||'')?`/api/works/${work.id}/assets/${asset.id}`:null);
 return record;
}
function upscaleStage(source){
 const cached=source.cacheHit===true;
 return {model:modelSnapshot(source.model),sourceId:text(source.sourceId),cacheHit:cached,productionMs:cached?null:measured(source.productionMs),serverExecutionMs:cached?null:measured(source.serverExecutionMs),historicalOriginMs:cached?measured(source.productionMs):null,historicalOriginServerExecutionMs:cached?measured(source.serverExecutionMs):null,frames:firstMeasured(source.output?.frames,source.input?.frames),sourceHash:text(source.sourceSha256),outputHash:text(source.outputSha256),startedAt:stamp(source.startedAt),finishedAt:stamp(source.finishedAt),cacheReusedAt:stamp(source.cacheReusedAt),params:{method:text(source.method),chunkFrames:measured(source.chunkFrames),nativeScale:measured(source.model?.nativeScale),input:copy(source.input??null),output:copy(source.output??null),tasks:copy(array(source.tasks)),...(object(source.workflow)?{workflow:copy(source.workflow)}:{})}};
}
function exportRecord(job,work){
 const storyboard=job.exportOptions?.mode==='storyboard',enhanced=!storyboard&&(job.exportOptions?.enhance==='ai-1080p'||job.enhancement?.requested==='ai-1080p'),episode=array(work.episodes).find(item=>item.id===job.episodeId);
 const record=baseRecord(job,storyboard?'storyboard-export':enhanced?'upscale-export':'export',work.id,work,job.title||`${episode?.title||'分集'} · ${storyboard?'故事板预演':enhanced?'AI 1080P 导出':'成片导出'}`);
 record.params={...record.params,episodeId:job.episodeId??null,exportOptions:copy(job.exportOptions??null),timelineSnapshot:copy(job.timelineSnapshot??null),selectionSnapshot:copy(job.selectionSnapshot??null)};
 if(storyboard)record.params.sourceClips=copy(job.sourceClips??null);
 record.stages=array(job.enhancement?.sources).filter(object).map(upscaleStage);
 const models=[modelSnapshot(job.enhancement?.model),...record.stages.map(stage=>stage.model)].filter(Boolean);
 record.models=models.filter((model,index)=>models.findIndex(other=>JSON.stringify(other)===JSON.stringify(model))===index);
 record.model=record.models[0]||null;
 record.output=output(job,job.status==='succeeded'?`/api/works/${work.id}/studio/exports/${job.id}/video`:null);
 return record;
}
function voiceRecord(job,workId,work){
 const t=object(job.telemetry)?job.telemetry:{},record=baseRecord(job,job.kind==='voice-design'||t.method==='voice-design'?'voice-design':'voice',workId,work,job.request?.name||job.name||'角色配音');
 record.model=modelSnapshot(job.model,{id:t.modelId,revision:t.revision,weightSha256:t.weightSha256});record.models=record.model?[record.model]:[];
 const runtime=object(job.runtime)?job.runtime:{},executed={...(object(runtime.parameters)?copy(runtime.parameters):{}),...(object(t.parameters)?copy(t.parameters):{})};
 for(const key of ['modelId','revision','weightSha256','tokenizerSha256','package','torch','attention','dtype','seed','maxNewTokens','method','instructionApplied','sourceVoiceJobId','sourceVoiceSha256']){
  const value=t[key]===undefined?runtime[key]:t[key];if(value!==undefined)executed[key]=copy(value);
 }
 if(executed.instructionApplied===undefined&&typeof job.instructionApplied==='boolean')executed.instructionApplied=job.instructionApplied;
 if(text(job.instructionLimitation))executed.instructionLimitation=job.instructionLimitation;
 if(Object.keys(executed).length)record.params.executed=executed;
 if(text(executed.tokenizerSha256))record.models.push({name:'speech_tokenizer/model.safetensors',id:null,revision:null,sha256:executed.tokenizerSha256,role:'speech-tokenizer'});
 if(object(job.sourceVoice)){const source=modelSnapshot(job.sourceVoice.model);if(source)record.models.push({...source,role:'source-voice-design'});record.params.sourceVoice=copy(job.sourceVoice);}
 record.output=output(job.output,job.status==='succeeded'?`/api/tts/jobs/${job.id}/audio`:null);return record;
}
function transcriptionRecord(job,workId,work){
 const record=baseRecord(job,'transcription',workId,work,job.request?.name||'原声台词核对');
 record.model=modelSnapshot(job.executionSnapshot?.model);
 record.models=record.model?[record.model]:[];
 record.params.executed={...copy(job.executionSnapshot||{}),audio:copy(job.audio||null),source:copy(job.sourceSnapshot||null)};
 // Source audio duration is an input measure, not newly produced audio/video.
 record.output=output();
 return record;
}
function musicRecord(job,workId,work){
 const record=baseRecord(job,'music',workId,work,job.name||job.request?.name||'作品配乐');record.model=modelSnapshot(job.modelSnapshot||job.model);record.models=record.model?[record.model]:[];
 const executed=object(job.telemetry?.parameters)?copy(job.telemetry.parameters):{},workflow=object(job.workflow)?job.workflow:null;
 if(workflow){
  const inputs=type=>Object.values(workflow).find(node=>object(node)&&node.class_type===type)?.inputs;
  const sampling=inputs('KSampler'),conditioning=inputs('TextEncodeAceStepAudio1.5'),shift=inputs('ModelSamplingAuraFlow')?.shift,checkpoint=inputs('CheckpointLoaderSimple')?.ckpt_name;
  executed.workflow=copy(workflow);
  if(object(sampling)){executed.sampling=copy(sampling);for(const key of ['seed','steps','cfg','scheduler','denoise'])if(executed[key]===undefined&&sampling[key]!==undefined)executed[key]=copy(sampling[key]);if(executed.sampler===undefined&&sampling.sampler_name!==undefined)executed.sampler=copy(sampling.sampler_name);}
  if(object(conditioning))executed.conditioning=copy(conditioning);
  if(shift!==undefined)executed.shift=copy(shift);if(checkpoint!==undefined)executed.checkpoint=copy(checkpoint);
 }
 if(Object.keys(executed).length)record.params.executed=executed;
 record.output=output(job.telemetry?.output,job.status==='succeeded'?`/api/music/jobs/${job.id}/audio`:null);return record;
}
async function catalog(dataRoot,source,key,warnings){
 if(!dataRoot)return [];
 try{
  const file=await realpath(join(dataRoot,source,'catalog.json')),part=relative(dataRoot,file);
  if(!part||part.startsWith('..')||isAbsolute(part))throw fail('outside-data-dir');
  let value;try{value=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error instanceof SyntaxError)throw fail('invalid-json');throw error;}
  if(!object(value)||!Array.isArray(value[key]))throw fail('invalid-catalog');return value[key];
 }catch(error){
  if(error.code==='ENOENT')return [];
  const code=['outside-data-dir','invalid-json','invalid-catalog'].includes(error.message)?error.message:'unreadable-catalog';
  warnings.push({source,code,message:`${source} 生产索引无法完整读取，该来源已略过；其他来源仍可查看。`});return [];
 }
}
function queryOptions(search){
 for(const key of search.keys())if(!['workId','limit','offset','download'].includes(key)||search.getAll(key).length!==1)throw fail('生产记录查询参数无效');
 const workId=search.get('workId');if(!UUID.test(workId||''))throw fail('请选择有效作品编号');
 const integer=(name,fallback,min,max)=>{const raw=search.get(name);if(raw===null)return fallback;if(!/^\d+$/.test(raw))throw fail('生产记录分页参数无效');const value=Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)throw fail('生产记录分页参数无效');return value;};
 const limit=integer('limit',100,1,200),offset=integer('offset',0,0,Number.MAX_SAFE_INTEGER),download=search.get('download');
 if(download!==null&&download!=='1')throw fail('生产记录下载参数无效');return {workId:workId.toLowerCase(),limit,offset,download:download==='1'};
}
function json(req,res,status,value,headers={}){
 const body=Buffer.from(JSON.stringify(value,null,2));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store',...headers});res.end(req.method==='HEAD'?undefined:body);
}
export async function handleProductionLog(req,res,url,{dataDir}){
 if(url.pathname!=='/api/production-log')return false;
 try{
  if(!['GET','HEAD'].includes(req.method)){json(req,res,405,{error:'生产记录仅支持只读查询'},{Allow:'GET, HEAD'});return true;}
  const options=queryOptions(url.searchParams),warnings=[];
  let root;try{root=await realpath(dataDir);}catch(error){if(error.code!=='ENOENT')throw error;root=null;}
  const [works,voices,music,transcriptions]=await Promise.all([catalog(root,'works','works',warnings),catalog(root,'tts','jobs',warnings),catalog(root,'music','jobs',warnings),catalog(root,'asr','jobs',warnings)]);
  const work=works.find(item=>object(item)&&sameId(item.id,options.workId)),records=[];
  const valid=(job,source)=>{if(object(job)&&UUID.test(job.id||''))return true;if(!warnings.some(item=>item.source===source&&item.code==='invalid-job'))warnings.push({source,code:'invalid-job',message:`${source} 索引中的无效任务已略过。`});return false;};
  if(work){for(const job of array(work.jobs))if(valid(job,'works')&&(!job.workId||sameId(job.workId,work.id)))records.push(videoRecord(job,work));for(const job of array(work.studio?.exports))if(valid(job,'works')&&(!job.workId||sameId(job.workId,work.id)))records.push(exportRecord(job,work));}
  for(const job of voices)if(sameId(job?.request?.workId,options.workId)&&valid(job,'tts'))records.push(voiceRecord(job,options.workId,work));
  for(const job of music)if(sameId(job?.workId||job?.request?.workId,options.workId)&&valid(job,'music'))records.push(musicRecord(job,options.workId,work));
  for(const job of transcriptions)if(sameId(job?.request?.workId,options.workId)&&valid(job,'asr'))records.push(transcriptionRecord(job,options.workId,work));
  records.sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
  const offset=options.download?0:options.offset,limit=options.download?records.length:options.limit;
  json(req,res,200,{records:options.download?records:records.slice(offset,offset+limit),total:records.length,offset,limit,definitions:productionDefinitions,warnings},options.download?{'Content-Disposition':`attachment; filename="production-log-${options.workId}.json"`}:{});return true;
 }catch(error){json(req,res,error.status||500,{error:error.message});return true;}
}
