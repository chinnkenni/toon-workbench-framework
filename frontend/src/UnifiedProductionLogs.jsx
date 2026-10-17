import React,{memo,useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Badge,Button,Callout,Dialog,Flex,IconButton,Spinner,Tabs,Text} from '@radix-ui/themes';
import {ChevronDown,Clock3,Download,RefreshCw,X} from 'lucide-react';
import './unified-production-logs.css';

const KINDS={video:'视频生成','upscale-export':'超分导出',export:'本机成片合成','storyboard-export':'故事板预演',voice:'台词配音','voice-design':'人物声线设计',music:'配乐生成',transcription:'原声台词核对'};
const STATUSES={queued:'排队中',running:'生产中',succeeded:'已完成',failed:'失败',interrupted:'已中断',cancelled:'已取消',unknown:'状态未知'};
const FILTERS=[['all','全部'],['video','视频'],['export','超分 / 导出'],['voice','配音'],['music','配乐'],['asr','转写']];
const array=value=>Array.isArray(value)?value:[];
const measured=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const number=value=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2});
export const productionKey=record=>record.kind+':'+record.id;
export function productionDuration(value){
 if(!measured(value))return '未记录';
 if(value>0&&value<10)return number(value)+' 毫秒';
 if(value<60000)return number(value/1000)+' 秒';
 const seconds=value/1000,minutes=Math.floor(seconds/60);return minutes<60?`${minutes} 分 ${number(seconds%60)} 秒`:`${Math.floor(minutes/60)} 小时 ${minutes%60} 分 ${number(seconds%60)} 秒`;
}
export function productionWallTime(record){
 if(record.kind==='storyboard-export')return {label:'预演合成耗时',value:measured(record.timing?.productionMs)?record.timing.productionMs:measured(record.timing?.renderMs)?record.timing.renderMs:null};
 if(record.kind==='transcription')return {label:'CPU 转写耗时',value:measured(record.timing?.productionMs)?record.timing.productionMs:null};
 if(measured(record.timing?.productionMs))return {label:record.kind.includes('export')?'整体导出耗时':'生产耗时',value:record.timing.productionMs};
 if(record.kind.includes('export')&&measured(record.timing?.renderMs))return {label:'整体导出耗时',value:record.timing.renderMs};
 return {label:record.kind.includes('export')?'整体导出耗时':'生产耗时',value:null};
}
export function productionModelLabel(record){
 if(record.kind==='storyboard-export')return '本机 FFmpeg · 静态首帧预演，无 AI 生成';
 if(record.kind==='video'&&/minimax[-_]h3/i.test(record.raw?.modelId||''))return 'MiniMax H3 · GB10';
 const model=record.model;if(model?.name||model?.id)return model.name||model.id;
 if(record.kind==='export')return '本机 FFmpeg 合成 · 无 AI 模型';
 if(record.kind==='upscale-export'&&record.status==='succeeded'&&record.raw?.enhancement?.method==='not-required')return '本次无需 AI 超分 · 本机合成';
 return '本次模型未记录';
}
export function productionMatches(record,filter){return filter==='all'||filter==='export'&&['export','upscale-export','storyboard-export'].includes(record.kind)||filter==='voice'&&['voice','voice-design'].includes(record.kind)||filter==='asr'&&record.kind==='transcription'||record.kind===filter;}
export function productionLoadShare(record){
 const load=record.timing?.modelLoadMs,synthesis=record.timing?.synthesisMs;
 return measured(load)&&measured(synthesis)&&load+synthesis>0?load/(load+synthesis)*100:null;
}
export function productionRate(record){
 if(['transcription','storyboard-export'].includes(record.kind))return null;
 const duration=record.output?.duration,productionMs=record.timing?.productionMs;
 if(record.status!=='succeeded'||!measured(duration)||duration<=0||!measured(productionMs)||productionMs<=0)return null;
 return {audio:['voice','voice-design','music'].includes(record.kind),secondsPerMinute:duration*60000/productionMs,productionSecondsPerMediaSecond:productionMs/1000/duration,exported:record.kind.includes('export'),legacy:record.timing?.source==='legacy-timestamps'};
}
export function productionMediaSummary(record){
 if(record.kind==='storyboard-export')return {label:'静态预演 MP4',value:measured(record.output?.duration)?number(record.output.duration)+' 秒':'未记录'};
 if(record.kind==='transcription')return {label:'识别文本',value:typeof record.raw?.result?.text==='string'?record.raw.result.text.length+' 字':'尚无结果'};
 return {label:'实际'+(['voice','voice-design','music'].includes(record.kind)?'音频':'视频'),value:measured(record.output?.duration)?number(record.output.duration)+' 秒':'未记录'};
}
export function productionTranscriptionFacts(record){
 const execution=record.params?.executed||{},source=execution.source||{},audio=execution.audio||{};
 return [['执行位置','Windows 本机 CPU'],['原文件音轨时长',measured(source.probe?.duration)?number(source.probe.duration)+' 秒':'未记录'],['识别 PCM 时长',measured(audio.duration)?number(audio.duration)+' 秒':'未记录'],['原素材 SHA256',source.sha256],['提取音轨 SHA256',audio.sha256],['转写音轨',audio.sampleRate&&audio.channels?`${audio.sampleRate} Hz · ${audio.channels} 声道`:'未记录'],['音轨提取耗时',productionDuration(execution.conversionMs)],['模型识别耗时',productionDuration(execution.inferenceMs)],['识别线程数',execution.threads],['识别语言',execution.language],['运行器版本',execution.runtime?.revision],['运行器 SHA256',execution.runtime?.sha256],['识别文本',record.raw?.result?.text]];
}
export function productionExportFacts(record){
 if(!record.kind.includes('export'))return [];
 const options=record.params?.exportOptions||{},snapshot=record.params?.timelineSnapshot||{},width=options.width??snapshot.width,height=options.height??snapshot.height,fps=options.fps??snapshot.fps,method=record.raw?.enhancement?.method;
 if(record.kind==='storyboard-export')return [['导出内容','故事板预演 · 静态首帧 / 计划对白'],['目标画布',measured(width)&&measured(height)?`${width} × ${height}`:'未记录'],['目标帧率',measured(fps)?number(fps)+' fps':'未记录'],['执行方式','本机 FFmpeg · 不调用视频生成或 AI 超分']];
 return [['目标画布',measured(width)&&measured(height)?`${width} × ${height}`:'未记录'],['目标帧率',measured(fps)?number(fps)+' fps':'未记录'],['请求增强方式',options.enhance==='ai-1080p'?'AI 超分 1080P':options.enhance==='none'||record.kind==='export'?'标准合成':'未记录'],['实际增强方法',method==='real-esrgan'?'Real-ESRGAN 源视频超分':method==='not-required'?'本次无需 AI 放大':record.kind==='export'?'本机 FFmpeg 合成':'未记录']];
}
export function productionStageSummary(stage){
 return stage.cacheHit?{label:'缓存复用',current:'本次未重新推理',historical:productionDuration(stage.historicalOriginMs)}:{label:'本次源超分',current:productionDuration(stage.productionMs),historical:null};
}
export function reconcileProduction(previous,next){
 if(!previous)return next;
 const known=new Map(previous.records.map(record=>[productionKey(record),record])),records=next.records.map(record=>{const prior=known.get(productionKey(record));return prior&&JSON.stringify(prior)===JSON.stringify(record)?prior:record;});
 const unchanged=records.length===previous.records.length&&records.every((record,index)=>record===previous.records[index]);
 if(unchanged&&JSON.stringify({...previous,records:[]})===JSON.stringify({...next,records:[]}))return previous;
 return {...next,records:unchanged?previous.records:records};
}

/** One open dialog owns one cancellable reader; polls cannot overtake or multiply. */
export function createProductionLogReader({workId,fetcher=fetch,onData,onError,onLoading=()=>{},setTimer=setInterval,clearTimer=clearInterval,isVisible=()=>true,intervalMs=3000}){
 let active=true,pending=null,controller=null,timer=null,pages=1;
 async function read(){
  if(!active)return null;if(pending)return pending;
  const currentController=new AbortController();controller=currentController;const signal=currentController.signal,pageCount=pages;
  onLoading(true);
  pending=(async()=>{
   try{
    const values=await Promise.all(Array.from({length:pageCount},async(_,page)=>{
     const response=await fetcher(`/api/production-log?workId=${encodeURIComponent(workId)}&limit=200&offset=${page*200}`,{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal});
     let value;try{value=await response.json();}catch{throw new Error('生产记录服务没有返回有效 JSON，请重试。');}
     if(!response.ok)throw new Error(value.error||'生产记录暂时无法读取。');
     if(!Array.isArray(value.records)||!Number.isSafeInteger(value.total)||value.total<0)throw new Error('生产记录格式无效，请重试。');return value;
    }));
    if(!active||signal.aborted)return null;
    const seen=new Set(),records=values.flatMap(value=>value.records).filter(record=>{const key=productionKey(record);if(seen.has(key))return false;seen.add(key);return true;});
    const warnings=[...new Map(values.flatMap(value=>array(value.warnings)).map(warning=>[JSON.stringify(warning),warning])).values()];
    const result={...values[0],records,warnings};onData(result);onError('');return result;
   }catch(error){if(active&&!signal.aborted){currentController.abort();onError(error.message);}return null;}
   finally{pending=null;controller=null;if(active)onLoading(false);}
  })();return pending;
 }
 return {
  start(){if(timer===null){void read();timer=setTimer(()=>{if(isVisible())void read();},intervalMs);}},
  read,
  async more(){if(!active)return;pages++;if(pending)await pending;return read();},
  dispose(){active=false;if(timer!==null)clearTimer(timer);timer=null;controller?.abort();},
 };
}

const stamp=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'未记录';
const valueText=value=>value===null||value===undefined?'未记录':typeof value==='object'?JSON.stringify(value,null,2):typeof value==='boolean'?value?'是':'否':String(value);
const PARAM_LABELS={prompt:'提示词',text:'台词 / 试音原文',voiceDescription:'人物声线描述',instruct:'模型表演指令',performanceInstruction:'本句表演备注',instructionApplied:'本次是否执行表演指令',speaker:'预置音色',language:'语言',name:'任务名称',duration:'请求时长（秒）',ratio:'请求画幅',resolution:'请求清晰度',seed:'随机种子',steps:'采样步数',cfg:'采样 CFG',cfg_scale:'条件编码 CFG',sampler:'采样器',sampler_name:'采样器',scheduler:'调度器',denoise:'去噪强度',width:'请求宽度',height:'请求高度',requestedFrames:'请求帧数',fps:'目标帧率',bpm:'节拍 BPM',voiceDesignJobId:'复用的声线设计任务',method:'执行方式',chunkFrames:'每批视频帧数',nativeScale:'模型原生倍率',modelFile:'视频模型文件',textEncoder:'文本编码器',videoVae:'画面解码器',audioVae:'音频解码器',negativePrompt:'负面提示词',mode:'生成方式',shiftVideo:'视频偏移',shiftAudio:'音频偏移',checkpoint:'音乐模型文件',shift:'模型偏移',maxNewTokens:'最大生成 token 数',attention:'注意力实现',dtype:'计算精度',package:'运行包版本',torch:'Torch 版本',tags:'配乐风格条件',lyrics:'歌词条件'};
function Facts({items}){return <dl className="unified-log-facts">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{valueText(value)}</dd></div>)}</dl>;}
function ModelFacts({model,source=false}){return <div className="unified-model-facts"><Text size="2" weight="medium">{source?'声线来源模型（历史设计，非本次执行）':model.role==='speech-tokenizer'?'语音分词器依赖（不作为独立推理计时）':'本次任务保存的模型'}</Text><Facts items={[[source?'来源模型':'模型',model.name||model.id],['固定版本 / revision',model.revision],['模型权重 SHA256',model.sha256]]}/></div>;}

function RecordDetails({record}){
 const timing=record.timing||{},output=record.output||{},share=productionLoadShare(record),rate=productionRate(record),storyboard=record.kind==='storyboard-export',voice=['voice','voice-design'].includes(record.kind),asr=record.kind==='transcription',exported=record.kind.includes('export'),params=record.params||{},executed=params.executed||{};
 const fields=Object.entries(params).filter(([key,value])=>!['episodeId','workId'].includes(key)&&value!==null&&typeof value!=='object').map(([key,value])=>[PARAM_LABELS[key]||key,value]);
 for(const [key,value] of Object.entries(executed))if(value!==null&&typeof value!=='object')fields.push(['实际执行 · '+(PARAM_LABELS[key]||key),value]);
 return <div className="unified-record-details">
  {record.kind==='upscale-export'?<Callout.Root size="1" color="blue"><Callout.Text>整体导出耗时已包含源超分与合成。下面的源阶段和合成器计时范围有重叠，请勿相加。</Callout.Text></Callout.Root>:null}
  <Facts items={[[asr?'本机 CPU 转写墙钟耗时':exported?'整体导出耗时':'生产墙钟耗时',productionDuration(productionWallTime(record).value)],[voice?'提交至 WAV 校验 / 任务登记':'提交至任务登记（原入口口径）',productionDuration(timing.totalMs)],['排队',productionDuration(timing.queueMs)],...(!asr?[['服务器工作流',productionDuration(timing.serverExecutionMs)]]:[]),...(exported?[[record.kind==='upscale-export'?'合成器计时（可含源超分，与整体重叠）':'本机合成器计时',productionDuration(timing.renderMs)]]:[]),...(voice?[['本次模型加载',productionDuration(timing.modelLoadMs)],['语音合成',productionDuration(timing.synthesisMs)],['产物回传',productionDuration(timing.transferMs)],['GPU 租约等待（可能已含在生产耗时）',productionDuration(timing.leaseWaitMs)],['等待 ComfyUI 空闲（可能已含在生产耗时）',productionDuration(timing.comfyQueueWaitMs)],['作品声音素材归档时间',stamp(record.registeredAt)]]:[])]}/>
  {voice?<p className="unified-log-note">{share===null?'冷加载占比未记录。':`本次冷加载占「模型加载＋语音合成」的 ${number(share)}%，分母不含排队、回传与其他等待。`}{record.params?.executed?.instructionApplied===false||record.params?.instructionApplied===false||record.raw?.instructionApplied===false?' 本次 Base 只复用固定声线，表演备注未传入模型执行。':''}</p>:null}
  <p className="unified-log-note">{storyboard?'这是静态首帧与计划对白的故事板预演，不代表镜头已生成动态视频，不提供真实配音或口型证据。':asr?'转写只核对识别文本；原句仅用于识别后比较，未作为识别提示。不判断声龄、说话人或口型，不自动修改台词。音轨提取与模型识别已包含在整体转写耗时内。':'服务器工作流和语音合成均为已保存的墙钟计时，包含各自的处理范围，不代表纯 GPU 内核时间。缺失测量显示「未记录」。'}</p>
  {rate?<section className="unified-production-rate"><Text size="2" weight="medium">这条任务的实际产出率</Text><Facts items={[[`每生产分钟产出${rate.audio?'音频':'视频'}`,number(rate.secondsPerMinute)+' 秒'],[`每秒实际${rate.audio?'音频':'视频'}所需生产`,number(rate.productionSecondsPerMediaSecond)+' 秒']]}/><p className="unified-log-note">根据已记录的实际产物时长与生产耗时计算。{rate.exported?'分母使用整体导出耗时，包含超分与合成（如有），不另加源阶段。':''}{rate.legacy?'耗时来源为历史时间戳回算（legacy-timestamps），沿用原记录，未重新补测。':''}不同类型与规格不混合汇总平均。</p></section>:null}
  <Facts items={[...(asr?productionTranscriptionFacts(record):[[storyboard?'实际预演时长':['voice','voice-design','music'].includes(record.kind)?'实际音频时长':'实际视频时长',measured(output.duration)?number(output.duration)+' 秒':'未记录'],['实际尺寸',measured(output.width)&&measured(output.height)?`${output.width} × ${output.height}`:'未记录'],['实际帧率',measured(output.fps)?number(output.fps)+' fps':'未记录'],[['voice','voice-design','music'].includes(record.kind)?'PCM 采样帧数':'视频帧数',output.frames],['采样率',measured(output.sampleRate)?output.sampleRate+' Hz':'未记录'],['声道数',output.channels]]),['提交时间',stamp(record.createdAt)],['开始时间',stamp(record.startedAt)],['完成时间',stamp(record.finishedAt)]]}/>
  {array(record.models).length?array(record.models).map((model,index)=><ModelFacts key={index} model={model} source={model.role==='source-voice-design'}/>):<p className="unified-log-note">{productionModelLabel(record)}</p>}
  {record.stages?.length?<section className="unified-stage-list"><Text size="2" weight="medium">源视频超分阶段</Text>{record.stages.map((stage,index)=>{const summary=productionStageSummary(stage);return <article key={stage.sourceId||index} className="unified-stage"><Flex justify="between" align="center" gap="3" wrap="wrap"><Text size="2" weight="medium">源 {index+1} · {stage.model?.name||stage.model?.id||'模型未记录'}</Text><Badge color={stage.cacheHit?'blue':'gray'}>{summary.label}</Badge></Flex><Facts items={[[stage.cacheHit?'本次推理':'源生产耗时',summary.current],...(stage.cacheHit?[['首次生成的历史耗时（不计本次）',summary.historical],['历史服务器工作流（不计本次）',productionDuration(stage.historicalOriginServerExecutionMs)],['本次缓存复用时间',stamp(stage.cacheReusedAt)]]:[['服务器工作流',productionDuration(stage.serverExecutionMs)]]),['实际视频帧数',stage.frames],['源素材编号',stage.sourceId]]}/><details className="unified-secondary-details"><summary>源参数、分批执行与文件指纹</summary><pre>{JSON.stringify({model:stage.model,params:stage.params,sourceHash:stage.sourceHash,outputHash:stage.outputHash,startedAt:stage.startedAt,finishedAt:stage.finishedAt},null,2)}</pre></details></article>;})}</section>:null}
  <section className="unified-parameter-section"><Text size="2" weight="medium">当次保存的参数</Text>{exported?<Facts items={productionExportFacts(record)}/>:null}{fields.length?<Facts items={fields}/>:!exported?<p className="unified-log-note">这条历史任务没有保存可直接阅读的参数。</p>:null}{record.kind==='music'&&executed.conditioning?<><Text as="p" size="2" weight="medium">配乐条件编码（与采样 CFG 分开）</Text><Facts items={Object.entries(executed.conditioning).filter(([,value])=>value!==null&&typeof value!=='object').map(([key,value])=>[PARAM_LABELS[key]||key,value])}/></>:null}<details className="unified-secondary-details"><summary>完整参数快照（含时间轴 / 参考声线等）</summary><pre>{JSON.stringify(params,null,2)}</pre></details><details className="unified-secondary-details"><summary>原始任务与测速证据</summary><pre>{JSON.stringify(record.raw,null,2)}</pre></details></section>
 </div>;
}

const ProductionRecord=memo(function ProductionRecord({record,open,onToggle}){
 const timing=productionWallTime(record),output=record.output||{},mediaSummary=productionMediaSummary(record),audio=['voice','voice-design','music'].includes(record.kind),sourceModel=array(record.models).find(model=>model.role==='source-voice-design'),cached=record.kind==='upscale-export'&&record.stages?.length>0&&record.stages.every(stage=>stage.cacheHit);
 const url=typeof output.url==='string'&&/^\/api\/(?:works|tts|music)\//.test(output.url)?output.url:null;
 return <details className="unified-production-record" data-production-key={productionKey(record)} open={open} onToggle={event=>{if(event.target===event.currentTarget)onToggle(productionKey(record),event.currentTarget.open);}}>
  <summary><span className="unified-record-title"><span className="unified-record-type">{KINDS[record.kind]||record.kind}</span><strong>{record.title||'未命名任务'}</strong><span className="unified-record-model">{productionModelLabel(record)}{cached?' · 源超分缓存复用':''}</span>{sourceModel?<span className="unified-record-source">声线来源：{sourceModel.name||sourceModel.id}（历史设计）</span>:null}<time>{stamp(record.createdAt)} · {record.id.slice(0,8)}</time></span><span className="unified-record-metric"><small>{timing.label}</small><strong>{productionDuration(timing.value)}</strong></span><span className="unified-record-metric"><small>{mediaSummary.label}</small><strong>{mediaSummary.value}</strong>{measured(output.width)&&measured(output.height)?<small>{output.width} × {output.height}</small>:null}</span><Badge color={record.status==='succeeded'?'jade':['failed','interrupted'].includes(record.status)?'red':'gray'}>{['queued','running'].includes(record.status)?<Spinner size="1"/>:null}{STATUSES[record.status]||record.status}</Badge><ChevronDown size={16} className="unified-record-chevron"/></summary>
  {open?<><div className="unified-record-actions"><Text size="1" color={record.status==='failed'?'red':'gray'}>{record.raw?.error||record.raw?.message||'记录来自当次任务持久快照。'}</Text>{url?<Button asChild size="1" variant="soft"><a href={url} download><Download size={13}/>下载{audio?'音频':'成片'}</a></Button>:null}</div><RecordDetails record={record}/></>:null}
 </details>;
});

export default function UnifiedProductionLogs({work,open,onOpenChange}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[filter,setFilter]=useState('all'),[expanded,setExpanded]=useState(new Set()),reader=useRef(null),viewport=useRef(null),scroll=useRef({top:0,left:0}),saved=useRef(null);
 const workId=work?.id;
 useEffect(()=>{
  if(!open||!workId)return;
  setData(null);setError('');setFilter('all');setExpanded(new Set());scroll.current={top:0,left:0};saved.current=null;
  const next=createProductionLogReader({workId,isVisible:()=>!document.hidden,onLoading:setLoading,onError:setError,onData:value=>{
   if(viewport.current)scroll.current={top:viewport.current.scrollTop,left:viewport.current.scrollLeft};
   const result=reconcileProduction(saved.current,value);saved.current=result;setData(result);
  }});reader.current=next;next.start();
  return()=>{next.dispose();if(reader.current===next)reader.current=null;};
 },[open,workId]);
 useLayoutEffect(()=>{if(viewport.current){viewport.current.scrollTop=scroll.current.top;viewport.current.scrollLeft=scroll.current.left;}},[data]);
 const toggle=useCallback((key,value)=>setExpanded(previous=>{if(previous.has(key)===value)return previous;const next=new Set(previous);value?next.add(key):next.delete(key);return next;}),[]);
 const records=array(data?.records),visible=records.filter(record=>productionMatches(record,filter)),counts=FILTERS.map(([id,label])=>[id,label,records.filter(record=>productionMatches(record,id)).length]);
 const download=workId?'/api/production-log?workId='+encodeURIComponent(workId)+'&download=1':null;
 return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Content className="unified-production-dialog" maxWidth="1160px">
  <Flex justify="between" align="start" gap="4"><div><Dialog.Title>生产记录</Dialog.Title><Dialog.Description size="2">{work?.title} · 视频、超分、配音、配乐与转写的真实模型、参数和实际耗时。</Dialog.Description></div><Dialog.Close><IconButton variant="ghost" color="gray" size="1" aria-label="关闭生产记录"><X size={18}/></IconButton></Dialog.Close></Flex>
  <Flex justify="between" align="center" gap="3" wrap="wrap" className="unified-log-toolbar"><Flex gap="2" align="center"><Badge color="gray">{data?.total??0} 条记录</Badge><Text size="1" color="gray">{loading?<><Spinner size="1"/> 同步中</>:'打开时每 3 秒同步'}</Text></Flex><Flex gap="2"><Button variant="soft" color="gray" size="1" disabled={loading} onClick={()=>void reader.current?.read()}><RefreshCw size={13}/>刷新</Button>{download?<Button size="1" asChild><a href={download} download><Download size={13}/>下载完整 JSON</a></Button>:null}</Flex></Flex>
  <Tabs.Root value={filter} onValueChange={setFilter} className="unified-log-filters"><Tabs.List aria-label="生产记录类型">{counts.map(([id,label,count])=><Tabs.Trigger key={id} value={id}>{label}<span>{count}</span></Tabs.Trigger>)}</Tabs.List></Tabs.Root>
  {error?<Callout.Root color="red" size="1" role="alert"><Callout.Text>{error}{data?' 当前保留上次成功读取的记录。':''}</Callout.Text><Button size="1" variant="soft" color="red" disabled={loading} onClick={()=>void reader.current?.read()}>重试</Button></Callout.Root>:null}
  {array(data?.warnings).length?<Callout.Root color="amber" size="1"><Callout.Text>{data.warnings.map(warning=>warning.message).join(' ')}</Callout.Text></Callout.Root>:null}
  <div ref={viewport} className="unified-log-viewport" onScroll={event=>{scroll.current={top:event.currentTarget.scrollTop,left:event.currentTarget.scrollLeft};}} aria-busy={loading}>
   <p className="unified-log-intro"><Clock3 size={13}/>每条采用当次保存的历史参数。缺失时间显示「未记录」；导出整体、源超分与合成器计时有重叠，不相加。</p>
   {visible.map(record=><ProductionRecord key={productionKey(record)} record={record} open={expanded.has(productionKey(record))} onToggle={toggle}/>)}
   {!visible.length?<div className="unified-log-empty">{loading&&!data?<><Spinner/>正在读取真实生产记录…</>:error&&!data?'暂时无法读取记录，请重试。':records.length?'当前类型没有已加载的记录。':'还没有生产记录。生成视频、声线、配音或配乐，以及导出成片后会自动留存。'}</div>:null}
   {data&&records.length<data.total?<div className="unified-log-more"><Text size="1" color="gray">已加载 {records.length} / {data.total} 条，筛选作用于已加载记录。</Text><Button size="2" variant="soft" disabled={loading} onClick={()=>void reader.current?.more()}>加载更早记录</Button></div>:null}
   <details className="unified-secondary-details unified-log-definitions"><summary>时间口径与历史记录说明</summary>{Object.entries(data?.definitions||{}).map(([key,value])=><p key={key}><strong>{key}</strong>：{value}</p>)}</details>
  </div>
 </Dialog.Content></Dialog.Root>;
}
