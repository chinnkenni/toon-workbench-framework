const finite=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const PLAY_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>';
const PAUSE_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';

export function clampTimelineTime(value,duration){
  return Math.max(0,Math.min(Math.max(0,finite(duration)),finite(value)));
}

/** getBoundingClientRect already includes horizontal scrolling. */
export function timelineTimeAtPointer(clientX,rect,duration){
  if(!rect||!(rect.width>0))return 0;
  return clampTimelineTime((finite(clientX)-rect.left)/rect.width*duration,duration);
}

export function formatTimelineTimecode(seconds,fps=24){
  fps=Math.max(1,Math.round(finite(fps,24)));
  // Chromium can truncate currentTime to six decimals after an exact-frame
  // seek. Tolerate that microsecond loss without rounding normal playback.
  const frames=Math.max(0,Math.floor(finite(seconds)*fps+1e-4));
  const whole=Math.floor(frames/fps);
  return [Math.floor(whole/3600),Math.floor(whole/60)%60,whole%60,frames%fps].map(value=>String(value).padStart(2,'0')).join(':');
}

export const formatTimecode=formatTimelineTimecode;

export function timelineFollowScroll({scrollLeft=0,viewportWidth=0,playheadOffset=0,contentWidth=0,padding=64}){
  scrollLeft=Math.max(0,finite(scrollLeft));
  const width=Math.max(0,finite(viewportWidth)),edge=Math.min(Math.max(0,finite(padding)),width/3);
  const maximum=Math.max(0,finite(contentWidth)-width);
  if(playheadOffset<scrollLeft+edge)return Math.max(0,Math.min(maximum,playheadOffset-edge));
  if(playheadOffset>scrollLeft+width-edge)return Math.max(0,Math.min(maximum,playheadOffset-width+edge));
  return Math.min(scrollLeft,maximum);
}

/** One transport owns the currently mounted timeline. It never samples stale exports. */
export function createTimelineTransport({toast=()=>{}}={}){
  let cleanup=[],container=null,context=null,player=null,frame=null,view=null,restored=false,drag=null,suppressClickUntil=0;
  let lastCapture={playheadSeconds:0,playing:false};
  const valid=()=>Boolean(context?.canSeek&&player);
  const duration=()=>Math.max(0,finite(context?.duration));
  const fps=()=>Math.max(1,Math.round(finite(context?.fps,24)));
  const now=()=>view?.performance?.now?.()??Date.now();
  const queryAll=selector=>Array.from(container?.querySelectorAll(selector)||[]);
  function listen(target,name,handler,options){
    target?.addEventListener?.(name,handler,options);
    cleanup.push(()=>target?.removeEventListener?.(name,handler,options));
  }
  function stopFrame(){if(frame!==null){view?.cancelAnimationFrame?.(frame);frame=null;}}
  function requestFrame(){if(frame===null&&context?.state.playing&&view?.requestAnimationFrame)frame=view.requestAnimationFrame(tick);}
  function update({follow=false,notify=false}={}){
    if(!context||!container)return;
    const state=context.state,time=clampTimelineTime(state.playheadSeconds,duration()),ratio=duration()?time/duration():0;
    state.playheadSeconds=time;
    for(const line of queryAll('[data-editor-playhead]')){
      line.style.left=`${ratio*100}%`;
      line.setAttribute('aria-valuenow',String(time));
    }
    for(const label of queryAll('[data-editor-timecode]'))label.textContent=formatTimelineTimecode(time,fps());
    for(const clip of queryAll('[data-editor-clip-start][data-editor-clip-end]')){
      const start=finite(clip.dataset.editorClipStart),end=finite(clip.dataset.editorClipEnd);
      clip.classList.toggle('is-at-playhead',time>=start&&(time<end||time===duration()&&end===duration()));
    }
    for(const range of queryAll('[data-editor-position]')){
      range.min='0';range.max=String(duration());range.step=String(1/fps());range.value=String(time);
      range.setAttribute('aria-valuetext',formatTimelineTimecode(time,fps()));
    }
    for(const button of queryAll('[data-editor-action="toggle-play"]')){
      const playbackState=state.playing?'playing':'paused';
      if(button.dataset.editorPlaybackState!==playbackState){
        button.innerHTML=state.playing?PAUSE_ICON:PLAY_ICON;
        button.dataset.editorPlaybackState=playbackState;
      }
      button.setAttribute('aria-label',state.playing?'暂停时间轴':'播放时间轴');
      button.setAttribute('aria-pressed',String(state.playing));
    }
    for(const button of queryAll('[data-editor-action="follow"]')){
      button.setAttribute('aria-pressed',String(state.followPlayhead));
      button.title=state.followPlayhead?'播放时跟随进度线':'已关闭自动跟随';
    }
    if(follow&&state.followPlayhead){
      const wrap=container.querySelector('.timeline-board-wrap'),surface=container.querySelector('[data-editor-surface]');
      if(wrap&&surface){
        const lane=surface.getBoundingClientRect(),bounds=wrap.getBoundingClientRect();
        const offset=lane.left-bounds.left+wrap.scrollLeft+ratio*lane.width;
        const next=timelineFollowScroll({scrollLeft:wrap.scrollLeft,viewportWidth:wrap.clientWidth,playheadOffset:offset,contentWidth:wrap.scrollWidth});
        if(Math.abs(next-wrap.scrollLeft)>0.5)wrap.scrollLeft=next;
      }
    }
    if(notify)context.onSeek?.(time);
  }
  function sample(){
    if(!valid()||!restored)return;
    context.state.playheadSeconds=clampTimelineTime(player.currentTime,duration());
    context.state.playing=!player.paused&&!player.ended;
  }
  function tick(){frame=null;sample();update({follow:true,notify:true});requestFrame();}
  function needPreview(seconds=context?.state.playheadSeconds??0,{play=false}={}){context?.onNeedPreview?.(clampTimelineTime(seconds,duration()),{play});}
  function seek(seconds,{pause=false,play=false}={}){
    // Choosing a source clip does not require a rendered full-film export.
    if(context?.selectionOnly){
      context.state.playheadSeconds=clampTimelineTime(seconds,duration());
      context.state.playing=false;
      update({follow:!drag,notify:true});
      return true;
    }
    if(!valid()){needPreview(seconds,{play});return false;}
    const time=clampTimelineTime(seconds,duration());
    if(pause)player.pause();
    context.state.playheadSeconds=time;
    try{player.currentTime=time;}catch{}
    update({follow:!drag,notify:true});
    if(play&&player.paused)void playCurrent();
    return true;
  }
  async function playCurrent(){
    const activeContext=context,activePlayer=player;
    try{await activePlayer.play();}catch{if(context!==activeContext||player!==activePlayer)return;context.state.playing=false;update();toast('请点击画面中的播放键开始预览。');}
  }
  async function togglePlay(){
    if(context?.selectionOnly)return;
    if(!valid()){needPreview(context.state.playheadSeconds,{play:true});return;}
    if(!player.paused){player.pause();return;}
    if(player.ended||context.state.playheadSeconds>=duration())seek(0);
    await playCurrent();
  }
  function action(name){
    if(name==='follow'){context.state.followPlayhead=!context.state.followPlayhead;update();return;}
    if(name==='toggle-play'){void togglePlay();return;}
    if(name==='rewind'){seek(0,{pause:true});return;}
    if(name==='step-back'||name==='step-forward'){
      const frameNumber=Math.round(context.state.playheadSeconds*fps())+(name==='step-forward'?1:-1);
      seek(frameNumber/fps(),{pause:true});
    }
  }
  function surfaceFor(target){const surface=target?.closest?.('[data-editor-surface]');return surface&&container.contains(surface)?surface:null;}
  function controlFor(target){return target?.closest?.('[data-editor-action],[data-editor-position]');}
  function pointerTime(event,surface){return timelineTimeAtPointer(event.clientX,surface.getBoundingClientRect(),finite(surface.dataset.editorDuration,duration()));}
  function pointerDown(event){
    if(controlFor(event.target)){event.stopPropagation();return;}
    const surface=surfaceFor(event.target);
    if(!surface||event.button!==undefined&&event.button!==0)return;
    event.preventDefault();event.stopPropagation();
    const workspace=surface.closest?.('[data-timeline-root],.timeline-workspace');
    workspace?.focus?.({preventScroll:true});
    if(!valid()&&!context?.selectionOnly){needPreview(pointerTime(event,surface));suppressClickUntil=now()+500;return;}
    // Capturing on the lane would retarget a clip's ensuing dblclick to the
    // lane, losing the editor's "open this clip" gesture.
    const button=event.target?.closest?.('button');
    const captureTarget=button&&surface.contains(button)?button:surface;
    drag={surface,captureTarget,pointerId:event.pointerId,startX:event.clientX,scrubbed:false,wasPlaying:valid()&&!player.paused};
    try{captureTarget.setPointerCapture?.(event.pointerId);}catch{}
    seek(pointerTime(event,surface));
  }
  function pointerMove(event){
    if(!drag||event.pointerId!==drag.pointerId)return;
    event.preventDefault();event.stopPropagation();
    if(Math.abs(event.clientX-drag.startX)>=3)drag.scrubbed=true;
    seek(pointerTime(event,drag.surface),{pause:drag.scrubbed});
  }
  function pointerEnd(event){
    if(!drag||event.pointerId!==drag.pointerId)return;
    event.stopPropagation();
    const current=drag;drag=null;
    if(event.type!=='pointercancel')seek(pointerTime(event,current.surface),{pause:current.scrubbed});
    try{current.captureTarget.releasePointerCapture?.(event.pointerId);}catch{}
    if(current.scrubbed&&current.wasPlaying&&valid())void playCurrent();
    suppressClickUntil=now()+500;
  }
  function click(event){
    const control=controlFor(event.target);
    if(control&&container.contains(control)){
      event.stopPropagation();
      if(control.dataset.editorAction){event.preventDefault();action(control.dataset.editorAction);}
      return;
    }
    const surface=surfaceFor(event.target);
    if(!surface)return;
    if(event.detail===0&&event.target?.closest?.('[data-editor-clip-start]'))return;
    event.stopPropagation();
    if(now()<suppressClickUntil)return;
    seek(pointerTime(event,surface));
  }
  function positionInput(event){
    if(!event.target?.matches?.('[data-editor-position]'))return;
    event.stopPropagation();seek(event.target.value,{pause:true});
  }
  function keyDown(event){
    if(context?.selectionOnly)return;
    if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey)return;
    const target=event.target,workspace=target?.closest?.('[data-timeline-root],.timeline-workspace');
    if(!workspace||!container.contains(workspace)||target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
    if(container.ownerDocument?.querySelector?.('dialog[open],[aria-modal="true"]'))return;
    if(![' ','Spacebar','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    if(event.repeat&&(event.key===' '||event.key==='Spacebar'))return;
    if(event.key===' '||event.key==='Spacebar'){void togglePlay();return;}
    if(event.key==='Home'){seek(0,{pause:true});return;}
    if(event.key==='End'){seek(duration(),{pause:true});return;}
    const direction=event.key==='ArrowLeft'?-1:1;
    const time=event.shiftKey?context.state.playheadSeconds+direction:(Math.round(context.state.playheadSeconds*fps())+direction)/fps();
    seek(time,{pause:true});
  }
  function capture(){
    if(context){sample();lastCapture={playheadSeconds:context.state.playheadSeconds,playing:Boolean(context.state.playing)};}
    return {...lastCapture};
  }
  function dispose(){
    capture();
    stopFrame();
    for(const remove of cleanup)remove();
    cleanup=[];drag=null;container=null;context=null;player=null;view=null;restored=false;
  }
  function bind(nextContainer,nextContext){
    dispose();container=nextContainer;context=nextContext;view=container.ownerDocument?.defaultView||globalThis;
    context.state??={};
    context.state.playheadSeconds=clampTimelineTime(context.state.playheadSeconds,duration());
    context.state.followPlayhead??=true;
    context.state.playing=false;
    player=container.querySelector('[data-timeline-full-player]');
    const resume=context.state.resumePlayback===true;context.state.resumePlayback=false;
    let metadataApplied=false;
    function metadata(){
      if(metadataApplied||!valid())return;
      metadataApplied=true;restored=true;
      seek(context.state.playheadSeconds);
      sample();update();
      if(context.state.playing)requestFrame();
      if(resume&&player.paused)void playCurrent();
    }
    function mediaUpdate(event){
      // Historical exports remain independently watchable with native controls;
      // their clock must never drive the current edit's transport or playhead.
      if(!valid())return;
      sample();update({follow:event.type!=='pause',notify:true});
      if(context.state.playing)requestFrame();else stopFrame();
    }
    listen(container,'pointerdown',pointerDown,true);
    listen(container,'pointermove',pointerMove,true);
    listen(container,'pointerup',pointerEnd,true);
    listen(container,'pointercancel',pointerEnd,true);
    listen(container,'click',click,true);
    listen(container,'input',positionInput,true);
    listen(container,'change',positionInput,true);
    listen(container,'keydown',keyDown,true);
    if(player){
      listen(player,'loadedmetadata',metadata);
      for(const name of ['play','pause','timeupdate','seeked','ended'])listen(player,name,mediaUpdate);
      if(player.readyState>=1)metadata();
    }
    update();
  }
  return {bind,dispose,capture,seek};
}
