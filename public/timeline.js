import {formatAudioEnvelope,parseAudioAutomation} from './audio-automation-input.js';
import {exportMode,exportPreviewInfo,isExportCurrent} from './timeline-preview.js';
import {createTimelineTransport,formatTimecode} from './timeline-transport.js';
import {clipReframeSource,normalizeClipReframe,assertReframeExport} from './clip-reframe.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=value=>structuredClone(value);
const decimal=value=>Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:2}):'—';
const time=value=>{if(!Number.isFinite(value))return '—';const minutes=Math.floor(value/60),seconds=value-minutes*60;return `${String(minutes).padStart(2,'0')}:${seconds.toFixed(seconds%1?2:0).padStart(2,'0')}`;};
const stamp=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'—';
const roles={intro:'片头',outro:'片尾'},kinds={voice:'配音',music:'配乐',sfx:'音效'};
const exportLabels={queued:'等待本机合成',running:'本机合成中',succeeded:'成片已就绪',failed:'导出失败',interrupted:'导出已中断'};
const number=(value,label,min,max)=>{const n=Number(value);if(!Number.isFinite(n)||n<min||n>max)throw new Error(`${label}应在 ${min}–${max} 之间`);return n;};
const action=(name,label,extra='',className='button')=>`<button type="button" class="${className}" data-timeline-action="${name}" ${extra}>${label}</button>`;
const emptyTitle=(role,work,episode)=>({id:crypto.randomUUID(),type:'title',role,title:role==='intro'?work.title:'未完待续',subtitle:role==='intro'?episode?.title||'':work.title,duration:2,trimStart:0,muted:false,enabled:true});

/** Artist-facing editor. Drafts live independently of the controller's polling render. */
export function initTimeline({api,toast,refresh,getWork,getEpisodeId,onEditShot}){
  const drafts=new Map(),localMedia=new Map();
  const transport=createTimelineTransport({toast});let boundTransportState=null,boundWorkId=null,boundEpisodeId=null;
  const dialog=document.createElement('dialog');let disposed=false;dialog.className='work-dialog timeline-dialog';document.body.append(dialog);
  dialog.setAttribute('data-timeline-native-dialog','');
  dialog.addEventListener('close',()=>{if(disposed||dialog.open)return;for(const player of dialog.querySelectorAll('audio,video'))player.pause();document.body.append(dialog);});
  // The native modal owns its Tab loop; Radix's outer loop includes inert siblings.
  dialog.addEventListener('keydown',event=>{if(event.key==='Tab')event.stopPropagation();});
  let container=null,lastWork=null,lastEpisode=null,busy=false;
  const key=(workId,episodeId)=>`${workId}/${episodeId}`;
  const currentWork=()=>getWork?.()||lastWork;
  const currentEpisode=()=>getEpisodeId?.()||lastEpisode;
  const media=(work,id)=>(work.studio?.media||[]).find(item=>item.id===id)||localMedia.get(`${work.id}/${id}`);
  const mediaUrl=(work,item)=>`/api/works/${encodeURIComponent(work.id)}/studio/media/${encodeURIComponent(item.id)}`;
  const assetUrl=(work,item)=>`/api/works/${encodeURIComponent(work.id)}/assets/${encodeURIComponent(item.id)}`;
  function stateFor(work,episodeId){
    const saved=work.studio?.timelines?.[episodeId],signature=JSON.stringify(saved||null),id=key(work.id,episodeId);
    let state=drafts.get(id);
    if(!state){const episode=work.episodes.find(item=>item.id===episodeId);state={timeline:clone(saved||{width:1280,height:720,fps:24,clips:[emptyTitle('intro',work,episode),...(work.shots||[]).filter(shot=>shot.episodeId===episodeId&&shot.approvalStatus==='confirmed').map(shot=>({id:crypto.randomUUID(),type:'shot',shotId:shot.id,role:null,title:shot.title,subtitle:'',duration:shot.duration,trimStart:0,muted:false,enabled:true})),emptyTitle('outro',work,episode)],audio:[]}),signature,dirty:false,selectedId:null,selectedExport:null};drafts.set(id,state);}
    else if(!state.dirty&&state.signature!==signature){
      const savedAt=Date.parse(saved?.updatedAt||'')||0,currentAt=Date.parse(state.timeline.updatedAt||'')||0;
      if(savedAt>=currentAt){state.timeline=clone(saved||state.timeline);state.signature=signature;}
    }else if(state.dirty&&saved&&state.signature!==signature){
      // A new shot can be confirmed in another tab while this draft is reordered.
      const additions=saved.clips.filter(item=>item.type==='shot'&&!state.timeline.clips.some(known=>known.id===item.id||known.type==='shot'&&known.shotId===item.shotId));
      for(const item of additions)state.timeline.clips.splice(Math.max(0,state.timeline.clips.length-1),0,clone(item));
      // Keep newly registered voice tracks without restoring a track deleted in this draft.
      const prior=JSON.parse(state.signature||'null'),knownAudio=new Set((prior?.audio||[]).map(item=>item.id));
      state.timeline.audio??=[];
      for(const item of saved.audio||[])if(!knownAudio.has(item.id)&&!state.timeline.audio.some(known=>known.id===item.id))state.timeline.audio.push(clone(item));
      state.signature=signature;
    }
    state.timeline.audio??=[];state.timeline.clips??=[];
    state.playheadSeconds=Math.max(0,Math.min(Number(state.playheadSeconds)||0,total(state.timeline)));
    state.zoomPixelsPerSecond??=45;state.followPlayhead??=true;
    state.previewMode??='full';
    const exports=(work.studio?.exports||[]).filter(job=>job.episodeId===episodeId);
    if(state.pendingExport){const pending=exports.find(job=>job.id===state.pendingExport);if(pending?.status==='succeeded'){state.selectedExport=pending.id;state.previewMode='full';state.pendingExport=null;state.playRequested=true;}else if(['failed','interrupted'].includes(pending?.status))state.pendingExport=null;}
    if(state.previewMode==='full'&&!state.selectedExport){const completed=[...exports].reverse().filter(job=>job.status==='succeeded');state.selectedExport=(completed.find(job=>exportMode(job)==='video')||completed[0])?.id||null;}
    if(!state.timeline.clips.some(item=>item.id===state.selectedId))state.selectedId=state.timeline.clips[0]?.id;
    return state;
  }
  function source(work,clip){
    if(clip.type==='title'&&!clip.mediaId)return {type:'title',ready:true};
    if(clip.type==='shot'){
      const shot=work.shots.find(item=>item.id===clip.shotId),selected=clip.assetId||shot?.selectedAssetId;
      const asset=selected?work.assets.find(item=>item.id===selected&&item.shotId===clip.shotId&&item.type==='video'):[...(work.assets||[])].reverse().find(item=>item.shotId===clip.shotId&&item.type==='video');
      const firstFrame=media(work,shot?.firstFrameMediaId);
      if(!asset&&firstFrame?.type==='image')return {type:'image',ready:false,firstFrame:true,shot,media:firstFrame,url:mediaUrl(work,firstFrame),poster:mediaUrl(work,firstFrame)};
      return {type:'video',ready:Boolean(asset),shot,asset,url:asset?assetUrl(work,asset):null,poster:asset?(asset.posterUrl||assetUrl(work,asset)+'/poster'):null};
    }
    const item=media(work,clip.mediaId);return {type:item?.type,ready:Boolean(item),media:item,url:item?mediaUrl(work,item):null,poster:item?.type==='image'?mediaUrl(work,item):null};
  }
  const total=timeline=>timeline.clips.filter(clip=>clip.enabled!==false).reduce((sum,clip)=>sum+Number(clip.duration||0),0);
  function missing(work,timeline,mode='video'){return timeline.clips.filter(clip=>{if(clip.enabled===false)return false;const src=source(work,clip);if(mode==='storyboard'&&clip.type==='shot')return media(work,src.shot?.firstFrameMediaId)?.type!=='image';return !src.ready||src.shot&&src.shot.approvalStatus!=='confirmed';}).map(clip=>source(work,clip).shot?.title||clip.title||'未命名分镜');}
  function capture({resume=false}={}){const value=transport.capture();if(boundTransportState){boundTransportState.playheadSeconds=value.playheadSeconds;boundTransportState.resumePlayback=Boolean(resume&&value.playing&&boundWorkId===currentWork()?.id&&boundEpisodeId===currentEpisode());}return value;}
  function redraw(){if(!container)return;const work=currentWork(),episodeId=currentEpisode();if(!work||!episodeId)return;const target=container.querySelector('[data-timeline-root]');if(target){capture({resume:true});transport.dispose();for(const player of target.querySelectorAll?.('video,audio')||[])player.pause();target.outerHTML=render(work,episodeId);bind(container);}}
  async function reframeCapability(work){
    try{const response=await api(`/api/works/${work.id}/studio/export-capability`),capability=(response.capability||response).clipReframe;return capability?.available===true?{available:true}:{available:false,message:capability?.message||'当前后台尚未加载重构图功能，请完成服务更新后重新打开剪辑设置。'};}
    catch(error){return {available:false,message:'暂时无法确认重构图能力：'+error.message};}
  }
  async function requireReframeBackend(work,timeline){if(timeline.clips.some(clip=>clip.reframe!==undefined&&clip.reframe!==null)){const capability=await reframeCapability(work);if(!capability.available)throw new Error(capability.message+' 裁切设置未提交。');}}
  async function save(work,episodeId,state,notify=true){
    if(state.timeline.clips.some(clip=>clip.reframe!==undefined&&clip.reframe!==null))await requireReframeBackend(work,state.timeline);
    const response=await api(`/api/works/${work.id}/studio/timeline`,{episodeId,timeline:clone(state.timeline)});
    const saved=response.work?.studio?.timelines?.[episodeId]||response.studio?.timelines?.[episodeId];
    if(saved)state.timeline=clone(saved);
    state.signature=JSON.stringify(saved||state.timeline);state.dirty=false;lastWork=response.work||work;
    await refresh(true);redraw();if(notify)toast('本集时间轴已保存');return response;
  }
  function titlePreview(clip){return `<div class="timeline-title-card"><strong>${esc(clip.title||'标题卡')}</strong>${clip.subtitle?`<p>${esc(clip.subtitle)}</p>`:''}</div>`;}
  function reframePreview(work,state,clip,src){
    const rect=normalizeClipReframe(clip.reframe,{work,clip}),scale=Math.min(1,1280/state.timeline.width,720/state.timeline.height),width=Math.max(2,Math.round(state.timeline.width*scale)),height=Math.max(2,Math.round(state.timeline.height*scale));
    return `<div class="timeline-reframe-player"><canvas data-timeline-reframe="${esc(JSON.stringify(rect))}" width="${width}" height="${height}" role="img" aria-label="按原视频像素裁切的重构图预览"></canvas><p data-reframe-preview-status role="status">重构图预览 · 原图 ${rect.sourceWidth} × ${rect.sourceHeight} px · 裁切 ${rect.x}, ${rect.y}, ${rect.width} × ${rect.height} px</p><video controls preload="auto" src="${esc(src.url)}" data-timeline-trim="${Number(clip.trimStart||0)}" data-timeline-duration="${Number(clip.duration)}" ${clip.muted?'muted':''} aria-label="重构图片段的原片播放控制"></video></div>`;
  }
  function preview(work,state,clip){
    const exported=state.previewMode==='full'&&state.selectedExport&&(work.studio?.exports||[]).find(job=>job.id===state.selectedExport&&job.status==='succeeded');
    if(exported){const info=exportPreviewInfo(exported),current=isExportCurrent(work,state.timeline,exported),storyboard=info.mode==='storyboard',summary=`${decimal(info.durationSeconds)} 秒${info.clipCount===null?'':` · ${info.clipCount} 段画面 · ${info.shotCount} 镜`}`,note=info.independent?`${info.scopeLabel}，仅包含本次选择的画面与声音。完整时间轴保留 ${decimal(total(state.timeline))} 秒、${state.timeline.clips.filter(item=>item.enabled!==false).length} 段画面；使用画面内控件播放试片，下方主时间轴不与试片同步。${storyboard?'静态首帧与计划对白不代表动态镜头已完成。':''}`:storyboard?'静态首帧 + 计划对白，用于核对镜头、节奏和对白；不是动态成片，发布时应明确预演类型。'+(current?'':' 当前显示上次预演，首帧、计划对白或时间轴已改变，请显式重新导出故事板预演。'):current?'从片头连续播放到片尾，包含全部画面与混音。':'时间轴或选用版本有新修改，当前显示上次成片。点击上方“更新并播放整片”查看最新剪辑。';return `<div class="timeline-preview-head"><strong>${info.title}</strong><span>${summary} · ${info.independent?info.scopeLabel:current?'与当前时间轴一致':'上次导出'}</span></div><div class="timeline-preview-canvas"><video data-timeline-full-player controls preload="metadata" src="/api/works/${esc(work.id)}/studio/exports/${esc(exported.id)}/video" aria-label="${storyboard?'故事板预演：静态首帧与计划对白':info.independent?'动态试片：独立试片快照':'完整成片预览'}"></video></div><p class="timeline-preview-note ${!info.independent&&!current?'preview-outdated':''}">${note}</p>`;}
    if(state.previewMode==='full')return `<div class="timeline-preview-head"><strong>整片预览</strong><span>片头 → 正片 → 片尾</span></div><div class="timeline-preview-canvas timeline-full-empty"><strong>${state.pendingExport?'正在准备整片预览…':'从头到尾，看一次完整的故事'}</strong><p>${state.pendingExport?'在本机合成画面与声音，完成后自动切换新成片。':'点击上方“生成整片预览”，合成后可连续播放和下载。'}</p></div>`;
    if(!clip)return '<div class="timeline-preview-canvas timeline-preview-empty">选择一段画面进行预览</div>';
    const src=source(work,clip),title=roles[clip.role]||src.shot?.title||clip.title||'画面';
    let picture=src.type==='title'?titlePreview(clip):(src.ready||src.firstFrame)&&src.type==='image'?`<img src="${esc(src.url)}" alt="${esc(src.firstFrame?'分镜首帧：'+title:title)}" ${src.firstFrame?`data-timeline-first-frame data-first-frame-title="${esc(title)}"`:''}>`:src.ready?`<video controls preload="metadata" src="${esc(src.url)}" ${src.poster?`poster="${esc(src.poster)}"`:''} data-timeline-trim="${Number(clip.trimStart||0)}" data-timeline-duration="${Number(clip.duration)}" ${clip.muted?'muted':''} aria-label="时间轴选中片段预览"></video>`:`<div class="timeline-preview-empty"><strong>${esc(title)}</strong><p>这个分镜已经占位，生成并选择成片后即可预览。</p></div>`;
    let reframed=false,reframeError='';
    if(clip.reframe!==undefined&&clip.reframe!==null){try{if(!src.ready||src.type!=='video')throw new Error('重构图源视频不可用，请检查固定版本或清除重构图。');picture=reframePreview(work,state,clip,src);reframed=true;}catch(error){reframeError=error.message;}}
    return `<div class="timeline-preview-head"><strong>${esc(title)}</strong><span>${clip.enabled===false?'已停用 · ':''}${decimal(clip.duration)} 秒 · ${reframed?'重构图单段预览':src.firstFrame?'分镜首帧／尚未生成视频':'单段预览'}</span></div><div class="timeline-preview-canvas ${reframed?'timeline-reframe-canvas':''}">${picture}</div><p class="timeline-preview-note ${reframeError?'preview-outdated':''}">${reframeError?esc(reframeError)+' 当前仅显示原片，未套用裁切。':reframed?'上方显示裁切画面，下方保留原片的完整播放控件；播放与入点同步。普通视频导出按此矩形裁切后缩放、补黑边，保留原声；暂不支持故事板或 AI 超分。':src.firstFrame?'这是本镜绑定的静态首帧，时间轴占位保留；可导出故事板预演，动态成片仍需真实视频。':src.type==='title'?'标题卡将在本机导出时排版为视频。':src.ready?'预览当前素材；导出按时间轴时长裁剪或补足尾帧，原始文件保留。':'占位时长已保留，尚未生成的镜头会阻止动态成片导出。'}</p>`;
  }
  function inspector(work,state,clip){
    if(state.previewMode==='full'&&!state.inspectorSelection){const exported=(work.studio?.exports||[]).find(job=>job.id===state.selectedExport&&job.status==='succeeded'),info=exportPreviewInfo(exported),independent=info.independent;return `<aside class="timeline-inspector timeline-full-summary"><span class="art-eyebrow">${exported?independent?info.scopeLabel:info.mode==='storyboard'?info.label:'本集整片':'本集整片'}</span><h3>${esc(work.episodes.find(episode=>episode.id===currentEpisode())?.title||work.title)}</h3><p class="muted small">${independent?`${decimal(info.durationSeconds)} 秒试片 · ${info.clipCount===null?'画面段数未记录':`${info.clipCount} 段画面 · ${info.shotCount} 镜`}`:`${decimal(total(state.timeline))} 秒时间轴 · ${state.timeline.clips.filter(item=>item.enabled!==false).length} 段画面`}</p><p class="small">${independent?`${info.mode==='storyboard'?'静态首帧与计划对白的独立预演。':'仅包含独立快照中选择的镜头与声音。'}完整时间轴保留 ${decimal(total(state.timeline))} 秒、${state.timeline.clips.filter(item=>item.enabled!==false).length} 段画面，未替换主时间轴。`:exported?info.mode==='storyboard'?'静态首帧与计划对白的节奏预演，不是动态成片，发布时应明确预演类型。':'整片包含片头、所有启用镜头、片尾和声音轨。':'完善镜头后，即可在这里连续检查完整成片。'}</p>${exported?`<a class="button" href="/api/works/${esc(work.id)}/studio/exports/${esc(exported.id)}/video" download>下载这版 MP4</a>`:''}<p class="muted small">${independent?'使用画面内控件播放试片；主时间轴单击选择、双击处理，不与试片定位同步。':'单击选中并定位，双击片段打开处理面板。'}</p></aside>`;}
    if(!clip)return '<aside class="timeline-inspector"><h3>选择时间轴片段</h3><p class="muted">点击下方片段，预览画面或调整剪辑。</p></aside>';
    const src=source(work,clip),role=roles[clip.role];
    return `<aside class="timeline-inspector timeline-selected-summary"><span class="art-eyebrow">选中片段${role?' · '+role:''}</span><h3>${esc(clip.title||src.shot?.title||role||'未命名片段')}</h3><p class="muted small">${decimal(clip.duration)} 秒${clip.enabled===false?' · 已停用':''}${src.ready?'':' · 等待成片'}</p>${action(clip.type==='shot'&&onEditShot?'open-processing':'edit-clip',clip.type==='shot'?'打开片段处理':'编辑'+(role||'片段'),`data-id="${esc(clip.id)}"`,'button primary')}</aside>`;
  }
  function pendingShots(work,episodeId){
    const pending=work.shots.filter(shot=>shot.episodeId===episodeId&&shot.approvalStatus!=='confirmed');
    if(!pending.length)return '';
    return `<details class="timeline-pending"><summary>待确认分镜 ${pending.length} 个</summary><p class="muted small">拆分后的新分镜已在时间轴占位，请在片段处理面板检查画面和设定，确认后再生产。</p><div class="timeline-pending-list">${pending.map(shot=>action('open-pending',esc(shot.title||'未命名分镜'),`data-shot="${esc(shot.id)}"`,'button')).join('')}</div></details>`;
  }
  function board(work,state){
    const timeline=state.timeline,duration=total(timeline),available=Math.max(240,(container?.querySelector('.timeline-board-wrap')?.clientWidth||830)-110),width=state.zoomPixelsPerSecond===0?available:Math.max(available,duration*state.zoomPixelsPerSecond),step=[1/timeline.fps,.1,.25,.5,1,2,5,10,30,60].find(value=>value*width/Math.max(.01,duration)>=48)||60,ticks=[];
    for(let t=0;t<duration;t+=step)ticks.push(t);ticks.push(duration);
    const playhead=`<div class="editor-playhead" data-editor-playhead aria-hidden="true"></div>`,surface=`data-editor-surface data-editor-duration="${duration}"`;
    let cursor=0;
    const clips=timeline.clips.filter(clip=>clip.enabled!==false).map(clip=>{const src=source(work,clip),unconfirmed=src.shot&&src.shot.approvalStatus!=='confirmed',left=cursor;cursor+=clip.duration;return `<button type="button" data-timeline-action="select-clip" data-id="${esc(clip.id)}" data-editor-clip-start="${left}" data-editor-clip-end="${cursor}" class="timeline-clip ${src.ready&&!unconfirmed?'':'placeholder'} ${clip.role?'title-clip':''} ${state.selectedId===clip.id&&state.inspectorSelection?'selected':''}" data-timeline-left="${duration?left/duration*100:0}%" data-timeline-width="${duration?clip.duration/duration*100:100}%" title="${esc((roles[clip.role]||clip.title)+' · '+decimal(clip.duration)+'秒 · 单击定位，双击处理')}" aria-pressed="${state.selectedId===clip.id&&Boolean(state.inspectorSelection)}">${src.poster?`<img src="${esc(src.poster)}" alt="" loading="lazy" draggable="false">`:''}<span><strong>${esc(roles[clip.role]||clip.title||src.shot?.title||'画面')}</strong><small>${decimal(clip.duration)}s${unconfirmed?(src.shot.approvedAt?' · 待重新确认':' · 待确认'):src.ready?'':' · 待生成'}</small></span></button>`;}).join('');
    const audioRows=Object.entries(kinds).map(([kind,label])=>`<div class="timeline-track ${kind}"><div class="timeline-track-label"><strong>${label}</strong>${action('add-audio','＋',`data-kind="${kind}" aria-label="添加${label}"`,'text-button')}</div><div class="timeline-lane" ${surface} data-timeline-width="${width}px">${timeline.audio.filter(track=>track.kind===kind&&track.enabled!==false).map(track=>{const item=media(work,track.mediaId);return `<button type="button" data-timeline-action="select-audio" data-id="${esc(track.id)}" class="timeline-audio-clip ${kind}" data-timeline-left="${duration?track.start/duration*100:0}%" data-timeline-width="${duration?track.duration/duration*100:100}%" title="${esc(item?.name||label)} · ${decimal(track.start)}秒开始 · 双击编辑"><strong>${esc(item?.name||label)}</strong><small>${decimal(track.duration)}s · ${decimal(track.gain??1)}×${track.loop?' · 循环':''}</small></button>`;}).join('')||`<span class="timeline-track-empty">点击 ＋ 添加${label}，与原声分开管理</span>`}${playhead}</div></div>`).join('');
    const disabled=[...timeline.clips.filter(item=>item.enabled===false).map(item=>action('edit-clip',esc(item.title||roles[item.role]||'画面'),`data-id="${esc(item.id)}"`,'button')),...timeline.audio.filter(item=>item.enabled===false).map(item=>action('edit-audio',esc(media(work,item.mediaId)?.name||kinds[item.kind]),`data-id="${esc(item.id)}"`,'button'))];
    return `${transportBar(work,state)}<div class="timeline-board-wrap" role="region" aria-label="四轨剪辑时间轴，可点击定位或拖动游标" tabindex="0"><div class="timeline-board" data-timeline-min-width="${width+110}px"><div class="timeline-ruler"><div class="timeline-track-label">时间 / 秒</div><div class="timeline-lane" ${surface} data-timeline-width="${width}px">${ticks.map(t=>`<span data-timeline-left="${duration?t/duration*100:0}%">${decimal(t)}</span>`).join('')}${playhead}</div></div><div class="timeline-track video"><div class="timeline-track-label"><strong>视频</strong><small>双击处理片段</small></div><div class="timeline-lane" ${surface} data-timeline-width="${width}px">${clips}${playhead}</div></div>${audioRows}</div></div>${disabled.length?`<div class="timeline-disabled"><span class="muted small">已停用，点开可恢复：</span>${disabled.join('')}</div>`:''}`;
  }
  function transportBar(work,state){
    const duration=total(state.timeline),ready=state.previewMode==='full'&&(work.studio?.exports||[]).some(job=>job.id===state.selectedExport&&job.episodeId===currentEpisode()&&job.status==='succeeded'&&isExportCurrent(work,state.timeline,job));
    const icons={rewind:'<path d="M5 5v14m14-14L8 12l11 7Z"/>','step-back':'<path d="M6 5v14m12-14L8 12l10 7Z"/>','toggle-play':'<path d="m8 5 11 7-11 7Z"/>','step-forward':'<path d="M18 5v14M6 5l10 7-10 7Z"/>'},labels={rewind:'回到开头','step-back':'上一帧','toggle-play':'播放 / 暂停','step-forward':'下一帧'};
    return `<div class="timeline-editor-transport"><div class="editor-play-controls">${Object.keys(icons).map(key=>`<button type="button" class="button icon-button" data-editor-action="${key}" aria-label="${labels[key]}" title="${labels[key]}" ${ready?'':'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg></button>`).join('')}</div><div class="editor-time-display"><time data-editor-timecode>${formatTimecode(state.playheadSeconds,state.timeline.fps)}</time><span>/ ${formatTimecode(duration,state.timeline.fps)}</span></div><div class="editor-zoom">${action('zoom-out','−','aria-label="缩小时间轴" title="缩小时间轴"')}${action('zoom-fit','适应','title="将整集放入可见宽度"')}<select data-editor-zoom aria-label="时间轴缩放"><option value="${state.zoomPixelsPerSecond}">${state.zoomPixelsPerSecond?decimal(state.zoomPixelsPerSecond/45*100)+'%':'适应宽度'}</option>${[22.5,45,90,180].filter(value=>value!==state.zoomPixelsPerSecond).map(value=>`<option value="${value}">${value/45*100}%</option>`).join('')}</select>${action('zoom-in','＋','aria-label="放大时间轴" title="放大时间轴"')}</div><button type="button" class="editor-follow" data-editor-action="follow" aria-pressed="${state.followPlayhead}">跟随播放头</button><input data-editor-position type="range" min="0" max="${duration}" step="${1/state.timeline.fps}" value="${state.playheadSeconds}" aria-label="时间轴播放位置" ${state.previewMode==='clip'||ready?'':'disabled'}><p class="editor-help">${state.previewMode==='clip'?'单击切换片段 / 拖动选择位置 · 双击片段处理 · 片段播放使用画面上的控件':'单击定位 / 拖动查看 · 双击片段处理 · 空格播放暂停 · ← → 逐帧 · Shift + ← → 跳一秒'}</p></div>`;
  }
  function exportsList(work,episodeId){
    const jobs=[...(work.studio?.exports||[])].filter(job=>job.episodeId===episodeId).reverse().slice(0,4);
    return `<section class="timeline-exports"><div class="section-title"><h3>本机导出</h3><span class="muted small">原镜头保留，每次导出单独存档</span></div>${jobs.length?jobs.map(job=>{const info=exportPreviewInfo(job);return `<article class="timeline-export ${esc(job.status)}"><div><strong>${info.mode==='storyboard'||info.independent?info.label+' · '+(job.status==='succeeded'?'已就绪':exportLabels[job.status]||esc(job.status)):exportLabels[job.status]||esc(job.status)}</strong><p class="small ${job.error?'error':'muted'}">${esc(job.message||'等待本机处理')}</p><span class="muted small">${stamp(job.createdAt)}${job.status==='succeeded'?` · ${decimal(info.durationSeconds)} 秒 · ${job.width} × ${job.height}${Number.isFinite(job.productionMs)?' · 本机合成 '+decimal(job.productionMs/1000)+' 秒':''}`:Number.isInteger(job.completedClips)?` · 已完成 ${job.completedClips} / ${job.totalClips} 段`:''}</span></div>${job.status==='succeeded'?`<div class="timeline-export-actions">${action('preview-export',info.mode==='storyboard'?'播放预演':info.independent?'播放动态试片':'播放成片',`data-id="${esc(job.id)}"`)}<a class="button" href="/api/works/${esc(work.id)}/studio/exports/${esc(job.id)}/video" download="${esc(work.title)}-${esc(episodeId)}.mp4">下载 MP4</a></div>`:''}</article>`;}).join(''):'<p class="muted small">保存时间轴后，点击“导出成片”。完整画面和声音在本机合成。</p>'}</section>`;
  }
  function render(work,episodeId){
    lastWork=work;lastEpisode=episodeId;
    if(!episodeId)return '<section data-timeline-root class="timeline-workspace" tabindex="0"><div class="empty">先创建一个分集，再开始剪辑。</div></section>';
    const state=stateFor(work,episodeId),clip=state.timeline.clips.find(item=>item.id===state.selectedId),absent=missing(work,state.timeline),jobs=(work.studio?.exports||[]).filter(job=>job.episodeId===episodeId),running=jobs.some(job=>['queued','running'].includes(job.status)),completed=[...jobs].reverse().filter(job=>job.status==='succeeded'),current=completed.find(job=>exportMode(job)==='video'&&isExportCurrent(work,state.timeline,job)),disabled=absent.length||running||busy||!total(state.timeline),storyboardDisabled=missing(work,state.timeline,'storyboard').length||running||busy||!total(state.timeline);
    const selected=completed.find(job=>job.id===state.selectedExport),info=exportPreviewInfo(selected),independent=state.previewMode==='full'&&info.independent;
    const playLabel=independent?'播放'+info.label:running?'整片合成中…':current?'播放整片':completed.length?'更新并播放整片':'生成整片预览';
    return `<section data-timeline-root class="timeline-workspace" tabindex="0"><div class="timeline-heading"><div><h2>时间轴</h2><p class="muted">先排好画面，再放入配音、配乐和音效。</p></div><div class="timeline-toolbar"><span class="timeline-draft-status ${state.dirty?'dirty':''}">${state.dirty?'有调整尚未保存':'时间轴已保存'}</span>${action('save','保存时间轴',busy?'disabled':'')}${action('export',running?'本机合成中…':'导出成片',`${disabled?'disabled':''}`)}${action('export-storyboard','故事板预演',storyboardDisabled?'disabled':'')}</div></div><div class="timeline-preview-controls"><div class="timeline-preview-tabs" role="tablist" aria-label="预览范围">${action('preview-full',independent?(info.mode==='storyboard'?'静态预演':'试片预览'):'整片',`role="tab" aria-selected="${state.previewMode==='full'}"`,'preview-mode-tab')}${action('preview-clip','当前片段',`role="tab" aria-selected="${state.previewMode==='clip'}"`,'preview-mode-tab')}</div>${action(independent?'play-independent':'play-full','<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>'+playLabel,`${!independent&&disabled?'disabled':''}`,'button primary timeline-play-whole')}</div><div class="timeline-preview-layout"><div class="timeline-preview" data-timeline-preview-id="${esc(state.previewMode==='clip'?clip?.id:'')}">${preview(work,state,clip)}</div>${inspector(work,state,clip)}</div><div class="timeline-board-heading"><div><strong>${time(total(state.timeline))}</strong><span class="muted small"> 总时长 · ${state.timeline.width} × ${state.timeline.height} · ${state.timeline.fps} fps</span></div><span class="muted small">单击定位 / 双击处理片段</span></div>${board(work,state)}${pendingShots(work,episodeId)}${absent.length?`<p class="timeline-warning" role="status">还有 ${absent.length} 个镜头待确认或等待成片：${esc(absent.join('、'))}。确认并补齐成片后可导出。</p>`:''}${exportsList(work,episodeId)}</section>`;
  }
  async function uploadFile(work,file,accepted){
    if(!file||!file.size)throw new Error('请选择一个非空素材文件');
    if(file.size>64*1024*1024)throw new Error('单个素材不能超过 64 MB');
    const extension=file.name.split('.').at(-1).toLowerCase(),types={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',mp4:'video/mp4',wav:'audio/wav',mp3:'audio/mpeg',m4a:'audio/mp4',flac:'audio/flac',ogg:'audio/ogg',aac:'audio/aac'};
    const mime=types[extension]||file.type;
    if(!accepted.includes(mime))throw new Error('素材格式不支持，请选择界面列出的图片、音频或 MP4');
    const response=await fetch(`/api/works/${work.id}/studio/media?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':mime},body:file,signal:AbortSignal.timeout(120_000)});
    const value=await response.json().catch(()=>({error:'本机没有返回有效的素材信息'}));if(!response.ok)throw new Error(value.error||value.message||'素材上传失败');
    if(!value.media?.id)throw new Error('上传完成，但未取得素材编号');
    localMedia.set(`${work.id}/${value.media.id}`,value.media);lastWork=value.work||work;return value.media;
  }
  function openDialog(title,body,saveLabel,onSubmit,{dialogParent}={}){
    dialog.innerHTML=`<form><div class="dialog-title"><h2>${esc(title)}</h2><button type="button" class="close" data-close aria-label="关闭">×</button></div>${body}<p class="error" data-timeline-form-error role="alert"></p><div class="dialog-actions"><button type="button" class="button" data-close>取消</button><button type="submit" class="button primary">${esc(saveLabel)}</button></div></form>`;
    for(const button of dialog.querySelectorAll('[data-close]'))button.onclick=()=>dialog.close();
    dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('[type=submit]'),error=dialog.querySelector('[data-timeline-form-error]');button.disabled=true;error.textContent='';try{await onSubmit(new FormData(event.target),event.target,error);dialog.close();}catch(failure){error.textContent=failure.message;}finally{button.disabled=false;}};
    // Keep this imperative node inside an existing Radix focus/aria scope.
    const parent=dialogParent?.ownerDocument===document&&dialogParent.isConnected&&dialogParent.matches?.('[role="dialog"]')?dialogParent:document.body;
    parent.append(dialog);dialog.removeAttribute('aria-hidden');dialog.removeAttribute('data-aria-hidden');
    try{dialog.showModal();dialog.querySelector('input,textarea,select')?.focus();}catch(error){document.body.append(dialog);throw error;}
  }
  async function editClip(work,episodeId,state,clip,{dialogParent}={}){
    const capability=clip.type==='shot'?await reframeCapability(work):{available:false};
    if(disposed||currentWork()?.id!==work.id||currentEpisode()!==episodeId)return false;
    const src=source(work,clip),role=roles[clip.role],originalType=clip.type;
    const visuals=(work.studio?.media||[]).filter(item=>['image','video'].includes(item.type)),bodyClips=state.timeline.clips.filter(item=>!item.role),bodyPosition=bodyClips.findIndex(item=>item.id===clip.id);
    const pinned={...clip,assetId:clip.assetId||src.asset?.id};let measured=null,reframeError='';
    if(clip.type==='shot'){try{measured=clipReframeSource(work,pinned);}catch(error){reframeError=error.message;}}
    const active=clip.reframe!==undefined&&clip.reframe!==null,rect=active?clip.reframe:{x:0,y:0,width:measured?.width??'',height:measured?.height??''},versionIndex=src.shot?.assetIds?.indexOf(pinned.assetId)??-1,reframeVersionLabel=versionIndex>=0?`版本 ${versionIndex+1}`:'当前选用版本';
    const reframeFields=clip.type==='shot'?(capability.available?`<fieldset class="timeline-reframe-settings"><legend>重构图 / 裁切画面</legend><label class="timeline-reframe-toggle"><input type="checkbox" name="reframeEnabled" ${active?'checked':''} ${!measured&&!active?'disabled':''}>启用原视频像素裁切</label><p class="muted small">${measured?`原视频实测 ${measured.width} × ${measured.height} px；启用并保存时固定为${esc(reframeVersionLabel)}。`:esc(reframeError)}</p><fieldset data-reframe-fields ${active&&measured?'':'disabled'}><div class="form-row"><label>左上角 X（px）<input type="number" name="reframeX" min="0" max="${measured?.width??32768}" step="1" value="${esc(rect.x)}" required></label><label>左上角 Y（px）<input type="number" name="reframeY" min="0" max="${measured?.height??32768}" step="1" value="${esc(rect.y)}" required></label></div><div class="form-row"><label>裁切宽度（px）<input type="number" name="reframeWidth" min="2" max="${measured?.width??32768}" step="1" value="${esc(rect.width)}" required></label><label>裁切高度（px）<input type="number" name="reframeHeight" min="2" max="${measured?.height??32768}" step="1" value="${esc(rect.height)}" required></label></div></fieldset><p class="muted small">坐标从原视频左上角计算，使用整数像素。只影响本集该片段，原文件保留；普通视频导出先裁切再缩放、补黑边并保留原声，暂不支持故事板预演或 AI 超分。关闭后清除裁切，已固定的视频版本仍保留；取消不改片段或视频版本。</p></fieldset>`:`<p class="timeline-reframe-unavailable muted small" role="status">${esc(capability.message)}${active?' 已有裁切保留；后台支持前不会提交带裁切的保存或导出。':''}</p>`):'';
    openDialog('编辑'+(role||'片段'),`<label>名称 / 标题<input name="title" value="${esc(clip.title)}" maxlength="180" required></label>${role?`<label>副标题<textarea name="subtitle" rows="2" maxlength="500">${esc(clip.subtitle||'')}</textarea></label><fieldset class="timeline-source-choice"><legend>画面来源</legend><label><input type="radio" name="source" value="current" checked> ${src.type==='title'?'文字标题卡':esc(src.media?.name||'当前素材')}</label>${src.type!=='title'?'<label><input type="radio" name="source" value="title">恢复为文字标题卡</label>':''}${visuals.length?`<label>改用已导入画面<select name="existingMedia"><option value="">保留当前画面</option>${visuals.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></label>`:''}<label>上传替换图片 / MP4<input name="replacement" type="file" accept="image/png,image/jpeg,image/webp,video/mp4"></label><p class="muted small">选择文件后替换当前画面；标题仍作为时间轴名称保留。最大 64 MB。</p></fieldset>`:''}<div class="form-row"><label>占用时长（秒）<input type="number" name="duration" min="0.05" max="600" step="0.01" value="${Number(clip.duration)}" required></label><label>素材入点（秒）<input type="number" name="trimStart" min="0" max="600" step="0.01" value="${Number(clip.trimStart||0)}" required></label></div>${reframeFields}<div class="timeline-checkboxes"><label><input type="checkbox" name="muted" ${clip.muted?'checked':''}>关闭片段原声</label><label><input type="checkbox" name="enabled" ${clip.enabled===false?'':'checked'}>用于本次成片</label></div><p class="muted small">${role?'片头片尾保持在整片首尾，可随时修改。':'调整只影响本集时间轴，不改写原始分镜或视频。'}</p>${!role?`<label>正文顺序<select name="bodyPosition">${bodyClips.map((item,index)=>`<option value="${index}" ${index===bodyPosition?'selected':''}>第 ${index+1} 段</option>`).join('')}</select></label>`:''}`,'保存片段',async(form,element,error)=>{
      const next={...clip,title:String(form.get('title')).trim(),subtitle:String(form.get('subtitle')??clip.subtitle??''),duration:number(form.get('duration'),'时长',0.05,600),trimStart:number(form.get('trimStart'),'入点',0,600),muted:form.has('muted'),enabled:form.has('enabled')};
      if(originalType==='shot'&&capability.available){
        if(form.has('reframeEnabled')){
          if(!measured)throw new Error(reframeError||'源视频缺少实测宽高，请先补测该视频版本');
          const pixel=(name,label)=>{const value=String(form.get(name)??'');if(!/^(0|[1-9]\d*)$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error(label+'须为整数源像素');return Number(value);};
          const nextRect={sourceWidth:measured.width,sourceHeight:measured.height,x:pixel('reframeX','X'),y:pixel('reframeY','Y'),width:pixel('reframeWidth','宽度'),height:pixel('reframeHeight','高度')};
          next.reframe=normalizeClipReframe(nextRect,{work:currentWork(),clip:{...next,assetId:pinned.assetId}});next.assetId=pinned.assetId;
        }else delete next.reframe;
      }
      const file=element.querySelector('[name=replacement]')?.files[0];
      if(file){error.textContent='正在上传并校验替换素材…';const item=await uploadFile(work,file,['image/png','image/jpeg','image/webp','video/mp4']);next.type='media';next.mediaId=item.id;next.trimStart=item.type==='image'?0:next.trimStart;}
      else if(form.get('existingMedia')){const item=media(work,String(form.get('existingMedia')));if(!item||!['image','video'].includes(item.type))throw new Error('已选画面素材不存在');next.type='media';next.mediaId=item.id;if(item.type==='image')next.trimStart=0;}
      else if(form.get('source')==='title'){next.type='title';delete next.mediaId;next.trimStart=0;}
      else next.type=originalType;
      state.timeline.clips=state.timeline.clips.map(item=>item.id===clip.id?next:item);if(!role){const position=number(form.get('bodyPosition'),'正文顺序',0,Math.max(0,bodyClips.length-1)),oldIndex=state.timeline.clips.findIndex(item=>item.id===clip.id);state.timeline.clips.splice(oldIndex,1);state.timeline.clips.splice(position+1,0,next);}state.dirty=true;state.selectedExport=null;error.textContent='正在保存时间轴…';await save(work,episodeId,state,false);toast((role||'片段')+'已保存');
    },{dialogParent});
    if(clip.type==='shot'&&capability.available){
      const toggle=dialog.querySelector('[name=reframeEnabled]'),fields=dialog.querySelector('[data-reframe-fields]');
      // New fields are only a dialog draft. Pinning happens after validation on save.
      toggle.onchange=()=>{fields.disabled=!toggle.checked||!measured;};
    }
  }
  function editAudio(work,episodeId,state,kind,track){
    const available=[...(work.studio?.media||[]),...[...localMedia.entries()].filter(([key])=>key.startsWith(work.id+'/')).map(([,item])=>item)].filter((item,index,all)=>item.type==='audio'&&all.findIndex(other=>other.id===item.id)===index);
    const length=total(state.timeline),defaultMedia=media(work,track?.mediaId)||available[0];
    if(!length){toast('先启用一段画面，再添加声音');return;}
    openDialog((track?'编辑':'添加')+kinds[kind],`<label>声音素材<select name="mediaId"><option value="">选择已导入的声音</option>${available.map(item=>`<option value="${esc(item.id)}" ${(track?.mediaId||defaultMedia?.id)===item.id?'selected':''}>${esc(item.name)} · ${decimal(item.duration)} 秒</option>`).join('')}</select></label><audio class="timeline-audio-audition" controls preload="metadata" ${defaultMedia?`src="${esc(mediaUrl(work,defaultMedia))}"`:''} aria-label="试听声音素材"></audio><label>或上传新声音<input name="upload" type="file" accept="audio/wav,audio/mpeg,audio/mp4,audio/flac,audio/ogg,audio/aac,.wav,.mp3,.m4a,.flac,.ogg,.aac"></label><p class="muted small">本机保存，支持 WAV、MP3、M4A、FLAC、OGG、AAC，最大 64 MB。</p><div class="form-row"><label>从整片第几秒开始<input type="number" name="start" min="0" max="${length}" step="0.01" value="${track?.start??0}" required></label><label>素材入点（秒）<input type="number" name="trimStart" min="0" max="600" step="0.01" value="${track?.trimStart??0}" required></label></div><div class="form-row"><label>播放时长（秒）<input type="number" name="duration" min="0.05" max="${length}" step="0.01" value="${track?.duration??Math.min(length,defaultMedia?.duration??4)}" required></label><label>音量（0–2 倍）<input type="number" name="gain" min="0" max="2" step="0.05" value="${track?.gain??(kind==='music'?0.3:1)}" required></label></div><div class="form-row"><label>淡入（秒）<input type="number" name="fadeIn" min="0" max="600" step="0.01" value="${track?.fadeIn??0}"></label><label>淡出（秒）<input type="number" name="fadeOut" min="0" max="600" step="0.01" value="${track?.fadeOut??0}"></label></div><details><summary>音量变化 / 对白让位</summary><label>相对本条声音起点，每行：秒数, 音量倍数<textarea name="envelope" rows="5" placeholder="0, 1&#10;1, 0.25&#10;3, 0.25&#10;4, 1">${esc(formatAudioEnvelope(track?.envelope))}</textarea></label><p class="muted small">控制点间平滑变化，末点后保持。例子在第 1–3 秒降低配乐音量；实际按你填入的时长设置。这是手工包络，不会自动检测对白；试听原素材不包含导出混音效果。</p></details><div class="timeline-checkboxes"><label><input name="loop" type="checkbox" ${track?.loop?'checked':''}>循环播放素材</label><label><input name="enabled" type="checkbox" ${track?.enabled===false?'':'checked'}>用于本次成片</label></div>${track?`<div class="timeline-remove-row">${action('remove-audio','从时间轴移除此声音',`data-id="${esc(track.id)}"`,'text-button')}<span class="muted small">原素材文件保留</span></div>`:''}`,'保存'+kinds[kind],async(form,element,error)=>{
      let selected=media(work,String(form.get('mediaId'))),file=element.querySelector('[name=upload]').files[0];
      if(file){error.textContent='正在上传并校验声音…';selected=await uploadFile(work,file,['audio/wav','audio/x-wav','audio/mpeg','audio/mp4','audio/flac','audio/ogg','audio/aac']);}
      if(!selected)throw new Error('请选择声音素材，或上传一个新文件');
      const start=number(form.get('start'),'开始位置',0,length),trimStart=number(form.get('trimStart'),'入点',0,600),loop=form.has('loop');
      let duration=number(form.get('duration'),'声音时长',0.05,length);
      if(!track)duration=Math.min(duration,length-start,loop?duration:Math.max(0,(selected.duration??duration)-trimStart));
      if(duration<0.05||start+duration>length+0.001)throw new Error('声音位置超出片尾，请调整开始位置或时长');
      if(trimStart>=selected.duration||!loop&&trimStart+duration>selected.duration+0.1)throw new Error('声音裁切超出素材时长，请缩短时长或开启循环');
      const next={id:track?.id||crypto.randomUUID(),kind,mediaId:selected.id,start,trimStart,duration,gain:number(form.get('gain'),'音量',0,2),...parseAudioAutomation({fadeIn:form.get('fadeIn'),fadeOut:form.get('fadeOut'),envelope:form.get('envelope')},duration),loop,enabled:form.has('enabled')};
      if(track)state.timeline.audio=state.timeline.audio.map(item=>item.id===track.id?next:item);else state.timeline.audio.push(next);
      state.dirty=true;error.textContent='正在保存声音轨道…';await save(work,episodeId,state,false);toast(kinds[kind]+'已保存到本集时间轴');
    });
    dialog.querySelector('[name=mediaId]').onchange=event=>{const item=media(work,event.target.value),audio=dialog.querySelector('.timeline-audio-audition');audio.pause();if(item)audio.src=mediaUrl(work,item);else audio.removeAttribute('src');audio.load();};
    dialog.querySelector('[data-timeline-action=remove-audio]')?.addEventListener('click',async event=>{event.target.disabled=true;try{state.timeline.audio=state.timeline.audio.filter(item=>item.id!==track.id);state.dirty=true;await save(work,episodeId,state,false);dialog.close();toast('已从时间轴移除声音，原文件保留');}catch(error){dialog.querySelector('[data-timeline-form-error]').textContent=error.message;event.target.disabled=false;}});
  }
  async function requestExport(work,episodeId,state,exportOptions){
    if(!total(state.timeline))throw new Error('请先在时间轴启用画面');
    const mode=exportOptions?.mode==='storyboard'?'storyboard':'video';
    assertReframeExport(state.timeline,{...exportOptions,mode});
    if(mode==='storyboard'&&exportOptions?.enhance==='ai-1080p')throw new Error('故事板预演只使用真实静态首帧，不支持 AI 超分');
    const absent=missing(work,state.timeline,mode);if(absent.length)throw new Error((mode==='storyboard'?'故事板预演缺少本镜绑定首帧：':'先补齐成片：')+absent.join('、'));
    if((work.studio?.exports||[]).some(job=>job.episodeId===episodeId&&['queued','running'].includes(job.status)))throw new Error('本集正在合成，完成后会更新整片预览');
    if(state.dirty)await save(work,episodeId,state,false);else if(state.timeline.clips.some(clip=>clip.reframe!==undefined&&clip.reframe!==null))await requireReframeBackend(work,state.timeline);
    const result=await api(`/api/works/${work.id}/studio/export`,{episodeId,...(exportOptions===undefined?{}:{exportOptions})});
    if(!result.exportJob?.id)throw new Error('导出服务没有返回任务编号，请刷新后核对任务列表。');
    state.pendingExport=result.exportJob.id;state.previewMode='full';
    // An accepted task stays accepted if only the follow-up status read fails.
    try{await refresh(true);}catch{toast('导出任务已提交，状态暂时无法同步；稍后会自动重新读取。');}
    if(exportOptions===undefined)toast('正在本机更新整片预览，完成后自动切换；可以继续处理镜头。');
    return result;
  }
  async function exportWithOptions(exportOptions){
    if(busy)throw new Error('时间轴仍在保存或提交，请稍后重试。');
    const work=currentWork(),episodeId=currentEpisode();if(!work||!episodeId)throw new Error('请先选择作品与分集。');
    const state=stateFor(work,episodeId),options=exportOptions===undefined?undefined:clone(exportOptions);
    pauseEditor();busy=true;
    try{return await requestExport(work,episodeId,state,options);}finally{busy=false;redraw();}
  }
  async function handleClick(event){
    const button=event.target.closest?.('[data-timeline-action]');if(!button)return false;
    const work=currentWork(),episodeId=currentEpisode();if(!work||!episodeId)return true;
    const state=stateFor(work,episodeId),name=button.dataset.timelineAction,id=button.dataset.id,clip=state.timeline.clips.find(item=>item.id===id);
    if(name==='play-independent'){
      const exported=work.studio?.exports?.find(job=>job.id===state.selectedExport),player=container?.querySelector('[data-timeline-full-player]');
      if(player&&exportPreviewInfo(exported).independent){if(player.ended)player.currentTime=0;try{await player.play();}catch{toast('请点击试片画面内的播放键。');}}
      return true;
    }
    if(name==='select-clip'){
      state.selectedId=id;state.inspectorSelection=true;updateSelection(work,state);
      if(clip?.enabled===false)return true;
      const start=state.timeline.clips.filter(item=>item.enabled!==false).slice(0,state.timeline.clips.filter(item=>item.enabled!==false).findIndex(item=>item.id===id)).reduce((sum,item)=>sum+item.duration,0);
      transport.seek(start);return true;
    }
    if(name==='select-audio'){const track=state.timeline.audio.find(item=>item.id===id);if(track)transport.seek(track.start);return true;}
    if(['open-processing','open-pending','edit-clip','add-audio','edit-audio'].includes(name))pauseEditor();
    try{
      if(name==='preview-full'){state.previewMode='full';state.inspectorSelection=false;}
      else if(name==='preview-clip'){pauseEditor();state.previewMode='clip';state.selectedExport=null;}
      else if(name==='play-full'){
        const absent=missing(work,state.timeline);if(absent.length)throw new Error('先补齐成片：'+absent.join('、'));
        const current=[...(work.studio?.exports||[])].reverse().find(job=>job.episodeId===episodeId&&job.status==='succeeded'&&exportMode(job)==='video'&&isExportCurrent(work,state.timeline,job));
        if(current){
          state.selectedExport=current.id;state.previewMode='full';state.inspectorSelection=false;
          const player=container?.querySelector('[data-timeline-full-player]');
          if(player?.ended||state.playheadSeconds>=total(state.timeline)-.01){
            // Redraw captures the mounted player; reset its time before that capture.
            if(player)try{player.currentTime=0;}catch{}
            state.playheadSeconds=0;
          }
          state.playRequested=true;
        }
        else{busy=true;button.disabled=true;await requestExport(work,episodeId,state);}
      }
      else if(name==='open-processing'&&clip?.type==='shot'){if(onEditShot)await onEditShot(clip.shotId,clip.id);else await editClip(work,episodeId,state,clip);}
      else if(name==='open-pending'){if(onEditShot)await onEditShot(button.dataset.shot,null);else toast('请先在分镜处理面板确认这个分镜');}
      else if(name==='edit-clip'&&clip)await editClip(work,episodeId,state,clip);
      else if(['zoom-in','zoom-out','zoom-fit'].includes(name)){
        const width=container?.querySelector('.timeline-board-wrap')?.clientWidth||830,currentScale=state.zoomPixelsPerSecond||Math.max(10,(width-110)/Math.max(1,total(state.timeline)));
        state.zoomPixelsPerSecond=name==='zoom-fit'?0:Math.min(360,Math.max(10,currentScale*(name==='zoom-in'?1.5:1/1.5)));
      }
      else if(name==='move-left'||name==='move-right'){
        const index=state.timeline.clips.findIndex(item=>item.id===id),next=index+(name==='move-left'?-1:1);
        if(clip&&!clip.role&&next>0&&next<state.timeline.clips.length-1){[state.timeline.clips[index],state.timeline.clips[next]]=[state.timeline.clips[next],state.timeline.clips[index]];state.dirty=true;state.selectedExport=null;redraw();}
      }else if(name==='save'){busy=true;button.disabled=true;await save(work,episodeId,state);}
      else if(name==='export'){
        const absent=missing(work,state.timeline);if(absent.length)throw new Error('先补齐成片：'+absent.join('、'));
        busy=true;button.disabled=true;if(state.dirty)await save(work,episodeId,state,false);
        await requestExport(work,episodeId,state);
      }else if(name==='export-storyboard'){busy=true;button.disabled=true;await requestExport(work,episodeId,state,{mode:'storyboard',enhance:'none'});}else if(name==='add-audio')editAudio(work,episodeId,state,button.dataset.kind||'voice',null);
      else if(name==='edit-audio'){const track=state.timeline.audio.find(item=>item.id===id);if(track)editAudio(work,episodeId,state,track.kind,track);}
      else if(name==='preview-export'){state.selectedExport=id;state.previewMode='full';state.inspectorSelection=false;if(!exportPreviewInfo(work.studio?.exports?.find(job=>job.id===id)).independent)state.playheadSeconds=0;state.playRequested=true;}
    }catch(error){toast(error.message);}finally{busy=false;redraw();}
    return true;
  }
  function pauseEditor(){for(const player of container?.querySelectorAll('[data-timeline-trim],[data-timeline-full-player]')||[])player.pause();capture({resume:false});if(boundTransportState)boundTransportState.resumePlayback=false;}
  function updateSelection(work,state){
    if(!container)return;
    for(const button of container.querySelectorAll('[data-timeline-action="select-clip"]')){const selected=button.dataset.id===state.selectedId&&state.inspectorSelection;button.classList.toggle('selected',Boolean(selected));button.setAttribute('aria-pressed',String(Boolean(selected)));}
    const old=container.querySelector('.timeline-inspector'),clip=state.timeline.clips.find(item=>item.id===state.selectedId);
    if(old)old.outerHTML=inspector(work,state,clip);
    const picture=container.querySelector('.timeline-preview');
    if(state.previewMode==='clip'&&picture&&picture.dataset.timelinePreviewId!==(clip?.id||'')){
      for(const player of picture.querySelectorAll('video,audio'))player.pause();
      picture.innerHTML=preview(work,state,clip);
      picture.dataset.timelinePreviewId=clip?.id||'';
      bindClipMedia(picture);
    }
  }
  function selectAtTime(work,state,seconds){
    let cursor=0;const clips=state.timeline.clips.filter(item=>item.enabled!==false);
    const clip=clips.find((item,index)=>{const start=cursor;cursor+=item.duration;return seconds>=start&&(seconds<cursor||index===clips.length-1&&seconds===cursor);});
    if(clip&&(state.selectedId!==clip.id||!state.inspectorSelection)){state.selectedId=clip.id;state.inspectorSelection=true;updateSelection(work,state);}
  }
  function bindClipMedia(root){
    for(const image of root.querySelectorAll('[data-timeline-first-frame]'))image.addEventListener('error',()=>{const canvas=image.parentElement;if(canvas)canvas.innerHTML=`<div class="timeline-preview-empty"><strong>${esc(image.dataset.firstFrameTitle||'分镜')}</strong><p>绑定首帧暂不可用，保留文字占位；请在片段处理中检查原图片。</p></div>`;},{once:true});
    for(const video of root.querySelectorAll('[data-timeline-trim]')){
      const start=Number(video.dataset.timelineTrim)||0,length=Number(video.dataset.timelineDuration)||0;
      const reset=()=>{if(start>0&&Number.isFinite(video.duration))video.currentTime=Math.min(start,Math.max(0,video.duration-.01));};
      video.addEventListener('loadedmetadata',reset,{once:true});if(video.readyState>=1)reset();
      video.addEventListener('play',()=>{if(video.currentTime<start||video.currentTime>=start+length-.01)video.currentTime=start;});
      video.addEventListener('timeupdate',()=>{if(length&&video.currentTime>=start+length){video.pause();}});
      const canvas=video.parentElement?.querySelector('[data-timeline-reframe]');
      if(canvas&&!video.dataset.reframePreviewBound){
        video.dataset.reframePreviewBound='true';
        const rect=JSON.parse(canvas.dataset.timelineReframe),status=video.parentElement.querySelector('[data-reframe-preview-status]'),initial=status?.textContent,view=video.ownerDocument?.defaultView||globalThis;
        let context=null,frame=null,videoFrames=false;
        try{context=canvas.getContext('2d');}catch{}
        if(!context){if(status)status.textContent='浏览器暂不支持裁切预览；下方原片控件仍可播放，导出前请核对裁切坐标。';continue;}
        const paint=()=>{
          if(video.readyState<2)return;
          context.fillStyle='#000';context.fillRect(0,0,canvas.width,canvas.height);
          if(video.videoWidth!==rect.sourceWidth||video.videoHeight!==rect.sourceHeight){if(status)status.textContent='源视频实际尺寸与裁切记录不符，未绘制重构图；请补测并重新设置。';return;}
          const scale=Math.min(canvas.width/rect.width,canvas.height/rect.height),width=Math.max(2,Math.floor(rect.width*scale/2)*2),height=Math.max(2,Math.floor(rect.height*scale/2)*2);
          try{context.drawImage(video,rect.x,rect.y,rect.width,rect.height,(canvas.width-width)/2,(canvas.height-height)/2,width,height);if(status)status.textContent=initial;}catch{if(status)status.textContent='裁切画面暂未就绪，请使用下方控件重新播放或定位。';}
        };
        const cancel=()=>{if(frame!==null){if(videoFrames)video.cancelVideoFrameCallback?.(frame);else view.cancelAnimationFrame?.(frame);frame=null;}};
        const schedule=()=>{if(video.paused||video.ended||frame!==null)return;const next=()=>{frame=null;paint();schedule();};videoFrames=typeof video.requestVideoFrameCallback==='function';frame=videoFrames?video.requestVideoFrameCallback(next):view.requestAnimationFrame?.(next)??null;};
        for(const name of ['loadeddata','seeked','timeupdate'])video.addEventListener(name,paint);
        video.addEventListener('play',()=>{paint();schedule();});
        for(const name of ['pause','ended'])video.addEventListener(name,()=>{cancel();paint();});
        video.addEventListener('error',()=>{cancel();if(status)status.textContent='原视频暂不可用，无法预览重构图；请检查该视频版本。';});
        paint();if(!video.paused)schedule();
      }
    }
  }
  function bind(nextContainer){
    container=nextContainer;
    // Set numeric layout through CSSOM: inline style attributes are forbidden by CSP.
    for(const element of container.querySelectorAll('[data-timeline-left],[data-timeline-width],[data-timeline-min-width]')){
      for(const [key,property] of [['timelineLeft','left'],['timelineWidth','width'],['timelineMinWidth','minWidth']]){
        const value=element.dataset[key];
        if(value&&/^(?:\d+(?:\.\d+)?)(?:px|%)$/.test(value))element.style[property]=value;
      }
    }
    bindClipMedia(container);
    const player=container.querySelector('[data-timeline-full-player]'),work=currentWork(),episodeId=currentEpisode();
    if(work&&episodeId){
      const state=stateFor(work,episodeId),exported=(work.studio?.exports||[]).find(job=>job.id===state.selectedExport&&job.status==='succeeded');
      if(exportPreviewInfo(exported).independent){state.playing=false;state.resumePlayback=false;}
      boundTransportState=state;boundWorkId=work.id;boundEpisodeId=episodeId;
      transport.bind(container,{state,duration:total(state.timeline),fps:state.timeline.fps,selectionOnly:state.previewMode==='clip'||exportPreviewInfo(exported).independent,canSeek:Boolean(player&&exported&&isExportCurrent(work,state.timeline,exported)),onSeek:seconds=>selectAtTime(work,state,seconds),onNeedPreview:(seconds,{play=false}={})=>{
        const current=[...(work.studio?.exports||[])].reverse().find(job=>job.episodeId===episodeId&&job.status==='succeeded'&&exportMode(job)==='video'&&isExportCurrent(work,state.timeline,job));
        if(current&&state.previewMode!=='full'){state.selectedExport=current.id;state.previewMode='full';state.playheadSeconds=seconds;state.playRequested=play;redraw();}
        else if(exportPreviewInfo(exported).independent){state.playheadSeconds=seconds;state.playing=false;selectAtTime(work,state,seconds);toast('下方为完整时间轴；独立试片请用画面内控件播放，不与主时间轴同步。');}
        else toast('整片预览需要更新，请点击上方“更新并播放整片”，再在时间轴定位。');
      }});
      const zoom=container.querySelector('[data-editor-zoom]');if(zoom)zoom.onchange=()=>{const scale=Number(zoom.value);if(Number.isFinite(scale)&&scale>=0&&scale<=360){state.zoomPixelsPerSecond=scale;redraw();}};
      container.ondblclick=async event=>{
        const button=event.target.closest?.('[data-timeline-action="select-clip"],[data-timeline-action="select-audio"]');if(!button)return;
        event.preventDefault();event.stopPropagation();pauseEditor();
        if(button.dataset.timelineAction==='select-audio'){const track=state.timeline.audio.find(item=>item.id===button.dataset.id);if(track)editAudio(work,episodeId,state,track.kind,track);}
        else{const clip=state.timeline.clips.find(item=>item.id===button.dataset.id);if(!clip)return;state.selectedId=clip.id;state.inspectorSelection=true;updateSelection(work,state);if(clip.type==='shot'&&onEditShot)await onEditShot(clip.shotId,clip.id);else await editClip(work,episodeId,state,clip);}
      };
      if(player&&state.playRequested){state.playRequested=false;if(!document.querySelector('dialog[open]'))player.play().catch(()=>toast('整片已就绪，点击播放器中的播放键即可连续观看。'));}
    }else{transport.dispose();boundTransportState=null;}
  }
  function dispose(){if(disposed)return;disposed=true;pauseEditor();transport.dispose();if(dialog.open)dialog.close();dialog.remove();if(container)container.ondblclick=null;container=null;boundTransportState=null;}
  return {render,handleClick,bind,capture,exportWithOptions,dispose,editClip:async(clipId,options)=>{const work=currentWork(),episodeId=currentEpisode();if(!work||!episodeId)return false;pauseEditor();const state=stateFor(work,episodeId),clip=state.timeline.clips.find(item=>item.id===clipId);if(!clip)return false;await editClip(work,episodeId,state,clip,options);return true;}};
}
