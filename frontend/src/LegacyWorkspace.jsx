import React,{useLayoutEffect,useRef,useState} from 'react';
import {Tabs} from '@radix-ui/themes';
import {initTimeline} from '../../public/timeline.js';
import {initStudioPanels} from '../../public/studio-panels.js';
import VoiceStudio from './VoiceStudio.jsx';
import MusicStudio from './MusicStudio.jsx';
import OpEdLibrary from './OpEdLibrary.jsx';
import './library-skills.css';
export default function LegacyWorkspace(props){
 const host=useRef(null),current=useRef(props),editors=useRef(null),[localCategory,setLocalCategory]=useState('characters'),[audioTab,setAudioTab]=useState('library'),[panelViewRevision,setPanelViewRevision]=useState(0);current.current=props;
 const category=props.materialSection??localCategory,active=props.active!==false,editingTimeline=active&&props.tab==='timeline'&&props.timelineSection!=='exports';
 const setCategory=value=>current.current.onMaterialSectionChange?current.current.onMaterialSectionChange(value):setLocalCategory(value);
 useLayoutEffect(()=>{
  const get=()=>current.current;
  const api=(...args)=>get().api(...args),toast=(...args)=>get().toast(...args),refresh=(...args)=>get().refresh(...args);
  const timeline=initTimeline({api,toast,refresh,getWork:()=>get().work,getEpisodeId:()=>get().episodeId,onEditShot:(id)=>get().onEditShot(id)});
  const panels=initStudioPanels({api,toast,refresh,getWork:()=>get().work,getEpisodeId:()=>get().episodeId,showTab:tab=>{if(tab==='audio'){setCategory('audio');setPanelViewRevision(value=>value+1);if(get().tab!=='materials')get().onTabChange('materials',"audio");}else get().onTabChange(tab,tab==='timeline'?'edit':undefined);}});
  editors.current={timeline,panels};
  const synthetic=action=>timeline.handleClick({target:{closest:()=>({dataset:{timelineAction:action}})}});
  const editor={export:options=>timeline.exportWithOptions(options),save:()=>synthetic('save'),editClip:(id,options)=>timeline.editClip(id,options),getContext:()=>({workId:get().work.id,episodeId:get().episodeId,tab:get().tab}),capture:options=>timeline.capture(options),pause:()=>{timeline.capture({resume:false});host.current?.querySelectorAll('video,audio').forEach(player=>player.pause());}};
  get().onEditorReady?.(editor);
  const click=async event=>{
   try{if(await panels.handleClick(event))return;if(await timeline.handleClick(event))return;const button=event.target.closest('[data-action]');if(!button)return;
    if(button.dataset.action==='edit-segment')get().onEditShot(button.dataset.id);
    if(button.dataset.action==='new-episode')get().onCreateEpisode?.();
    if(button.dataset.action==='tab')get().onTabChange(button.dataset.id,button.dataset.id==='timeline'?'edit':undefined);
   }catch(error){toast(error.message);}
  };
  host.current.addEventListener('click',click);
  return()=>{timeline.capture({resume:false});timeline.dispose?.();panels.dispose?.();host.current?.removeEventListener('click',click);get().onEditorReady?.(null);};
 },[]);
 useLayoutEffect(()=>{
  const {timeline,panels}=editors.current,node=host.current;let timer;
  if(!active){timeline.capture({resume:false});node.querySelectorAll('video,audio').forEach(player=>player.pause());return;}
  const key=props.work.id+'/'+props.episodeId+'/'+props.tab+'/'+category+'/'+audioTab+'/'+panelViewRevision+'/'+(props.timelineSection||'edit');
  const paint=()=>{
   const playing=[...node.querySelectorAll('video,audio')].some(player=>!player.paused),editing=node.contains(document.activeElement)&&document.activeElement.matches('input,textarea,select,[contenteditable="true"]');
   if(node.dataset.workspaceKey===key&&(playing||editing||node.querySelector('[data-editor-surface]:active'))){timer=setTimeout(paint,400);return;}
   timeline.capture({resume:editingTimeline});node.querySelectorAll('video,audio').forEach(player=>player.pause());
   node.innerHTML=props.tab==='timeline'?(editingTimeline?timeline.render(props.work,props.episodeId):''):props.tab==='script'?panels.render('script',props.work,props.episodeId):category==='op-ed'||category==='audio'&&['tts','music'].includes(audioTab)?'':panels.render(category,props.work,props.episodeId);
   node.dataset.workspaceKey=key;panels.bind(node);timeline.bind(node);
  };paint();return()=>clearTimeout(timer);
 },[props.work,props.episodeId,props.tab,category,audioTab,panelViewRevision,props.timelineSection,editingTimeline,active]);
 return <div className={`modern-workspace workspace-${!active?'inactive':props.tab==='timeline'&&!editingTimeline?'exports':props.tab}`} hidden={!active}>
  {props.tab==='materials'&&category==='audio'&&<Tabs.Root value={audioTab} onValueChange={setAudioTab} className="voice-audio-navigation"><Tabs.List aria-label="声音制作方式"><Tabs.Trigger value="library">声音素材</Tabs.Trigger><Tabs.Trigger value="tts">角色配音</Tabs.Trigger><Tabs.Trigger value="music">配乐生成</Tabs.Trigger></Tabs.List></Tabs.Root>}
  <div ref={host} className="legacy-workspace-host" hidden={props.tab==='timeline'&&props.timelineSection==='exports'||props.tab==='materials'&&category==='audio'&&['tts','music'].includes(audioTab)}/>
  {props.tab==='materials'&&category==='audio'&&audioTab==='tts'&&<VoiceStudio work={props.work} episodeId={props.episodeId} api={props.api} toast={props.toast} refresh={props.refresh}/>}
  {props.tab==='materials'&&category==='audio'&&audioTab==='music'&&<MusicStudio key={props.work.id} work={props.work} episodeId={props.episodeId} api={props.api} toast={props.toast} refresh={props.refresh}/>}
  {props.tab==='materials'&&category==='op-ed'&&<OpEdLibrary key={props.work.id} work={props.work} episodeId={props.episodeId} api={props.api} toast={props.toast} refresh={props.refresh}/>}
 </div>;
}
