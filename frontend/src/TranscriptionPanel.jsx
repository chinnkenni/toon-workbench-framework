import {useEffect,useId,useRef,useState} from 'react';
import {Badge,Button,Callout,TextArea} from '@radix-ui/themes';
import {AudioLines,ChevronDown,Download,RefreshCw,ScanText} from 'lucide-react';
import {mergeTranscriptionJob,savedTranscriptionLines,transcriptionIsActive,transcriptionJobsForAsset,transcriptionLineState,transcriptionPayload,transcriptionQuality,transcriptionTime} from './transcription-ui.mjs';
import './transcription.css';

const LABELS={queued:'等待本机 CPU',running:'正在转写原声',succeeded:'转写已完成',failed:'转写失败',interrupted:'任务已中断'};
const array=value=>Array.isArray(value)?value:[];
const display=value=>typeof value==='string'||typeof value==='number'?String(value):value?.name||value?.id||value?.filename||'未记录';
const duration=value=>typeof value==='number'&&Number.isFinite(value)?`${(value/1000).toFixed(2)} 秒`:'未记录';

/** ASR reads the selected registered original; it never edits the shot or starts on page load. */
export default function TranscriptionPanel({workId,asset,shot,api,disabled=false}){
 const id=useId(),mounted=useRef(true),apiRef=useRef(api),loadTicket=useRef(0),submissionLock=useRef(false),uncertainSince=useRef(null);
 apiRef.current=api;
 const [initial]=useState(()=>savedTranscriptionLines(shot));
 const [expanded,setExpanded]=useState(false),[capability,setCapability]=useState(null),[loading,setLoading]=useState(false),[capabilityError,setCapabilityError]=useState(''),[error,setError]=useState(''),[jobs,setJobs]=useState([]),[job,setJob]=useState(null),[detail,setDetail]=useState(null),[detailReload,setDetailReload]=useState(0),[submitting,setSubmitting]=useState(false),[submissionUnknown,setSubmissionUnknown]=useState(false),[checkedNoReceipt,setCheckedNoReceipt]=useState(false),[expected,setExpected]=useState(()=>initial.lines.map(line=>line.text).join('\n'));
 const active=transcriptionIsActive(job),pending=jobs.find(transcriptionIsActive),assetBusy=Boolean(pending)||active,ready=capability?.available===true&&capability?.ready===true;
 const pollId=pending?.id||(active?job.id:null),pollStatus=pending?.status||(active?job.status:null);

 useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;loadTicket.current++;};},[]);
 async function load(){
  const ticket=++loadTicket.current;setLoading(true);setCapabilityError('');setError('');
  const results=await Promise.allSettled([apiRef.current('/api/asr/capability'),apiRef.current(`/api/asr/jobs?workId=${encodeURIComponent(workId)}`)]);
  if(!mounted.current||ticket!==loadTicket.current)return;
  const [cap,history]=results;
  if(cap.status==='fulfilled')setCapability(cap.value);else{setCapability(null);setCapabilityError(cap.reason?.message||'暂时无法读取转写能力。');}
  if(history.status==='fulfilled'){
   const found=transcriptionJobsForAsset(history.value.jobs,workId,asset.id);setJobs(found);setDetailReload(value=>value+1);
   setJob(previous=>{const same=found.find(item=>item.id===previous?.id);if(same)return mergeTranscriptionJob(previous,same);return previous||found[0]||null;});
   if(uncertainSince.current!==null){
    const receipt=found.find(item=>Date.parse(item.createdAt)>=uncertainSince.current-3000);
    if(receipt){setJob(receipt);setSubmissionUnknown(false);uncertainSince.current=null;setCheckedNoReceipt(false);}
    else setCheckedNoReceipt(true);
   }
  }else setError(history.reason?.message||'暂时无法读取该版本的转写记录。');
  setLoading(false);
 }
 useEffect(()=>{if(expanded)void load();},[expanded,workId,asset.id]);
 useEffect(()=>{
  if(!expanded||!pollId)return;
  let stopped=false,timer;
  async function poll(){
   try{
    const response=await apiRef.current(`/api/asr/jobs/${encodeURIComponent(pollId)}`);
    if(stopped||!mounted.current)return;
    if(response.job){setJob(previous=>previous?.id===response.job.id?mergeTranscriptionJob(previous,response.job):previous);setJobs(previous=>previous.map(item=>item.id===response.job.id?mergeTranscriptionJob(item,response.job):item));setError('');}
   }catch(problem){if(!stopped&&mounted.current)setError(`读取进度暂时失败：${problem.message||'请检查连接'}。任务不会自动重投。`);}
   if(!stopped)timer=setTimeout(poll,2000);
  }
  timer=setTimeout(poll,1500);
  return ()=>{stopped=true;clearTimeout(timer);};
 },[expanded,pollId,pollStatus]);
 useEffect(()=>{
  if(!expanded||job?.status!=='succeeded'||!job.id)return;
  let stopped=false;setDetail(null);
  Promise.resolve().then(()=>apiRef.current(`/api/asr/jobs/${encodeURIComponent(job.id)}/result`)).then(value=>{if(!stopped&&mounted.current)setDetail(value);}).catch(problem=>{if(!stopped&&mounted.current)setError(`转写已完成，完整证据暂未读取：${problem.message||'请重读记录'}。`);});
  return ()=>{stopped=true;};
 },[expanded,job?.id,job?.status,detailReload]);

 async function transcribe(){
  if(disabled||!ready||assetBusy||loading||submissionLock.current||submissionUnknown)return;
  let body;try{body=transcriptionPayload(workId,asset.id,expected);}catch(problem){setError(problem.message);return;}
  submissionLock.current=true;uncertainSince.current=Date.now();setSubmitting(true);setError('');setCheckedNoReceipt(false);
  try{
   const response=await apiRef.current('/api/asr/transcribe',body);
   if(!response.job?.id)throw new Error('服务未返回任务编号，请先重读记录确认受理情况。');
   if(!mounted.current)return;
   setJob(response.job);setJobs(previous=>[response.job,...previous.filter(item=>item.id!==response.job.id)]);setSubmissionUnknown(false);uncertainSince.current=null;
  }catch(problem){
   if(mounted.current){const unknown=!problem.status||problem.status>=500;setSubmissionUnknown(unknown);if(!unknown)uncertainSince.current=null;setError(unknown?`${problem.message||'提交结果不明'}。请先重读记录核对受理情况，避免重复提交。`:problem.message||'任务未提交。');}
  }finally{submissionLock.current=false;if(mounted.current)setSubmitting(false);}
 }
 const full=detail?.jobId===job?.id?detail:null,result=full?{...full.transcript,comparison:full.comparison}:job?.result,comparison=result?.comparison,segments=array(result?.segments),execution=full?.execution||job?.executionSnapshot||{},source=full?.source||job?.sourceSnapshot||{},telemetry=job?.telemetry||{};
 const model=execution.model;
 const quality=transcriptionQuality({full,job,segments});
 return <details className="segment-transcription" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
  <summary><ScanText size={15}/><span>核对原声台词</span>{assetBusy?<Badge color="amber" size="1">{LABELS[pending?.status||job?.status]}</Badge>:null}<ChevronDown size={14}/></summary>
  {expanded?<div className="segment-transcription-body">
   <p className="transcription-note">只转写当前视频版本的原声。点击后由本机 CPU 执行，不占用 GB10 视频队列。</p>
   <div className="transcription-capability"><Badge color={ready?'green':'gray'} size="1">{loading?'正在检查':ready?'本机转写可用':'暂不可用'}</Badge><span>{capability?.message||capabilityError||'正在读取实际部署状态…'}</span><Button type="button" size="1" variant="ghost" color="gray" disabled={loading||submitting} onClick={()=>void load()} aria-label="重新读取转写能力与记录"><RefreshCw size={12}/>重读记录</Button></div>
   {capabilityError?<Callout.Root color="amber" size="1"><Callout.Text>{capabilityError} 可重读记录重试。</Callout.Text></Callout.Root>:null}
   <label className="transcription-label" htmlFor={`${id}-expected`}>要核对的原句 <span>每行一句，可留空</span></label>
   <TextArea id={`${id}-expected`} aria-label="要核对的原句" value={expected} rows={3} maxLength={20000} resize="vertical" disabled={submitting||assetBusy} onChange={event=>setExpected(event.target.value)} placeholder="填写希望在原声里听到的准确台词…"/>
   <p className="transcription-note">初始来源：{initial.source}。原句仅用于转写后的比对，不传给识别模型作为提示。此处修改不会保存到剧本。</p>
   <Button type="button" size="1" disabled={disabled||!ready||assetBusy||loading||submitting||submissionUnknown} loading={submitting} onClick={()=>void transcribe()}><AudioLines size={13}/>{assetBusy?LABELS[pending?.status||job?.status]:'开始转写当前版本'}</Button>
   {submissionUnknown?<p className="transcription-warning">提交状态尚未核实，已暂停再次提交。请先重读记录。</p>:null}
   {submissionUnknown&&checkedNoReceipt?<Button type="button" size="1" color="gray" variant="surface" disabled={loading||assetBusy} onClick={()=>{uncertainSince.current=null;setSubmissionUnknown(false);setCheckedNoReceipt(false);setError('');}}>已核对无新记录，允许再次提交</Button>:null}
   {jobs.length>1?<div className="transcription-history" aria-label="该视频的历史转写">{jobs.slice(0,6).map((item,index)=><Button type="button" key={item.id} size="1" variant={job?.id===item.id?'soft':'ghost'} color="gray" disabled={submitting} onClick={()=>setJob(item)} aria-pressed={job?.id===item.id}>{index===0?'最新记录':`记录 ${jobs.length-index}`} · {LABELS[item.status]||item.status}</Button>)}</div>:null}
   {job?<section className="transcription-result" aria-label="原声转写结果">
    <div className="transcription-result-heading"><Badge color={job.status==='succeeded'?'green':job.status==='failed'||job.status==='interrupted'?'red':'amber'} size="1">{LABELS[job.status]||job.status}</Badge>{job.status==='succeeded'?<a href={`/api/asr/jobs/${encodeURIComponent(job.id)}/result?download=1`} download><Download size={12}/>完整 JSON</a>:null}</div>
    {job.message?<p className="transcription-note" role="status">{job.message}</p>:null}
    {job.error?<p className="transcription-warning">{typeof job.error==='string'?job.error:job.error.message||'转写失败，请下载或重读记录核对。'}</p>:null}
    {job.status==='succeeded'?<>
     <h4>实际转写</h4><p className="transcription-text">{typeof result?.text==='string'?result.text||'本次未识别出文字。':'结果文字未记录，请下载 JSON 核对。'}</p>
     <p className="transcription-note">实测识别输入时长：{quality.inputDuration===null?'未记录':`${Number(quality.inputDuration.toFixed(6))} 秒`}{quality.sourceDuration!==null?`；原文件音轨：${Number(quality.sourceDuration.toFixed(6))} 秒`:''}。下方分段时码为识别模型估计值，不代表原音实际延长。</p>
     {quality.warning?<Callout.Root color="amber" size="1"><Callout.Text>{quality.warning}</Callout.Text></Callout.Root>:null}
     {segments.length?<ol className="transcription-segments">{segments.map((segment,index)=><li key={segment.id??index}><time>{transcriptionTime(segment.start)} – {transcriptionTime(segment.end)}</time><span>{segment.text||'（无文字）'}</span>{quality.outOfBounds.includes(index)?<Badge color="amber" size="1">时码超出实测音轨</Badge>:null}{quality.repeated.includes(index)?<Badge color="amber" size="1">与上一段文本重复</Badge>:null}</li>)}</ol>:null}
     {array(comparison?.lines).length?<div className="transcription-comparison"><h4>本次提交原句的检出情况</h4>{comparison.lines.map((line,index)=>{const state=transcriptionLineState(line);return <div key={line.id||index}><span>{line.text}</span><Badge size="1" color={state.color}>{state.label}</Badge></div>;})}{comparison.warning?<p className="transcription-note">{comparison.warning}</p>:null}</div>:null}
    </>:null}
    <details className="transcription-evidence"><summary>模型、原音频与实际耗时</summary><dl><div><dt>任务</dt><dd>{job.id}</dd></div><div><dt>模型</dt><dd>{display(model)}</dd></div><div><dt>模型版本</dt><dd>{model?.revision||'未记录'}</dd></div><div><dt>模型 SHA256</dt><dd>{model?.sha256||'未记录'}</dd></div><div><dt>运行设备</dt><dd>{display(execution.device)}</dd></div><div><dt>源文件 SHA256</dt><dd>{source.sha256||'未记录'}</dd></div><div><dt>识别音频 SHA256</dt><dd>{full?.audio?.sha256||'未记录'}</dd></div><div><dt>生产耗时</dt><dd>{duration(telemetry.productionMs)}</dd></div><div><dt>含排队总计</dt><dd>{duration(telemetry.totalMs)}</dd></div></dl>{job.executionSnapshot?<pre>{JSON.stringify(job.executionSnapshot,null,2)}</pre>:null}</details>
   </section>:<p className="transcription-note">该视频版本暂无转写记录。展开面板和读取记录不会启动任务。</p>}
   {error?<Callout.Root color="red" size="1" role="alert"><Callout.Text>{error}</Callout.Text></Callout.Root>:null}
   <p className="transcription-limitation">识别可能漏字或误听，仍需播放原声核对。ASR 不判断声龄、人物音色、说话归属或口型，也不自动修改台词和时间轴。</p>
  </div>:null}
 </details>;
}
