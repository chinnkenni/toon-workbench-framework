import {useEffect,useRef,useState} from 'react';
import {Popover} from '@radix-ui/themes';
import {Popover as PrimitivePopover} from 'radix-ui';
import {styleCardName,styleMediaUrl} from './style-reference-ui.mjs';

export default function StyleSampleCard({sample,preview,reference,videoPending=false,active=false,open=false,onOpenChange,onSelect,Media}){
 const card=useRef(null),content=useRef(null),largeLink=useRef(null),openTimer=useRef(null),closeTimer=useRef(null),input=useRef('mouse'),escapeClosed=useRef(false),[imageFailed,setImageFailed]=useState(false),[narrow,setNarrow]=useState(false),name=styleCardName(sample),url=styleMediaUrl(reference?.url),referenceId=`style-reference-hover-${sample.id}`;
 function clearTimers(){clearTimeout(openTimer.current);clearTimeout(closeTimer.current);openTimer.current=null;closeTimer.current=null;}
 function show(immediate=false){if(!url||escapeClosed.current)return;clearTimers();if(immediate)onOpenChange(true);else openTimer.current=setTimeout(()=>onOpenChange(true),180);}
 function close(){clearTimers();onOpenChange(false);}
 function leave(){clearTimers();closeTimer.current=setTimeout(()=>onOpenChange(false),120);}
 function enter(event){input.current=event.pointerType||'mouse';if(input.current==='touch')return;escapeClosed.current=false;show();}
 function focus(event){if(input.current==='touch'&&!event.target.matches?.(':focus-visible')||escapeClosed.current)return;if(event.target.matches?.(':focus-visible'))input.current='keyboard';show(true);}
 function escape(event){if(event.key!=='Escape')return;escapeClosed.current=true;close();}
 function clickName(){onSelect();if(input.current==='touch'){escapeClosed.current=false;if(open)close();else show(true);}else{escapeClosed.current=false;show(true);}}
 function touchMedia(event){input.current=event.pointerType||'mouse';if(input.current!=='touch'||event.target.closest?.('video'))return;onSelect();escapeClosed.current=false;if(open)close();else show(true);}
 function blur(event){if(card.current?.contains(event.relatedTarget)||content.current?.contains(event.relatedTarget))return;escapeClosed.current=false;close();}
 useEffect(()=>()=>clearTimers(),[]);
 useEffect(()=>setImageFailed(false),[url]);
 useEffect(()=>{if(typeof window==='undefined'||!window.matchMedia)return;const query=window.matchMedia('(max-width: 760px)'),change=()=>setNarrow(query.matches);change();query.addEventListener('change',change);return()=>query.removeEventListener('change',change);},[]);
 return <Popover.Root open={Boolean(open&&url)} modal={false} onOpenChange={value=>{if(!value)close();else show(true);}}><PrimitivePopover.Anchor asChild><article ref={card} className={`style-reference-card ${active?'is-active':''}`} aria-label={videoPending?`${name}，当前为原图，视频尚未生成`:name} onPointerEnter={enter} onPointerLeave={event=>{if(event.pointerType==='touch')return;escapeClosed.current=false;leave();}} onFocus={focus} onBlur={blur} onKeyDown={event=>{escape(event);if(event.key==='ArrowDown'&&open&&!event.target?.closest?.('video')){event.preventDefault();largeLink.current?.focus();}}}>
  <div className="style-reference-card-media" onPointerUp={touchMedia}><Media sample={preview}/></div><div className="style-reference-card-body"><button type="button" className="style-reference-view" onPointerDown={event=>{input.current=event.pointerType||'mouse';}} onClick={clickName} aria-pressed={active} aria-haspopup={url?'dialog':undefined} aria-expanded={url?open:undefined} aria-controls={open&&url?referenceId:undefined}><strong>{name}</strong></button></div>
 </article></PrimitivePopover.Anchor><Popover.Content ref={content} id={referenceId} className="style-reference-hover" side={narrow?'bottom':'right'} align={narrow?'center':'start'} sideOffset={12} collisionPadding={12} avoidCollisions onOpenAutoFocus={event=>event.preventDefault()} onCloseAutoFocus={event=>event.preventDefault()} onPointerEnter={event=>{if(event.pointerType!=='touch'){clearTimers();show(true);}}} onPointerLeave={event=>{if(event.pointerType!=='touch')leave();}} onFocus={()=>clearTimers()} onBlur={blur} onEscapeKeyDown={event=>{escapeClosed.current=true;close();}} onInteractOutside={event=>{if(card.current?.contains(event.target)){event.preventDefault();return;}close();}} onKeyDown={escape} aria-label={`${name}的原始参考图`}>
  <p>{videoPending?'原始参考图 · 视频尚未生成':'原始参考图'}</p>{url&&!imageFailed?<a ref={largeLink} href={url} target="_blank" rel="noopener noreferrer" aria-label={`查看${name}原始参考大图`}><img src={url} alt={`${name}的原始参考图`} onError={()=>setImageFailed(true)}/></a>:<div className="style-reference-hover-unavailable">原始参考图暂时无法加载</div>}<span>点击图片查看大图</span>
 </Popover.Content></Popover.Root>;
}
