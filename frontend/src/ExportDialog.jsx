import {useEffect,useRef,useState} from 'react';
import {Badge,Button,Callout,Dialog,Flex,IconButton,RadioCards,Switch,Text} from '@radix-ui/themes';
import {Check,Clapperboard,Clock3,Download,Film,Layers3,Sparkles,X} from 'lucide-react';
import './export-dialog.css';
import {exportOutput,output1080Size} from './export-options-ui.mjs';
export {output1080Size} from './export-options-ui.mjs';

const AI='ai-1080p';
const ORIGINAL='none';

/** The parent owns job submission and decides when to close the controlled modal. */
export default function ExportDialog({open,onOpenChange,work,episodeId,capability={},onSubmit,busy=false,error=''}){
 const timeline=work?.studio?.timelines?.[episodeId],episode=work?.episodes?.find(item=>item.id===episodeId);
 const original={width:Number(timeline?.width)||0,height:Number(timeline?.height)||0},valid=Number.isInteger(original.width)&&Number.isInteger(original.height)&&original.width>0&&original.height>0;
 const ready=capability.ready===true,enhanced=output1080Size(original.width,original.height);
 const [mode,setMode]=useState('video'),[enhance,setEnhance]=useState(ORIGINAL),[pending,setPending]=useState(false),[localError,setLocalError]=useState('');
 const session=useRef(null),locked=useRef(false),touched=useRef(false),submitting=busy||pending;
 const key=`${work?.id||''}/${episodeId||''}`;
 useEffect(()=>{
  if(!open){session.current=null;return;}
  if(session.current!==key){session.current=key;touched.current=false;setMode('video');setEnhance(ready?AI:ORIGINAL);setLocalError('');}
  else if(!ready)setEnhance(ORIGINAL);
  else if(!touched.current)setEnhance(AI);
 },[open,key,ready]);
 const storyboard=mode==='storyboard',output=exportOutput({mode,enhance,ready,...original}),selected=output.enhance,size=output;
 const fps=timeline?.fps===24||timeline?.fps===30?`${timeline.fps} fps`:'沿用时间轴';
 const unavailable=capability.message||'AI 超分服务尚未就绪，仍可按时间轴原尺寸导出。';
 const model=capability.name||capability.model||(ready?'已配置的本机超分模型':'等待模型就绪');
 const message=(typeof error==='string'?error:error?.message)||localError;
 const change=value=>{if(submitting||storyboard||value===AI&&!ready)return;touched.current=true;setEnhance(value);setLocalError('');};
 const changeMode=value=>{if(submitting||!['video','storyboard'].includes(value))return;touched.current=true;setMode(value);if(value==='storyboard')setEnhance(ORIGINAL);setLocalError('');};
 const close=()=>{if(!submitting&&!locked.current)onOpenChange(false);};
 async function submit(event){
  event.preventDefault();if(locked.current||submitting||!valid||!onSubmit)return;
  locked.current=true;setPending(true);setLocalError('');
  try{await onSubmit(output);}
  catch(failure){setLocalError(failure?.message||'导出未提交成功，请稍后重试。');}
  finally{locked.current=false;setPending(false);}
 }
 return <Dialog.Root open={open} onOpenChange={value=>{if(!submitting&&!locked.current)onOpenChange(value);}}>
  <Dialog.Content className="export-dialog-content" maxWidth="660px" onEscapeKeyDown={event=>{if(submitting||locked.current)event.preventDefault();}} onPointerDownOutside={event=>{if(submitting||locked.current)event.preventDefault();}}>
   <div className="export-dialog-heading"><div className="export-heading-icon"><Download size={21}/></div><div><Dialog.Title>导出成片</Dialog.Title><Dialog.Description size="2">{work?.title||'当前作品'}{episode?` · ${episode.title}`:''}</Dialog.Description></div><IconButton variant="ghost" color="gray" size="1" aria-label="关闭导出设置" onClick={close} disabled={submitting}><X size={18}/></IconButton></div>
   <form onSubmit={submit}>
    <div className="export-section-label"><Text as="span" size="2" weight="medium">导出模式</Text><Text as="span" size="1" color="gray">动态成片与静态预演分别留档</Text></div>
    <RadioCards.Root className="export-mode-options" value={mode} onValueChange={changeMode} columns={{initial:'1',sm:'2'}} size="1" aria-label="导出模式">
     <RadioCards.Item value="video" disabled={submitting}><Flex direction="column" gap="1"><Text size="2" weight="medium">动态成片</Text><Text size="1" color="gray">需要每镜真实视频，完成后可准备发布</Text></Flex></RadioCards.Item>
     <RadioCards.Item value="storyboard" disabled={submitting}><Flex direction="column" gap="1"><Text size="2" weight="medium">故事板预演</Text><Text size="1" color="gray">绑定首帧 + 计划对白，先核对叙事与节奏</Text></Flex></RadioCards.Item>
    </RadioCards.Root>
    {storyboard?<Callout.Root color="blue" size="1" mt="3"><Callout.Icon><Clapperboard size={16}/></Callout.Icon><Callout.Text>每个启用分镜必须绑定同作品的真实首帧。仅在本机合成静态画面、镜号与计划对白，不自动生成配音；已有独立音轨沿用时间轴。预演不代表动态镜头已完成，发布时请明确预演类型。AI 超分关闭。</Callout.Text></Callout.Root>:null}
    <div className="export-section-label"><Text as="span" size="2" weight="medium">输出清晰度</Text><Text as="span" size="1" color="gray">画幅沿用本集时间轴</Text></div>
    <RadioCards.Root className="export-resolution-options" value={selected} onValueChange={change} columns={{initial:'1',sm:'2'}} size="2" aria-label="导出清晰度">
     <RadioCards.Item value={AI} disabled={storyboard||!ready||submitting} className="export-resolution-card">
      <div className="export-resolution-card-inner"><div className="export-resolution-icon"><Sparkles size={21}/><Badge color={ready?'jade':'gray'} size="1">AI 超分</Badge></div><Text as="span" size="3" weight="bold">1080P 高清成片</Text><Text as="span" size="2" className="export-pixel-size">{enhanced.width} × {enhanced.height}</Text><Text as="span" size="1" color="gray">AI 重建画面细节，适合最终交付</Text></div>
     </RadioCards.Item>
     <RadioCards.Item value={ORIGINAL} disabled={submitting} className="export-resolution-card">
      <div className="export-resolution-card-inner"><div className="export-resolution-icon"><Clapperboard size={21}/><Badge color="gray" size="1">标准合成</Badge></div><Text as="span" size="3" weight="bold">预览 / 原分辨率</Text><Text as="span" size="2" className="export-pixel-size">{valid?`${original.width} × ${original.height}`:'等待时间轴'}</Text><Text as="span" size="1" color="gray">按当前时间轴尺寸合成，便于检查剪辑</Text></div>
     </RadioCards.Item>
    </RadioCards.Root>
    <div className={`export-enhance-settings ${selected===AI?'enabled':''}`}>
     <div className="export-enhance-heading"><div><Text as="span" size="2" weight="medium">AI 细节修复与超分</Text><Text as="p" size="1" color="gray">{storyboard?'故事板预演使用原尺寸静态首帧，不调用 AI 超分':selected===AI?'使用 AI 模型重建细节并提升输出分辨率':'关闭后按时间轴原尺寸导出'}</Text></div><Switch checked={selected===AI} disabled={storyboard||!ready||submitting} onCheckedChange={checked=>change(checked?AI:ORIGINAL)} aria-label="启用 AI 超分到 1080P"/></div>
     <div className="export-model-row"><Text size="1" color="gray">超分模型</Text><Badge color={ready?'jade':'gray'} variant="soft" title={capability.model||model}>{model}</Badge></div>
     <div className="export-enhance-note"><Clock3 size={14}/><Text size="1" color="gray">AI 超分会增加处理时间，实际耗时以任务记录为准。</Text></div>
    </div>
    {!ready&&!storyboard?<Callout.Root color="amber" size="1" className="export-capability-note"><Callout.Icon><Sparkles size={16}/></Callout.Icon><Callout.Text>{unavailable}</Callout.Text></Callout.Root>:null}
    {!valid?<Callout.Root color="amber" size="1"><Callout.Text>请先创建分集并保存时间轴，再导出成片。</Callout.Text></Callout.Root>:null}
    <div className="export-output-summary" aria-label="本次导出参数"><div><Film size={15}/><Text size="1" color="gray">输出格式</Text><Text size="2" weight="medium">MP4</Text></div><div><Layers3 size={15}/><Text size="1" color="gray">输出尺寸</Text><Text size="2" weight="medium">{valid?`${size.width} × ${size.height}`:'—'}</Text></div><div><Clock3 size={15}/><Text size="1" color="gray">帧率</Text><Text size="2" weight="medium">{fps}</Text></div></div>
    <div className="export-preservation-note"><Check size={15}/><Text size="1" color="gray">{storyboard?'首帧与原计划保留，预演独立存档，不代替真实动态镜头。':'原始视频与素材保留，每次导出独立保存。完成后可下载成片，用于后续发布。'}</Text></div>
    {message?<Callout.Root color="red" size="1" className="export-error" role="alert"><Callout.Text>{message}</Callout.Text></Callout.Root>:null}
    <div className="export-dialog-actions"><Text size="1" color="gray">{storyboard?'故事板预演 · 静态首帧 + 计划对白':selected===AI?'1080P · AI 超分成片':'当前时间轴 · 标准合成'}</Text><Flex gap="3"><Button type="button" variant="soft" color="gray" onClick={close} disabled={submitting}>取消</Button><Button type="submit" disabled={!valid||submitting||!onSubmit} loading={submitting}><Download size={16}/>{submitting?'正在提交…':storyboard?'导出故事板预演':selected===AI?'导出 1080P 成片':'导出成片'}</Button></Flex></div>
   </form>
  </Dialog.Content>
 </Dialog.Root>;
}
