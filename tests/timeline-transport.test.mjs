import test from 'node:test';
import assert from 'node:assert/strict';
import {clampTimelineTime,timelineTimeAtPointer,formatTimelineTimecode,timelineFollowScroll,createTimelineTransport} from '../public/timeline-transport.js';

class Element {
  constructor(tag='div',attributes={}){
    this.tagName=tag.toUpperCase();this.attributes={...attributes};this.children=[];this.parentElement=null;this.listeners=new Map();this.style={};this.textContent='';this.value='';
    this.html='';this.htmlWrites=0;
    this.classes=new Set((attributes.class||'').split(' ').filter(Boolean));
    this.classList={toggle:(name,enabled)=>enabled?this.classes.add(name):this.classes.delete(name),contains:name=>this.classes.has(name)};
    this.dataset=Object.fromEntries(Object.entries(attributes).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
    this.rect={left:0,width:1000};this.scrollLeft=0;this.clientWidth=1000;this.scrollWidth=1000;
  }
  append(...children){for(const child of children){child.parentElement=this;child.ownerDocument=this.ownerDocument;this.children.push(child);}return this;}
  matches(selector){return selector.split(',').some(part=>{
    part=part.trim();if(part.startsWith('.'))return this.classes.has(part.slice(1));
    if(part.startsWith('[contenteditable]'))return this.attributes.contenteditable!==undefined&&this.attributes.contenteditable!=='false';
    if(part.startsWith('[')){
      const requirements=Array.from(part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g));
      return requirements.length>0&&requirements.every(([,key,value])=>this.attributes[key]!==undefined&&(value===undefined||this.attributes[key]===value));
    }
    return this.tagName===part.toUpperCase();
  });}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  contains(element){return element===this||this.children.some(child=>child.contains(element));}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  setAttribute(key,value){this.attributes[key]=String(value);}
  set innerHTML(value){this.html=value;this.htmlWrites++;}
  get innerHTML(){return this.html;}
  focus(options){this.focusOptions=options;if(this.ownerDocument)this.ownerDocument.activeElement=this;}
  getBoundingClientRect(){return this.rect;}
  addEventListener(name,handler){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(handler);}
  removeEventListener(name,handler){this.listeners.get(name)?.delete(handler);}
  emit(type,properties={}){
    const event={type,target:this,button:0,pointerId:1,detail:1,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.propagationStopped=true;},...properties};
    for(const handler of [...this.listeners.get(type)||[]])handler(event);
    return event;
  }
  setPointerCapture(id){this.captured=id;}
  releasePointerCapture(){this.captured=null;}
}

function fixture({canSeek=true,readyState=1,time=0,resumePlayback=false,selectionOnly=false,withPlayer=true}={}){
  let nextFrame=0,clock=1000,needPreview=[];const frames=new Map(),seeks=[];
  const view={performance:{now:()=>clock},requestAnimationFrame:callback=>{const id=++nextFrame;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id)};
  const document={defaultView:view,querySelector:()=>null};
  const container=new Element('section',{'data-timeline-root':'',class:'timeline-workspace'});container.ownerDocument=document;
  const player=new Element('video',{'data-timeline-full-player':''});Object.assign(player,{readyState,currentTime:0,paused:true,ended:false});
  player.play=async()=>{player.paused=false;player.ended=false;player.emit('play');};
  player.pause=()=>{const changed=!player.paused;player.paused=true;if(changed)player.emit('pause');};
  const wrap=new Element('div',{class:'timeline-board-wrap'});wrap.clientWidth=400;wrap.scrollWidth=1110;wrap.rect={left:0,width:400};
  const surface=new Element('div',{'data-editor-surface':'','data-editor-duration':'10'});surface.rect={left:110,width:1000};
  const line=new Element('div',{'data-editor-playhead':''});
  const first=new Element('button',{'data-editor-clip-start':'0','data-editor-clip-end':'5'}),last=new Element('button',{'data-editor-clip-start':'5','data-editor-clip-end':'10'});
  const label=new Element('span',{'data-editor-timecode':''}),range=new Element('input',{'data-editor-position':''});
  const controls=Object.fromEntries(['toggle-play','rewind','step-back','step-forward','follow'].map(action=>[action,new Element('button',{'data-editor-action':action})]));
  container.append(...(withPlayer?[player]:[]),wrap,label,range,...Object.values(controls));wrap.append(surface);surface.append(line,first,last);
  for(const element of [surface,line,first,last])element.ownerDocument=document;
  const state={playheadSeconds:time,resumePlayback};
  const context={state,duration:10,fps:24,canSeek,selectionOnly,onNeedPreview:(...args)=>needPreview.push(args),onSeek:seconds=>seeks.push(seconds)};
  const transport=createTimelineTransport();transport.bind(container,context);
  return {transport,container,player,wrap,surface,line,first,last,label,range,controls,state,context,frames,seeks,needPreview,document,
    click:target=>container.emit('click',{target}),
    frame:()=>{const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(clock);},
    advance:milliseconds=>{clock+=milliseconds;}};
}

test('pointer coordinates use the scrolled bounding rectangle without adding scrollLeft twice',()=>{
  assert.equal(timelineTimeAtPointer(50,{left:-150,width:1000},20),4);
  assert.equal(timelineTimeAtPointer(-200,{left:-150,width:1000},20),0);
  assert.equal(timelineTimeAtPointer(900,{left:-150,width:1000},20),20);
  assert.equal(timelineTimeAtPointer(100,{left:0,width:0},20),0);
});

test('frame timecode floors fractional playback frames and carries hours and frame boundaries',()=>{
  assert.equal(formatTimelineTimecode(0,24),'00:00:00:00');
  assert.equal(formatTimelineTimecode(1-1/24,24),'00:00:00:23');
  assert.equal(formatTimelineTimecode(3661+12/24,24),'01:01:01:12');
  assert.equal(formatTimelineTimecode(4.458333333,24),'00:00:04:11');
  assert.equal(formatTimelineTimecode(0.041666,24),'00:00:00:01');
  assert.equal(formatTimelineTimecode(0.033333,30),'00:00:00:01');
  assert.equal(formatTimelineTimecode(0.04,24),'00:00:00:00');
  assert.equal(formatTimelineTimecode(0.033,30),'00:00:00:00');
  assert.equal(formatTimelineTimecode(-1,30),'00:00:00:00');
  assert.equal(clampTimelineTime(Infinity,12),0);
  assert.equal(clampTimelineTime(13,12),12);
  assert.equal(clampTimelineTime(-2,12),0);
});

test('following keeps the playhead in view and never scrolls beyond either end',()=>{
  assert.equal(timelineFollowScroll({scrollLeft:0,viewportWidth:400,contentWidth:1200,playheadOffset:600}),264);
  assert.equal(timelineFollowScroll({scrollLeft:264,viewportWidth:400,contentWidth:1200,playheadOffset:610}),274);
  assert.equal(timelineFollowScroll({scrollLeft:264,viewportWidth:400,contentWidth:1200,playheadOffset:100}),36);
  assert.equal(timelineFollowScroll({scrollLeft:0,viewportWidth:400,contentWidth:1200,playheadOffset:10}),0);
  assert.equal(timelineFollowScroll({scrollLeft:0,viewportWidth:400,contentWidth:1200,playheadOffset:1300}),800);
});

test('valid preview seeks from ruler, syncs timecode, range and active clip without rerender',()=>{
  const f=fixture();const event=f.container.emit('click',{target:f.surface,clientX:610});
  assert.equal(f.player.currentTime,5);assert.equal(f.state.playheadSeconds,5);
  assert.equal(f.line.style.left,'50%');assert.equal(f.label.textContent,'00:00:05:00');
  assert.equal(f.range.value,'5');assert.equal(f.range.step,String(1/24));
  assert.equal(f.first.classList.contains('is-at-playhead'),false);assert.equal(f.last.classList.contains('is-at-playhead'),true);
  assert.equal(event.propagationStopped,true);assert.equal(f.seeks.at(-1),5);
  f.transport.dispose();
});

test('timeline never seeks a stale export while native historical playback stays independent',async()=>{
  const f=fixture({canSeek:false,time:3});f.player.currentTime=7;
  f.container.emit('click',{target:f.surface,clientX:610});f.click(f.controls['toggle-play']);f.click(f.controls['step-forward']);
  assert.equal(f.player.currentTime,7);assert.equal(f.state.playheadSeconds,3);assert.equal(f.state.playing,false);assert.equal(f.frames.size,0);
  assert.deepEqual(f.needPreview[0],[5,{play:false}]);assert.deepEqual(f.needPreview[1],[3,{play:true}]);
  f.transport.seek(8,{play:true});assert.deepEqual(f.needPreview.at(-1),[8,{play:true}]);
  const requests=f.needPreview.length;await f.player.play();f.player.currentTime=9;f.player.emit('timeupdate');
  assert.equal(f.player.paused,false);assert.equal(f.state.playheadSeconds,3);assert.equal(f.state.playing,false);assert.equal(f.frames.size,0);assert.equal(f.needPreview.length,requests);
  assert.deepEqual(f.transport.capture(),{playheadSeconds:3,playing:false});
  f.transport.dispose();
});

test('single-clip selection seeks and scrubs locally without a whole-film player or export request',()=>{
  const f=fixture({canSeek:false,selectionOnly:true,withPlayer:false,time:1});
  assert.equal(f.container.querySelector('[data-timeline-full-player]'),null);
  assert.equal(f.transport.seek(6),true);assert.equal(f.state.playheadSeconds,6);assert.equal(f.seeks.at(-1),6);
  assert.equal(f.line.style.left,'60%');assert.equal(f.range.value,'6');assert.equal(f.label.textContent,'00:00:06:00');assert.deepEqual(f.needPreview,[]);
  const down=f.container.emit('pointerdown',{target:f.first,clientX:310,pointerId:9});
  assert.equal(down.propagationStopped,true);assert.equal(f.state.playheadSeconds,2);assert.equal(f.first.captured,9);
  f.container.emit('pointermove',{target:f.surface,clientX:810,pointerId:9});assert.equal(f.state.playheadSeconds,7);
  f.container.emit('pointerup',{target:f.surface,clientX:910,pointerId:9});assert.equal(f.state.playheadSeconds,8);assert.equal(f.first.captured,null);
  const syntheticClick=f.container.emit('click',{target:f.first,clientX:110});assert.equal(syntheticClick.propagationStopped,true);assert.equal(f.state.playheadSeconds,8,'the click after pointerup must not seek a second time');
  f.advance(600);f.container.emit('click',{target:f.surface,clientX:610});assert.equal(f.state.playheadSeconds,5);
  f.range.value='3.125';f.container.emit('input',{target:f.range});assert.equal(f.state.playheadSeconds,3.125);
  assert.equal(f.transport.seek(15),true);assert.equal(f.state.playheadSeconds,10);
  assert.equal(f.state.playing,false);assert.equal(f.frames.size,0);assert.deepEqual(f.needPreview,[]);assert.deepEqual(f.transport.capture(),{playheadSeconds:10,playing:false});
  f.transport.dispose();
});

test('single-clip playback shortcuts never promote to a full preview or drive a historical video',async()=>{
  const f=fixture({canSeek:false,selectionOnly:true,time:3});f.player.currentTime=7;
  f.click(f.controls['toggle-play']);f.container.emit('keydown',{target:f.surface,key:' '});
  assert.equal(f.state.playheadSeconds,3);assert.equal(f.player.currentTime,7);assert.equal(f.player.paused,true);assert.deepEqual(f.needPreview,[]);
  const keyboardActivation=f.container.emit('click',{target:f.last,detail:0,clientX:0});
  assert.equal(keyboardActivation.propagationStopped,undefined,'keyboard selection remains delegated to the clip editor');
  await f.player.play();f.player.currentTime=9;f.player.emit('timeupdate');
  assert.equal(f.state.playheadSeconds,3);assert.equal(f.state.playing,false);assert.equal(f.frames.size,0);
  assert.deepEqual(f.needPreview,[]);assert.deepEqual(f.transport.capture(),{playheadSeconds:3,playing:false});f.transport.dispose();
});

test('native video playback and native seek drive animation and pause cancels RAF',async()=>{
  const f=fixture();await f.player.play();assert.equal(f.frames.size,1);
  f.player.currentTime=6.5;f.frame();assert.equal(f.state.playheadSeconds,6.5);assert.equal(f.line.style.left,'65%');assert.equal(f.controls['toggle-play'].attributes['aria-label'],'暂停时间轴');assert.equal(f.controls['toggle-play'].attributes['aria-pressed'],'true');assert.match(f.controls['toggle-play'].innerHTML,/<svg[^>]*aria-hidden="true"/);assert.match(f.controls['toggle-play'].innerHTML,/M8 5v14M16 5v14/);assert.ok(f.wrap.scrollLeft>0);
  const writes=f.controls['toggle-play'].htmlWrites;f.frame();assert.equal(f.controls['toggle-play'].htmlWrites,writes,'unchanged playback frames preserve the icon DOM');
  f.player.pause();assert.equal(f.frames.size,0);assert.equal(f.controls['toggle-play'].attributes['aria-label'],'播放时间轴');assert.equal(f.controls['toggle-play'].attributes['aria-pressed'],'false');assert.match(f.controls['toggle-play'].innerHTML,/m8 5 11 7-11 7Z/);
  f.player.currentTime=2.5;f.player.emit('seeked');assert.equal(f.range.value,'2.5');assert.equal(f.label.textContent,'00:00:02:12');
  f.player.currentTime=10.02;f.player.ended=true;f.player.emit('ended');assert.equal(f.state.playheadSeconds,10);assert.equal(f.last.classList.contains('is-at-playhead'),true);
  f.transport.dispose();
});

test('follow switch prevents playback from changing horizontal scroll',async()=>{
  const f=fixture();f.click(f.controls.follow);assert.equal(f.state.followPlayhead,false);
  await f.player.play();f.player.currentTime=9;f.frame();assert.equal(f.wrap.scrollLeft,0);assert.equal(f.line.style.left,'90%');
  f.click(f.controls.follow);assert.equal(f.controls.follow.attributes['aria-pressed'],'true');f.frame();assert.ok(f.wrap.scrollLeft>0);
  f.transport.dispose();
});

test('pointer scrub pauses while dragging, restores playback, preserves dblclick target and suppresses generated click',async()=>{
  const f=fixture();await f.player.play();
  f.container.emit('pointerdown',{target:f.first,clientX:310,pointerId:9});assert.equal(f.player.currentTime,2);assert.equal(f.player.paused,false);assert.equal(f.first.captured,9);
  f.container.emit('pointermove',{target:f.surface,clientX:810,pointerId:9});assert.equal(f.player.currentTime,7);assert.equal(f.player.paused,true);
  f.container.emit('pointerup',{target:f.surface,clientX:910,pointerId:9});assert.equal(f.player.currentTime,8);assert.equal(f.first.captured,null);assert.equal(f.player.paused,false);
  f.container.emit('click',{target:f.surface,clientX:110});assert.equal(f.player.currentTime,8);
  f.advance(600);f.container.emit('click',{target:f.surface,clientX:110});assert.equal(f.player.currentTime,0);
  f.transport.dispose();
});

test('single click seeks without pausing an already playing preview',async()=>{
  const f=fixture();await f.player.play();
  f.container.emit('pointerdown',{target:f.first,clientX:310});
  f.container.emit('pointerup',{target:f.first,clientX:310});
  assert.equal(f.player.currentTime,2);assert.equal(f.player.paused,false);assert.equal(f.state.playing,true);
  assert.equal(f.document.activeElement,f.container);assert.deepEqual(f.container.focusOptions,{preventScroll:true});
  assert.equal(f.controls['toggle-play'].attributes['aria-label'],'暂停时间轴');
  f.transport.dispose();
});

test('keyboard transport stays in workspace, ignores text fields and open dialogs, and steps by frame',()=>{
  const f=fixture({time:2});
  f.container.emit('keydown',{target:f.surface,key:'ArrowRight'});assert.equal(f.player.currentTime,49/24);
  f.container.emit('keydown',{target:f.surface,key:'ArrowLeft',shiftKey:true});assert.ok(Math.abs(f.player.currentTime-25/24)<1e-12);
  f.container.emit('keydown',{target:f.range,key:'ArrowRight'});assert.ok(Math.abs(f.player.currentTime-25/24)<1e-12);
  f.document.querySelector=()=>({open:true});f.container.emit('keydown',{target:f.surface,key:'Home'});assert.ok(Math.abs(f.player.currentTime-25/24)<1e-12);
  f.document.querySelector=()=>null;f.container.emit('keydown',{target:f.surface,key:'End'});assert.equal(f.player.currentTime,10);
  f.container.emit('keydown',{target:f.surface,key:'Home'});assert.equal(f.player.currentTime,0);
  f.transport.dispose();
});

test('accessible range input seeks while keyboard activation of a clip is left to editor',()=>{
  const f=fixture();f.range.value='3.125';const input=f.container.emit('input',{target:f.range});assert.equal(f.player.currentTime,3.125);assert.equal(input.propagationStopped,true);
  f.range.focus();f.container.emit('pointerdown',{target:f.range,clientX:300});assert.equal(f.document.activeElement,f.range);
  const click=f.container.emit('click',{target:f.last,detail:0,clientX:0});assert.equal(f.player.currentTime,3.125);assert.equal(click.propagationStopped,undefined);
  f.transport.dispose();
});

test('metadata restores saved cursor and consumes resume once; rebind removes old listeners',async()=>{
  const f=fixture({readyState:0,time:4,resumePlayback:true});assert.equal(f.state.resumePlayback,false);assert.equal(f.player.currentTime,0);
  f.player.readyState=1;f.player.emit('loadedmetadata');await Promise.resolve();assert.equal(f.player.currentTime,4);assert.equal(f.player.paused,false);
  f.player.currentTime=6;assert.deepEqual(f.transport.capture(),{playheadSeconds:6,playing:true});
  f.player.pause();f.player.emit('loadedmetadata');assert.equal(f.player.paused,true);
  f.transport.bind(f.container,f.context);assert.equal(f.container.listeners.get('click').size,1);assert.equal(f.player.listeners.get('play').size,1);
  f.transport.dispose();assert.equal(f.frames.size,0);assert.equal(f.container.listeners.get('click').size,0);assert.equal(f.player.listeners.get('play').size,0);
  assert.deepEqual(f.transport.capture(),{playheadSeconds:6,playing:false});
});

test('metadata resume is idempotent when native playback starts before metadata arrives',async()=>{
  const f=fixture({readyState:0,time:4,resumePlayback:true});
  await f.player.play();assert.equal(f.player.paused,false);
  f.player.readyState=1;f.player.emit('loadedmetadata');await Promise.resolve();
  assert.equal(f.player.paused,false);assert.equal(f.player.currentTime,4);assert.equal(f.state.playing,true);
  f.player.emit('loadedmetadata');assert.equal(f.player.paused,false);
  f.transport.dispose();
});
