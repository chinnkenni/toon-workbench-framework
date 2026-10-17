import React,{memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Badge,Button,Callout,Card,Dialog,DropdownMenu,Flex,Heading,IconButton,Select,Spinner,Text,TextArea,TextField,Tooltip} from '@radix-ui/themes';
import {Archive,ArrowUpRight,BookOpen,ChevronRight,Clapperboard,Download,Ellipsis,FileText,FolderOpen,Grid2X2,Home,Image,Info,Layers3,Plus,Save,Search,Send,Server,Settings2,Sparkles,Upload,X} from 'lucide-react';
import {api as request,reconcileCatalog} from './api.mjs';
import LegacyWorkspace from './LegacyWorkspace.jsx';
import SegmentEditor from './SegmentEditor.jsx';
import SkillLibrary from './SkillLibrary.jsx';
import ExportDialog from './ExportDialog.jsx';
import {exportPreviewInfo} from '../../public/timeline-preview.js';
import ProductionLogs from './UnifiedProductionLogs.jsx';
import PublishingCenter from './PublishingCenter.jsx';
import WorkArchiveCenter from './WorkArchiveCenter.jsx';
import StyleReferencePanel from './StyleReferencePanel.jsx';
import {MATERIAL_SECTIONS,TIMELINE_SECTIONS,isGlobalStyleDestination,workspaceDestination,workspaceNavigation} from './workspace-navigation.mjs';
import './workspace-navigation.css';
import {WORK_TYPES,workType,workTypeLabel,groupWorks,filterWorks,isWorkGroupExpanded,metadataDraft,metadataSubmission} from './work-types.mjs';
import './work-types.css';
import './toast.css';

const SECTIONS=[{id:'script',label:'剧本',Icon:FileText},{id:'materials',label:'素材',Icon:Image},{id:'timeline',label:'时间轴',Icon:Clapperboard}];
const NAVIGATION_KEY='rack-studio-navigation-v1';
const EMPTY_CATALOG={works:[],models:[],jobs:[]};
const noop=()=>{};
function initialNavigation(){
 try{const saved=JSON.parse(localStorage.getItem(NAVIGATION_KEY)||'null');return workspaceNavigation(saved||{workId:localStorage.getItem('rack-active-work')||null,tab:localStorage.getItem('rack-art-tab')});}catch{return workspaceNavigation();}
}
function timestamp(value){return value?new Date(value).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}):'刚刚';}
const EXPORT_LABELS={queued:'等待导出',running:'正在导出',succeeded:'导出完成',failed:'导出失败',interrupted:'导出已中断'};
function exportEnhancement(job){const info=exportPreviewInfo(job);if(info.mode==='storyboard')return '静态首帧';return job?.enhancement?.method==='real-esrgan'?'AI 超分':job?.exportOptions?.enhance==='ai-1080p'?(job.status==='succeeded'?(info.independent?'1080P 试片':'1080P 成片'):'AI 超分'):'标准合成';}
function exportScopeText(job){const info=exportPreviewInfo(job);return [info.scopeLabel,Number.isInteger(info.shotCount)?`${info.shotCount} 个镜头`:null,Number.isInteger(info.clipCount)?`${info.clipCount} 段画面`:null,typeof info.durationSeconds==='number'&&Number.isFinite(info.durationSeconds)?`${Number(info.durationSeconds.toFixed(2))} 秒（实测）`:null].filter(Boolean).join(' · ');}
function exportDownloadLabel(job,latest=false){const info=exportPreviewInfo(job);return info.independent||info.mode==='storyboard'?`下载${info.label}`:latest?'下载最新成片':'下载成片';}
function exportPublishLabel(job){const info=exportPreviewInfo(job);return info.mode==='storyboard'?'准备发布预演':info.independent?'准备发布试片':'准备发布';}
function exportSize(job){return job?.width>0&&job?.height>0?`${job.width} × ${job.height}`:'尺寸待检测';}
function exportUrl(work,job){return `/api/works/${work.id}/studio/exports/${job.id}/video`;}

function ExportHistory({work,episodeId,open,onOpenChange,onPublish}){
 return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Content maxWidth="820px" className="export-history-dialog">
  <Flex justify="between" align="start" gap="4"><div><Dialog.Title>导出历史</Dialog.Title><Dialog.Description size="2">本集成片、独立动态试片和故事板预演分别留档，请先核对类型与范围。</Dialog.Description></div><Dialog.Close><IconButton variant="ghost" color="gray" size="1" aria-label="关闭导出历史"><X size={18}/></IconButton></Dialog.Close></Flex>
  <ExportContents work={work} episodeId={episodeId} onPublish={onPublish}/>
 </Dialog.Content></Dialog.Root>;
}
function ExportContents({work,episodeId,onPublish,onExport,inline=false,disabled=false}){
 const [selectedId,setSelectedId]=useState(null),jobs=[...(work?.studio?.exports||[])].filter(job=>job.episodeId===episodeId).reverse(),completed=jobs.filter(job=>job.status==='succeeded'),selected=completed.find(job=>job.id===selectedId)||completed.find(job=>exportPreviewInfo(job).mode==='video')||completed[0]||null;
 return <section className={inline?'export-library-page':'export-library-jobs'} aria-label="本集成片与导出历史">
  {inline?<div className="export-library-heading"><div><h2>成片</h2><p>查看本集的成片、独立试片和故事板预演。剪辑调整在左侧「剪辑」中继续。</p></div><Button onClick={onExport} disabled={disabled||!episodeId}><Upload size={15}/>创建导出</Button></div>:null}
  {inline&&selected?<div className="export-library-player"><Flex gap="2" align="center" wrap="wrap"><Badge color="jade">{exportPreviewInfo(selected).label}</Badge><Text size="2">{exportSize(selected)}</Text><Text size="1" color="gray">{exportScopeText(selected)}</Text></Flex><video key={selected.id} controls preload="metadata" onPlay={()=>setSelectedId(selected.id)} src={exportUrl(work,selected)} aria-label={`${exportPreviewInfo(selected).label}完整播放`}/></div>:null}
  <Flex direction="column" gap="3" mt={inline?'0':'4'} className="export-library-jobs">{jobs.map(job=><Card key={job.id} className={`export-library-job ${inline&&selected?.id===job.id?'is-selected':''}`}><Flex justify="between" align="center" gap="3" wrap="wrap"><Flex direction="column" gap="2"><Flex gap="2" align="center" wrap="wrap"><Text size="2" weight="medium">{exportPreviewInfo(job).label} · {EXPORT_LABELS[job.status]||job.status}</Text><Badge color={job.status==='failed'?'red':job.status==='succeeded'?'jade':'gray'}>{exportEnhancement(job)}</Badge>{job.status==='succeeded'?<Text size="2">{exportSize(job)}</Text>:null}</Flex><Text size="1" color="gray">{timestamp(job.createdAt)}</Text><Text size="1" color="gray">{exportScopeText(job)}</Text>{job.message||job.error?<Text size="1" color={job.error?'red':'gray'}>{job.error||job.message}</Text>:null}</Flex>{job.status==='succeeded'?<Flex gap="2" wrap="wrap">{inline?<Button size="1" variant={selected?.id===job.id?'soft':'outline'} color="gray" onClick={()=>setSelectedId(job.id)} aria-pressed={selected?.id===job.id}>播放此版本</Button>:<Button size="1" variant="soft" color="gray" asChild><a href={exportUrl(work,job)} target="_blank" rel="noopener noreferrer">预览<ArrowUpRight size={13}/></a></Button>}<Button size="1" asChild><a href={exportUrl(work,job)} download={`${work.title}-${job.id.slice(0,8)}.mp4`}><Download size={14}/>{exportDownloadLabel(job)}</a></Button><Button size="1" variant="soft" onClick={()=>onPublish?.(job.id)}><Send size={13}/>{exportPublishLabel(job)}</Button></Flex>:null}</Flex></Card>)}{jobs.length===0?<div className="export-library-empty">{episodeId?'本集还没有导出记录，完成剪辑后可创建导出。':'先选择作品与分集，再查看成片。'}</div>:null}</Flex>
 </section>;
}

function MetadataDialog({entry,onChange,onClose,onSubmit,busy,error}){
 const isWork=entry?.kind.endsWith('work'),creating=entry?.kind.startsWith('create'),name=isWork?'作品':'分集';
 return <Dialog.Root open={Boolean(entry)} onOpenChange={open=>{if(!open&&!busy)onClose();}}>
  <Dialog.Content className="metadata-dialog" maxWidth="540px" onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onPointerDownOutside={event=>{if(busy)event.preventDefault();}}>
   <Dialog.Title>{creating?'新建':'编辑'}{name}</Dialog.Title>
   <Dialog.Description size="2" color="gray">{isWork?'作品的剧本、角色、声音和视频都保存在这台电脑。':'每一集独立保存剧本、分镜与成片时间轴。'}</Dialog.Description>
   {entry?<form onSubmit={onSubmit}>
    <Flex direction="column" gap="4" mt="4">
     <label><Text as="span" size="2" weight="medium">{name}名称</Text><TextField.Root value={entry.title} maxLength={120} required placeholder={isWork?'给你的故事起个名字':'例如：第 2 集 · 星河来信'} onChange={event=>onChange({...entry,title:event.target.value})} disabled={busy}/></label>
     {isWork?<fieldset className="work-type-picker" disabled={busy}><legend>作品类型</legend><div>{WORK_TYPES.map(type=><label key={type.id} className="work-type-option" data-active={entry.type===type.id}><input type="radio" name="work-type" value={type.id} checked={entry.type===type.id} onChange={()=>onChange({...entry,type:type.id})}/><span><strong>{type.label}</strong><small>{type.description}</small></span></label>)}</div><Text as="p" size="1" color="gray">类型用于作品分组，之后也可以修改。</Text></fieldset>:null}
     {isWork?<label><Text as="span" size="2" weight="medium">视觉风格</Text><TextField.Root value={entry.style} maxLength={2000} placeholder="例如：手绘动漫、温暖科幻、柔和光线" onChange={event=>onChange({...entry,style:event.target.value})} disabled={busy}/></label>:null}
     <label><Text as="span" size="2" weight="medium">{isWork?'故事简介':'本集梗概'}</Text><TextArea value={entry.synopsis} rows={4} maxLength={10000} placeholder="记录故事的核心情节与创作方向…" onChange={event=>onChange({...entry,synopsis:event.target.value})} disabled={busy}/></label>
     {error?<Callout.Root color="red" size="1" role="alert"><Callout.Text>{error}</Callout.Text></Callout.Root>:null}
    </Flex>
    <Flex gap="3" mt="5" justify="end"><Button type="button" variant="soft" color="gray" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" loading={busy}>{creating?'创建':'保存'}{name}</Button></Flex>
   </form>:null}
  </Dialog.Content>
 </Dialog.Root>;
}

const WorkLibrary=memo(function WorkLibrary({works,search,onSearch,type,onTypeChange,onOpen,onCreate,onEdit}){
 const filtered=filterWorks(works,search,type),groups=groupWorks(works),hasSearch=Boolean(search.trim());
 return <section className="work-library">
  <div className="library-toolbar"><div><Heading as="h1" size="6">我的作品</Heading><Text as="p" color="gray" size="2">主题短片与长篇故事，都从这里开始。</Text></div><Flex gap="3" align="center" className="library-toolbar-actions"><TextField.Root value={search} onChange={event=>onSearch(event.target.value)} placeholder="搜索所有作品" aria-label="搜索作品库"><TextField.Slot><Search size={16}/></TextField.Slot></TextField.Root><Button onClick={onCreate}><Plus size={16}/>新建作品</Button></Flex></div>
  <div className="library-filterbar"><div className="library-type-filters" role="group" aria-label="按作品类型筛选">{[{id:'all',label:'全部',total:works.length},...groups].map(group=><Button key={group.id} size="2" variant={type===group.id?'soft':'ghost'} color={type===group.id?'jade':'gray'} aria-pressed={type===group.id} onClick={()=>onTypeChange(group.id)}>{group.label}<span>{group.total}</span></Button>)}</div><Text size="1" color="gray" role="status">{hasSearch?'找到 ':''}{filtered.length} 部作品</Text></div>
  {filtered.length===0?<div className="library-empty"><Search size={30}/><Heading size="3">{hasSearch?'没有找到对应作品':type==='all'?'开始你的第一部作品':`还没有${workTypeLabel({type})}`}</Heading><Text color="gray" size="2">{hasSearch?'试试作品名、简介或视觉风格。':'写下故事，建立属于你的角色与世界。'}</Text>{hasSearch?<Flex gap="3"><Button variant="soft" onClick={()=>onSearch('')}>清空搜索</Button>{type!=='all'?<Button variant="ghost" onClick={()=>onTypeChange('all')}>查看全部类型</Button>:null}</Flex>:<Button onClick={onCreate}><Plus size={15}/>新建{type==='all'?'作品':workTypeLabel({type})}</Button>}</div>:<div className="library-grid">{filtered.map(work=><Card key={work.id} className="library-card">
   <Button variant="ghost" className="library-card-cover" aria-label={`打开作品 ${work.title}`} onClick={()=>onOpen(work.id)}>{work.coverUrl?<img src={work.coverUrl} alt="" loading="lazy"/>:<span className="library-cover-empty"><Clapperboard size={32}/><Text size="1">等待第一幅画面</Text></span>}<Badge className="library-card-type" color={workType(work)==='series'?'blue':'jade'} variant="solid">{workTypeLabel(work)}</Badge><Badge className="library-card-count" color="gray" variant="solid">{work.episodes.length} 集 · {work.shots.length} 镜</Badge></Button>
   <div className="library-card-content"><Flex align="start" justify="between" gap="2"><div><Text as="p" size="1" color="gray" className="library-card-style">{work.style||'风格待定'}</Text><Heading as="h2" size="3"><Button variant="ghost" className="library-card-title" onClick={()=>onOpen(work.id)}>{work.title}</Button></Heading></div><DropdownMenu.Root><DropdownMenu.Trigger><IconButton variant="ghost" size="1" color="gray" aria-label={`管理作品 ${work.title}`}><Ellipsis size={17}/></IconButton></DropdownMenu.Trigger><DropdownMenu.Content><DropdownMenu.Item onSelect={()=>onOpen(work.id)}><FolderOpen size={15}/>继续制作</DropdownMenu.Item><DropdownMenu.Item onSelect={()=>onEdit(work)}><Settings2 size={15}/>作品信息</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Root></Flex>
    <Text as="p" size="2" color="gray" className="library-card-description">{work.synopsis||'写下故事，建立属于你的角色与世界。'}</Text><Flex justify="between" align="center" className="library-card-meta"><Text size="1" color="gray">{work.assets.length} 段视频 · {timestamp(work.updatedAt)}</Text><Button size="1" variant="ghost" onClick={()=>onOpen(work.id)}>继续制作<ChevronRight size={13}/></Button></Flex>
   </div>
  </Card>)}<Button variant="outline" className="library-new-card" onClick={onCreate}><Plus size={28}/><Text weight="medium">开始一个新故事</Text><Text size="1" color="gray">创建作品，慢慢构建你的世界</Text></Button></div>}
 </section>;
});

export default function App(){
 const localAccess=['127.0.0.1','localhost'].includes(window.location.hostname);
 const initial=useRef(null);if(!initial.current)initial.current=initialNavigation();
 const [catalog,setCatalog]=useState(EMPTY_CATALOG),catalogRef=useRef(EMPTY_CATALOG),pending=useRef(null),revision=useRef(0),mounted=useRef(false),refreshRef=useRef(null);
 const [workId,setWorkId]=useState(initial.current.workId),[episodeId,setEpisodeId]=useState(initial.current.episodeId),[tab,setTab]=useState(initial.current.tab),[materialSection,setMaterialSection]=useState(initial.current.materialSection),[timelineSection,setTimelineSection]=useState(initial.current.timelineSection),[contentMode,setContentMode]=useState(initial.current.contentMode),[search,setSearch]=useState(''),[workTypeFilter,setWorkTypeFilter]=useState('all'),workspaceMedia=useRef(null);
 const [collapsedGroups,setCollapsedGroups]=useState({});
 const [loading,setLoading]=useState(true),[connectionError,setConnectionError]=useState(''),[toastState,setToastState]=useState(null),toastTimer=useRef(null);
 const [metadata,setMetadata]=useState(null),[metadataBusy,setMetadataBusy]=useState(false),[metadataError,setMetadataError]=useState(''),[segmentBusy,setSegmentBusy]=useState(false),[timelineSaving,setTimelineSaving]=useState(false),busyRef=useRef(false);
 const [archiveOpen,setArchiveOpen]=useState(false);
 const [shotId,setShotId]=useState(null),[segmentOpen,setSegmentOpen]=useState(false),[logsOpen,setLogsOpen]=useState(false),[skillsOpen,setSkillsOpen]=useState(false),[exportOpen,setExportOpen]=useState(false),[exportSubmitting,setExportSubmitting]=useState(false),[exportError,setExportError]=useState(''),[exportCapability,setExportCapability]=useState({ready:false,message:'正在检查 AI 超分服务…'}),[exportHistoryOpen,setExportHistoryOpen]=useState(false),[publishingOpen,setPublishingOpen]=useState(false),[publishingExportId,setPublishingExportId]=useState(null),editor=useRef(null);
 const work=catalog.works.find(item=>item.id===workId)||null,episode=work?.episodes.find(item=>item.id===episodeId)||work?.episodes[0]||null;
 busyRef.current=metadataBusy||segmentBusy||timelineSaving||exportSubmitting;
 const toast=useCallback((message,options={})=>{setToastState({message,tone:options.tone||'jade'});clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToastState(null),5000);},[]);
 const commitCatalog=useCallback(value=>{const next=reconcileCatalog(catalogRef.current,value);catalogRef.current=next;if(mounted.current)setCatalog(next);return next;},[]);
 const rememberWork=useCallback(item=>{if(!item)return;revision.current++;const previous=catalogRef.current,index=previous.works.findIndex(known=>known.id===item.id),works=[...previous.works];if(index<0)works.unshift(item);else works[index]=item;commitCatalog({...previous,works});},[commitCatalog]);
 const api=useCallback(async(path,body)=>{const result=await request(path,body);if(body!==undefined&&result.work)rememberWork(result.work);return result;},[rememberWork]);
 const refresh=useCallback(async(force=false)=>{
  if(pending.current){if(!force)return pending.current;await pending.current.catch(noop);return refreshRef.current(true);}
  const startedRevision=revision.current;
  const operation=(async()=>{try{const value=await request('/api/works');if(mounted.current)setConnectionError('');return startedRevision===revision.current?commitCatalog(value):catalogRef.current;}catch(error){if(mounted.current)setConnectionError(error.message);throw error;}finally{if(mounted.current)setLoading(false);pending.current=null;}})();
  pending.current=operation;return operation;
 },[commitCatalog]);refreshRef.current=refresh;
 useEffect(()=>{mounted.current=true;void refresh().catch(noop);const timer=setInterval(()=>{if(!document.hidden)void refresh().catch(noop);},3000);return()=>{mounted.current=false;clearInterval(timer);clearTimeout(toastTimer.current);};},[refresh]);
 useEffect(()=>{try{localStorage.setItem(NAVIGATION_KEY,JSON.stringify({workId,episodeId:episode?.id||null,tab,materialSection,timelineSection,contentMode}));localStorage.setItem('rack-active-work',workId||'');localStorage.setItem('rack-art-tab',tab);}catch{}},[workId,episode?.id,tab,materialSection,timelineSection,contentMode]);
 const pauseEditor=useCallback(()=>{editor.current?.capture?.();editor.current?.pause?.();workspaceMedia.current?.querySelectorAll('video,audio').forEach(player=>player.pause());},[]);
 const selectWork=useCallback(id=>{if(busyRef.current){toast('正在保存，请稍等完成。');return;}pauseEditor();setSegmentOpen(false);setShotId(null);setWorkId(id);setEpisodeId(null);setContentMode('workspace');setExportOpen(false);setArchiveOpen(false);},[pauseEditor,toast]);
 const showLibrary=useCallback(()=>{if(busyRef.current)return;selectWork(null);setContentMode('library');},[selectWork]);
 const showStyles=useCallback(()=>{if(busyRef.current){toast('正在保存，请稍等完成。');return;}pauseEditor();setContentMode('styles');},[pauseEditor,toast]);
 const selectEpisode=useCallback(id=>{if(busyRef.current)return;pauseEditor();setSegmentOpen(false);setShotId(null);setEpisodeId(id);setExportOpen(false);},[pauseEditor]);
 const changeTab=useCallback((next,section)=>{if(busyRef.current){toast('正在保存，请稍等完成。');return;}const destination=workspaceDestination({tab,materialSection,timelineSection},next,section);pauseEditor();setTab(destination.tab);setMaterialSection(destination.materialSection);setTimelineSection(destination.timelineSection);setContentMode('workspace');if(!workId){const first=catalogRef.current.works[0];if(first){setWorkId(first.id);setEpisodeId(first.episodes[0]?.id||null);}}},[pauseEditor,toast,workId,tab,materialSection,timelineSection]);
 const editShot=useCallback(id=>{if(busyRef.current)return;pauseEditor();setShotId(id);setSegmentOpen(true);},[pauseEditor]);
 const openLogs=useCallback(()=>{pauseEditor();setLogsOpen(true);},[pauseEditor]);
 const openArchive=useCallback(()=>{if(busyRef.current)return;pauseEditor();setArchiveOpen(true);},[pauseEditor]);
 const openPublishing=useCallback(exportId=>{pauseEditor();setExportHistoryOpen(false);setPublishingExportId(typeof exportId==='string'?exportId:null);setPublishingOpen(true);},[pauseEditor]);
 const editClip=useCallback((id,dialogParent)=>editor.current?.editClip?.(id,{dialogParent}),[]);
 const onEditorReady=useCallback(value=>{editor.current=value;},[]);
 const openMetadata=useCallback((kind,targetWork,targetEpisode,typeHint)=>{if(busyRef.current)return;pauseEditor();setMetadataError('');setMetadata(metadataDraft(kind,targetWork,targetEpisode,typeHint));},[pauseEditor]);
 const createWork=useCallback(()=>openMetadata('create-work',null,null,workTypeFilter==='all'?'short-film':workTypeFilter),[openMetadata,workTypeFilter]);
 const editWork=useCallback(item=>openMetadata('update-work',item),[openMetadata]);
 const createEpisode=useCallback(()=>openMetadata('create-episode',work),[openMetadata,work]);
 const closeMetadata=useCallback(()=>{if(!busyRef.current)setMetadata(null);},[]);
 const saveMetadata=async event=>{
  event.preventDefault();if(metadataBusy||!metadata)return;const entry={...metadata};setMetadataBusy(true);setMetadataError('');
  try{
   const {isWork,creating,path,payload}=metadataSubmission(entry);
   const result=await api(path,payload),updated=result.work;setMetadata(null);setWorkId(updated.id);setContentMode('workspace');if(creating){setEpisodeId(isWork?updated.episodes[0]?.id:updated.episodes.at(-1)?.id);setTab('script');}
   await refresh(true).catch(noop);toast(creating?'已创建并保存在本机':'已保存到本机');
  }catch(error){setMetadataError(error.message);}finally{setMetadataBusy(false);}
 };
 const saveTimeline=useCallback(async()=>{if(busyRef.current)return;if(!editor.current?.save){toast('时间轴正在准备，请稍后重试。');return;}setTimelineSaving(true);try{await editor.current.save();}catch(error){toast(error.message);}finally{setTimelineSaving(false);}},[toast]);
 const exportFilm=useCallback(()=>{if(!work||!episode||busyRef.current)return;pauseEditor();setTab('timeline');setExportError('');setExportOpen(true);},[work,episode,pauseEditor]);
 useEffect(()=>{
  if(!exportOpen||!work)return;let live=true;
  setExportCapability({ready:false,message:'正在检查 AI 超分服务…'});
  api('/api/works/'+work.id+'/studio/export-capability').then(value=>{
   if(!live)return;const status=value.capability||value,model=status.model;
   setExportCapability({ready:status.available===true||status.ready===true,name:model?.name||status.name,model:typeof model==='string'?model:model?.fileName,message:status.message||status.reason||'AI 超分服务尚未就绪。'});
  }).catch(error=>{if(live)setExportCapability({ready:false,message:'AI 超分状态暂不可用：'+error.message});});
  return()=>{live=false;};
 },[exportOpen,work?.id,api]);
 const submitExport=useCallback(async options=>{
  if(exportSubmitting)throw new Error('导出任务正在提交，请稍等。');
  const target=editor.current,context=target?.getContext?.();
  if(!work||!episode||tab!=='timeline'||!target?.export||context&&(context.workId!==work.id||context.episodeId!==episode.id||context.tab!=='timeline'))throw new Error('时间轴正在准备，请稍后重试。');
  setExportSubmitting(true);setExportError('');
  try{const result=await target.export(options);if(!result?.exportJob?.id)throw new Error('未取得导出任务，请先刷新并核对任务列表。');setExportOpen(false);toast(options.mode==='storyboard'?'已交给本机合成故事板预演；静态首帧与计划对白单独留档。':options.enhance==='ai-1080p'?'已加入 AI 超分导出任务，完成后可下载成片。':'已交给本机合成，完成后可下载成片。');return result;}
  catch(error){setExportError(error.message);throw error;}finally{setExportSubmitting(false);}
 },[exportSubmitting,work,episode,tab,toast]);
 const model=catalog.models.find(item=>item.available),navDisabled=metadataBusy||segmentBusy||timelineSaving||exportSubmitting;
 const workGroups=useMemo(()=>groupWorks(catalog.works,search),[catalog.works,search]);
 const episodeExports=[...(work?.studio?.exports||[])].filter(job=>job.episodeId===episode?.id).reverse(),activeExport=episodeExports.find(job=>['queued','running'].includes(job.status)),latestExport=episodeExports.find(job=>job.status==='succeeded'&&exportPreviewInfo(job).mode==='video')||episodeExports.find(job=>job.status==='succeeded'),lastExport=episodeExports[0],exporting=Boolean(activeExport);
 const frameProgress=Number.isInteger(activeExport?.completedFrames)&&Number.isInteger(activeExport?.totalFrames)&&activeExport.totalFrames>0?activeExport.completedFrames+' / '+activeExport.totalFrames+' 帧':null;
 const globalStyles=isGlobalStyleDestination({contentMode}),libraryView=contentMode==='library',navigationActive=contentMode==='workspace'&&Boolean(work);
 return <div className="modern-studio">
  <aside className="modern-sidebar">
   <div className="modern-brand"><Layers3 size={25}/><span>漫剧工作台<small>CREATIVE STUDIO</small></span></div>
   <nav className="modern-primary-nav" aria-label="制作区块">{SECTIONS.map(({id,label,Icon})=>{const children=id==='materials'?MATERIAL_SECTIONS:id==='timeline'?TIMELINE_SECTIONS:[],active=navigationActive&&tab===id,selected=id==='materials'?materialSection:timelineSection;return <div key={id} className="modern-navigation-section"><Button variant={active?'soft':'ghost'} className={`modern-nav-item ${active?'active':''}`} onClick={()=>changeTab(id)} disabled={navDisabled} aria-current={active&&!children.length?'page':undefined} aria-expanded={children.length?active:undefined} aria-controls={children.length?`workspace-menu-${id}`:undefined}><Icon size={18}/>{label}{children.length?<ChevronRight className="modern-nav-chevron"/>:null}</Button>{active&&children.length?<div id={`workspace-menu-${id}`} className="modern-secondary-nav" role="group" aria-label={label+'子菜单'}>{children.map(item=><Button key={item.id} variant="ghost" className={selected===item.id?'active':''} disabled={navDisabled} onClick={()=>changeTab(id,item.id)} aria-current={selected===item.id?'page':undefined}><span aria-hidden="true"/>{item.label}</Button>)}</div>:null}</div>;})}</nav>
   <section className="sidebar-projects" aria-label="作品列表"><div className="sidebar-project-heading"><Text size="1" weight="medium">作品 <span>{catalog.works.length}</span></Text><Flex gap="1"><Tooltip content="所有作品"><IconButton size="1" variant="ghost" color="gray" onClick={showLibrary} disabled={navDisabled} aria-label="所有作品"><Grid2X2 size={14}/></IconButton></Tooltip><Tooltip content="新建作品"><IconButton size="1" variant="ghost" color="gray" onClick={createWork} disabled={navDisabled} aria-label="新建作品"><Plus size={15}/></IconButton></Tooltip></Flex></div>
    <TextField.Root className="sidebar-project-search" size="1" value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索作品" aria-label="搜索侧栏作品"><TextField.Slot><Search size={13}/></TextField.Slot></TextField.Root>
    <div className="sidebar-project-scroll">{workGroups.map(group=>{const expanded=isWorkGroupExpanded(group,search,collapsedGroups);return <section key={group.id} className="sidebar-project-group" aria-label={group.label+'作品组'}><button type="button" className="sidebar-project-group-heading" aria-expanded={expanded} aria-controls={'sidebar-work-group-'+group.id} disabled={navDisabled||Boolean(search.trim())} title={search.trim()?'搜索时自动展开匹配的作品组':undefined} onClick={()=>setCollapsedGroups(previous=>({...previous,[group.id]:!previous[group.id]}))}><span><ChevronRight size={12}/><Text as="span" size="1">{group.label}</Text></span><span aria-label={`${group.total} 部${group.label}`}>{search.trim()?`${group.works.length} / ${group.total}`:group.total}</span></button><div id={'sidebar-work-group-'+group.id} hidden={!expanded}><div className="sidebar-project-group-items">{group.works.map(item=><Button key={item.id} className={`sidebar-project-item ${item.id===workId?'active':''}`} variant={item.id===workId?'soft':'ghost'} onClick={()=>selectWork(item.id)} disabled={navDisabled} aria-label={`打开作品 ${item.title}`} aria-current={item.id===workId?'page':undefined}>{item.coverUrl?<img src={item.coverUrl} alt="" loading="lazy"/>:<FolderOpen size={17}/>}<span>{item.title}</span></Button>)}</div>{!group.works.length?<Text as="p" size="1" className="sidebar-project-group-empty">{search.trim()?'没有匹配作品':'还没有'+group.label}</Text>:null}</div></section>;})}</div>
   </section>
   <div className="modern-sidebar-footer"><Button variant="ghost" onClick={()=>setSkillsOpen(true)} disabled={navDisabled}><Sparkles size={17}/>创作技能库</Button><Button variant={globalStyles?'soft':'ghost'} className={globalStyles?'global-style-entry active':'global-style-entry'} onClick={showStyles} disabled={navDisabled} aria-current={globalStyles?'page':undefined}><Image size={17}/>视频画风库</Button>{localAccess?<Button variant="ghost" asChild><a href="http://127.0.0.1:18987/"><Server size={17}/>服务器管理<ArrowUpRight size={13}/></a></Button>:null}<Text size="1" className="sidebar-local-note">作品保存在这台电脑</Text></div>
  </aside>
  <main className="modern-main">
   <header className="modern-topbar"><div className="modern-breadcrumb"><Tooltip content="所有作品"><IconButton variant="ghost" color="gray" size="1" aria-label="返回作品库" onClick={showLibrary} disabled={navDisabled}><Home size={17}/></IconButton></Tooltip><span>/</span><Text size="2">{globalStyles?'视频画风库':work?work.title:'作品库'}</Text>{work&&!globalStyles?<><ChevronRight size={13}/><Text size="2" color="gray">{episode?.title||'未选择分集'}</Text></>:null}</div><div className="modern-top-actions"><Badge color={connectionError?'red':model?'jade':'gray'} variant="soft"><span className={`model-state-dot ${model&&!connectionError?'ready':''}`}/>{connectionError?'本机服务连接中断':model?'GB10 已连接':'GB10 等待就绪'}</Badge>{!globalStyles?<><Button size="2" variant="outline" color="gray" onClick={openLogs} disabled={!work||navDisabled}><FileText size={15}/>生产记录</Button><Button size="2" variant="outline" color="gray" className="archive-open-button" onClick={openArchive} disabled={!work||navDisabled}><Archive size={15}/>制作档案</Button>{work&&tab==='timeline'&&timelineSection==='edit'?<Button size="2" variant="soft" color="gray" onClick={saveTimeline} disabled={navDisabled} loading={timelineSaving}><Save size={15}/>保存时间轴</Button>:null}<Button size="2" variant="soft" color="gray" onClick={()=>openPublishing()} disabled={!work||navDisabled}><Send size={15}/>发布中心</Button><Button size="2" onClick={exportFilm} disabled={!work||!episode||navDisabled||exporting} loading={exportSubmitting}><Upload size={16}/>{exporting?'本机合成中':'导出成片'}</Button></>:null}</div></header>
   {work&&!globalStyles?<div className="modern-contextbar"><Flex gap="2" align="center"><Text size="1" color="gray">项目</Text><Select.Root value={work.id} onValueChange={selectWork} disabled={navDisabled}><Select.Trigger size="1" className="project-select" aria-label="当前项目"/><Select.Content position="popper">{catalog.works.map(item=><Select.Item key={item.id} value={item.id}>{item.title}</Select.Item>)}</Select.Content></Select.Root><Badge size="1" color={workType(work)==='series'?'blue':'jade'} className="context-work-type">{workTypeLabel(work)}</Badge><Text size="1" color="gray" className="episode-label">集数</Text><Select.Root value={episode?.id||undefined} onValueChange={selectEpisode} disabled={navDisabled||!work.episodes.length}><Select.Trigger size="1" className="episode-select" placeholder="先创建分集" aria-label="当前分集"/><Select.Content position="popper">{work.episodes.map(item=><Select.Item key={item.id} value={item.id}>{item.title}</Select.Item>)}</Select.Content></Select.Root><Tooltip content="新建分集"><IconButton size="1" variant="ghost" color="gray" onClick={createEpisode} disabled={navDisabled} aria-label="新建分集"><Plus size={15}/></IconButton></Tooltip></Flex><Flex gap="2" align="center"><Text size="1" color="gray" className="work-style-caption">{work.style||'视觉风格待定'}</Text><DropdownMenu.Root><DropdownMenu.Trigger><IconButton size="1" variant="ghost" color="gray" disabled={navDisabled} aria-label="作品和分集设置"><Ellipsis size={18}/></IconButton></DropdownMenu.Trigger><DropdownMenu.Content><DropdownMenu.Item onSelect={()=>editWork(work)}><Settings2 size={14}/>作品信息</DropdownMenu.Item><DropdownMenu.Item onSelect={createEpisode}><Plus size={14}/>新建分集</DropdownMenu.Item><DropdownMenu.Item disabled={!episode} onSelect={()=>openMetadata('update-episode',work,episode)}><BookOpen size={14}/>本集信息</DropdownMenu.Item><DropdownMenu.Separator/><DropdownMenu.Item onSelect={openLogs}><FileText size={14}/>生产记录</DropdownMenu.Item>{localAccess?<DropdownMenu.Item asChild><a href="http://127.0.0.1:19300/" target="_blank" rel="noopener noreferrer"><ArrowUpRight size={14}/>高级画布</a></DropdownMenu.Item>:null}</DropdownMenu.Content></DropdownMenu.Root></Flex></div>:null}
   {work&&!globalStyles&&episodeExports.length?<Flex className="studio-export-status" px="4" py="2" gap="3" align="center" justify="between" wrap="wrap" style={{background:activeExport?'var(--jade-2)':'var(--slate-2)',borderBottom:'1px solid var(--slate-5)'}}>
    <Flex gap="2" align="center" wrap="wrap">{activeExport?<><Spinner size="1"/><Badge color="jade">{exportPreviewInfo(activeExport).label}</Badge><Badge color="gray">{exportEnhancement(activeExport)}</Badge><Text size="1" color="gray">{exportScopeText(activeExport)}</Text><Text size="2">{activeExport.message||'正在处理导出任务…'}</Text>{frameProgress?<Badge color="gray">{frameProgress}</Badge>:null}</>:lastExport?.status==='failed'?<><Badge color="red">{exportPreviewInfo(lastExport).label} · 导出失败</Badge><Text size="1" color="gray">{exportScopeText(lastExport)}</Text><Text size="1" color="red">{lastExport.error||lastExport.message||'请查看导出历史并重试。'}</Text></>:latestExport?<><Badge color={exportEnhancement(latestExport)==='AI 超分'?'jade':'gray'}>{exportEnhancement(latestExport)}</Badge><Text size="2">{exportPreviewInfo(latestExport).label} · {exportSize(latestExport)}</Text><Text size="1" color="gray">{exportScopeText(latestExport)}</Text></>:<Text size="2" color="gray">{EXPORT_LABELS[lastExport?.status]||'导出记录'}</Text>}</Flex>
    <Flex gap="2" align="center" wrap="wrap">{latestExport?<Button size="1" asChild><a href={exportUrl(work,latestExport)} download={work.title+'-'+latestExport.id.slice(0,8)+'.mp4'}><Download size={14}/>{exportDownloadLabel(latestExport,true)}<Text size="1">{exportSize(latestExport)}</Text></a></Button>:null}<Button size="1" variant="soft" color="gray" onClick={()=>setExportHistoryOpen(true)}>导出历史<Badge color="gray" size="1">{episodeExports.length}</Badge></Button></Flex>
   </Flex>:null}
   {connectionError?<Callout.Root color="amber" size="1" className="studio-connection-alert"><Callout.Text>连接暂时中断，当前保留上次读取的作品。{connectionError}</Callout.Text></Callout.Root>:null}
   <div ref={workspaceMedia} className={`modern-content ${globalStyles?'is-global-styles':work?'has-work':'is-library'}`}>
    {loading&&!catalog.works.length&&!globalStyles?<div className="studio-loading"><Spinner size="3"/><Text size="2" color="gray">读取本机作品…</Text></div>:globalStyles?<StyleReferencePanel work={work} works={catalog.works} api={api} toast={toast}/>:!work||libraryView?<WorkLibrary works={catalog.works} search={search} onSearch={setSearch} type={workTypeFilter} onTypeChange={setWorkTypeFilter} onOpen={selectWork} onCreate={createWork} onEdit={editWork}/>:null}
    {work&&!libraryView?<LegacyWorkspace key={work.id} active={!globalStyles} work={work} episodeId={episode?.id||null} tab={tab} materialSection={materialSection} timelineSection={timelineSection} onMaterialSectionChange={setMaterialSection} api={api} toast={toast} refresh={refresh} onEditShot={editShot} onCreateEpisode={createEpisode} onTabChange={changeTab} onEditorReady={onEditorReady}/>:null}
    {work&&contentMode==='workspace'&&tab==='timeline'&&timelineSection==='exports'?<ExportContents key={work.id+'/'+episode?.id} work={work} episodeId={episode?.id||null} onPublish={openPublishing} onExport={exportFilm} inline disabled={navDisabled||exporting}/>:null}
   </div>
  </main>
  <MetadataDialog entry={metadata} onChange={setMetadata} onClose={closeMetadata} onSubmit={saveMetadata} busy={metadataBusy} error={metadataError}/>
  <SegmentEditor work={work} shotId={shotId} open={segmentOpen} onOpenChange={setSegmentOpen} api={api} toast={toast} refresh={refresh} onEditClip={editClip} onOpenLogs={openLogs} onBusyChange={setSegmentBusy}/>
  <ExportDialog open={exportOpen} onOpenChange={value=>{if(!exportSubmitting)setExportOpen(value);}} work={work} episodeId={episode?.id||null} capability={exportCapability} onSubmit={submitExport} busy={exportSubmitting} error={exportError}/>
  <ExportHistory work={work} episodeId={episode?.id||null} open={exportHistoryOpen&&Boolean(work)} onOpenChange={setExportHistoryOpen} onPublish={openPublishing}/>
  <PublishingCenter work={work} open={publishingOpen&&Boolean(work)} onOpenChange={setPublishingOpen} selectedExportId={publishingExportId} onExport={exportFilm} api={api} toast={toast}/>
  <WorkArchiveCenter work={work} open={archiveOpen} onOpenChange={setArchiveOpen} api={api} toast={toast} onMaterials={()=>changeTab('materials')} onExport={exportFilm} onPublishing={()=>openPublishing()}/>
  <ProductionLogs work={work} open={logsOpen&&Boolean(work)} onOpenChange={setLogsOpen}/>
  <SkillLibrary open={skillsOpen} onOpenChange={setSkillsOpen} api={api} toast={toast}/>
  {toastState?<div className="studio-toast" role="status" aria-live="polite" aria-atomic="true"><Callout.Root size="1" variant="surface" color={toastState.tone}><Callout.Icon><Info size={18}/></Callout.Icon><Callout.Text>{toastState.message}</Callout.Text><IconButton className="studio-toast-close" variant="ghost" color="gray" size="1" aria-label="关闭提示" onClick={()=>setToastState(null)}><X size={16}/></IconButton></Callout.Root></div>:null}
 </div>;
}
