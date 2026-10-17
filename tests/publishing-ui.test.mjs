import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createPublishingReader,publishingMetadata,publishingPayload,publishingDirty,publishingCopy,publishingDescriptionBytes,publishingMetadataError,publishingDraftSource,publishingExportLabel,publishingExports,publishingStatus,reconcilePublishingState,updatePublishingDraft} from '../frontend/src/publishing-ui.mjs';

const source=await readFile(new URL('../frontend/src/PublishingCenter.jsx',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const fixture=()=>({id:'draft-a',revision:3,workId:'work-a',exportId:'export-a',platform:'youtube',status:'draft',metadata:{title:'  下一站，星河  ',description:'原创短片',tags:['原创','科幻'],privacy:'private',categoryId:'1',madeForKids:false,syntheticMedia:true}});
function evalHandler(name,next,context){const start=source.indexOf(` async function ${name}(`),end=source.indexOf(` ${next}`,start);assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),context);return context[name];}

test('publishing metadata uses private visibility by default, normalizes only a copy, and retains explicit declarations',()=>{
 const draft=fixture(),before=structuredClone(draft),form=publishingMetadata(draft);form.tags=' #原创，科幻\n#原创, 动画';form.description=' 简介 ';
 assert.deepEqual(publishingPayload(form),{title:'下一站，星河',description:'简介',tags:['原创','科幻','动画'],coverMediaId:null,privacy:'private',categoryId:'1',madeForKids:false,syntheticMedia:true});
 assert.deepEqual(draft,before);assert.equal(publishingMetadata({metadata:{syntheticMedia:false}}).syntheticMedia,false);assert.equal(publishingMetadata(null).privacy,'private');assert.equal(publishingDirty(form,publishingMetadata(draft)),true);assert.equal(publishingDirty(form,{...form}),false);
 assert.throws(()=>publishingPayload({...form,title:'   '}),/发布标题/);assert.throws(()=>publishingPayload({...form,tags:Array.from({length:31},(_,index)=>'标签'+index).join(',')}),/30/);
});

test('copy text groups the actual title, body and unique tags without mutating the editor',()=>{
 const form={title:'  星河来信  ',description:'  原创短片  ',tags:'#原创，科幻,原创'},before={...form};assert.equal(publishingCopy(form),'星河来信\n\n原创短片\n\n#原创 #科幻');assert.deepEqual(form,before);assert.equal(publishingCopy({title:'仅标题'}),'仅标题');
});

test('YouTube descriptions count UTF8 bytes and reject excess before an upload or save',()=>{
 assert.equal(publishingDescriptionBytes('星河'),6);assert.equal(publishingDescriptionBytes('🌌'),4);assert.equal(publishingMetadataError({title:'标题',description:'星'.repeat(1666)},{id:'youtube'}),'');assert.match(publishingMetadataError({title:'标题',description:'星'.repeat(1667)},{id:'youtube'}),/5,000 字节/);assert.equal(publishingMetadataError({title:'标题',description:'星'.repeat(1667)},{id:'bilibili'}),'');
});

test('source facts prefer the immutable prepared source rather than a later export reading',()=>{
 const draft={exportId:'export-a',prepared:{source:{exportId:'export-a',width:1920,height:1080,duration:12,sha256:'fixed'}}},exports=[{id:'export-a',width:608,height:352,duration:4}];assert.equal(publishingDraftSource(draft,exports),draft.prepared.source);assert.equal(publishingDraftSource({exportId:'export-a'},exports),exports[0]);assert.equal(publishingDraftSource({exportId:'missing'},exports),null);
 assert.equal(publishingExportLabel({id:'12345678abc',episodeTitle:'第 1 集',width:1920,height:1080,duration:12.0202}),'第 1 集 · 1920 × 1080 · 12.02 秒 · 12345678');assert.equal(publishingStatus({status:'awaiting_manual_publish'}),'待平台发布');assert.equal(publishingStatus({status:'upload-status-unknown'}),'上传状态待核对');
});

test('opening publishing defaults to the latest completed export without changing source ordering',()=>{
 const exports=[{id:'older',createdAt:'2026-10-15T11:00:00Z'},{id:'latest',createdAt:'2026-10-15T12:00:00Z'},{id:'legacy'}],before=structuredClone(exports);assert.deepEqual(publishingExports(exports).map(item=>item.id),['latest','older','legacy']);assert.deepEqual(exports,before);
});

test('an older poll cannot revert a freshly saved draft revision or add private fields to metadata',async()=>{
 const prior={drafts:[{id:'draft-a',revision:4,metadata:{title:'已保存的新标题'}},{id:'new-draft',revision:1}]},next={drafts:[{id:'draft-a',revision:3,metadata:{title:'旧标题'}},{id:'draft-b',revision:1}]};const value=reconcilePublishingState(prior,next);assert.equal(value.drafts[0],prior.drafts[0]);assert.equal(value.drafts[1],next.drafts[1]);assert.equal(value.drafts[2],prior.drafts[1],'A slow read cannot remove a just-created draft');assert.equal(next.drafts[0].revision,3);
 const target=fixture(),form=publishingMetadata(target),waiting=deferred(),calls=[];const saving=updatePublishingDraft({api:async(path,body)=>{calls.push({path,body});await waiting.promise;return {draft:{...target,revision:4}};},draft:target,form});target.id='draft-b';target.revision=99;form.title='编辑了另一个草稿';waiting.resolve();await saving;
 assert.equal(calls[0].path,'/api/publishing/drafts/draft-a/update');assert.equal(calls[0].body.revision,3);assert.equal(calls[0].body.metadata.title,'下一站，星河');assert.equal(Object.hasOwn(calls[0].body,'clientSecret'),false);
});

test('publishing reader coalesces requests, pauses hidden polling and cancels updates on close',async()=>{
 const waiting=deferred(),data=[],errors=[],loading=[],calls=[];let tick,cleared=0,visible=true;const reader=createPublishingReader({workId:'work-a',fetcher:async(path,options)=>{calls.push({path,options});return waiting.promise;},onData:value=>data.push(value),onError:value=>errors.push(value),onLoading:value=>loading.push(value),setTimer:callback=>{tick=callback;return 7;},clearTimer:id=>{assert.equal(id,7);cleared++;},isVisible:()=>visible});
 reader.start();reader.start();const pending=reader.read();tick();assert.equal(calls.length,1);visible=false;tick();assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/publishing/state?workId=work-a');assert.equal(calls[0].options.credentials,'same-origin');
 reader.dispose();assert.equal(calls[0].options.signal.aborted,true);waiting.resolve({ok:true,json:async()=>({platforms:[],drafts:[],exports:[]})});await pending;assert.deepEqual(data,[]);assert.deepEqual(errors,[]);assert.equal(cleared,1);assert.deepEqual(loading,[true]);
});

test('publishing reader reports malformed data and server errors while keeping the last successful view',async()=>{
 const errors=[],data=[];let response={ok:true,json:async()=>({platforms:[],drafts:[{id:'draft'}],exports:[]})};const reader=createPublishingReader({workId:'work',fetcher:async()=>response,onData:value=>data.push(value),onError:value=>errors.push(value)});await reader.read();response={ok:false,json:async()=>({error:'源成片丢失'})};await reader.read();assert.equal(data.length,1);assert.equal(errors.at(-1),'源成片丢失');response={ok:true,json:async()=>({drafts:[]})};await reader.read();assert.match(errors.at(-1),/数据格式/);reader.dispose();
});

test('the actual prepare handler saves edited metadata before preparing that returned revision',async()=>{
 const calls=[],adopted=[],draft=fixture(),context=vm.createContext({selected:draft,dirty:true,saveDraft:async()=>{calls.push({action:'save'});return {...draft,revision:4};},operation:async(kind,callback)=>callback(),api:async(path,body)=>{calls.push({path,body});return {draft:{...draft,revision:5,status:'prepared'}};},getDraft:result=>result.draft,live:{current:true},upsert:()=>{},adopt:value=>adopted.push(value),toast:()=>{}});
 const prepare=evalHandler('prepare','async function handoff',context);await prepare();assert.deepEqual(plain(calls),[{action:'save'},{path:'/api/publishing/drafts/draft-a/prepare',body:{revision:4}}]);assert.equal(adopted[0].status,'prepared');
});

test('the actual manual registration handler records the captured draft and never marks an API verification',async()=>{
 const calls=[],draft=fixture(),context=vm.createContext({selected:draft,editRevision:3,dirty:false,manualUrl:' https://www.youtube.com/watch?v=ABCDEFGHIJK ',operation:async(kind,callback)=>callback(),api:async(path,body)=>{calls.push({path,body});return {draft:{...draft,status:'published-manual',revision:4}};},getDraft:result=>result.draft,live:{current:true},upsert:()=>{},adopt:()=>{},toast:()=>{}});
 const confirm=evalHandler('confirmManual','async function copyText',context);await confirm();assert.deepEqual(plain(calls),[{path:'/api/publishing/drafts/draft-a/confirm-manual',body:{revision:3,url:'https://www.youtube.com/watch?v=ABCDEFGHIJK'}}]);assert.equal(Object.hasOwn(calls[0].body,'verifiedByApi'),false);
});

test('actual YouTube upload submits explicit confirmation and the current saved revision only',async()=>{
 const calls=[],draft=fixture(),context=vm.createContext({selected:draft,editRevision:3,dirty:false,operation:async(kind,callback)=>callback(),api:async(path,body)=>{calls.push({path,body});return {draft:{...draft,status:'uploading',revision:4}};},getDraft:result=>result.draft,live:{current:true},upsert:()=>{},adopt:()=>{},setApiReview:()=>{},toast:()=>{}});
 const publish=evalHandler('publishApi','async function refreshApi',context);await publish();assert.deepEqual(plain(calls),[{path:'/api/publishing/drafts/draft-a/publish-api',body:{revision:3,confirm:true}}]);context.dirty=true;await assert.rejects(publish,/先保存/);assert.equal(calls.length,1);
});

test('actual official-status and manual-failure handlers keep their separate audit semantics',async()=>{
 const calls=[],draft=fixture(),context=vm.createContext({selected:draft,editRevision:3,failureNote:'  封面不合适，等待重新上传  ',operation:async(kind,callback)=>callback(),api:async(path,body)=>{calls.push({path,body});return {draft:{...draft,revision:4}};},getDraft:result=>result.draft,live:{current:true},upsert:()=>{},adopt:()=>{},toast:()=>{}});
 const refresh=evalHandler('refreshApi','async function recordFailure',context);await refresh();const failure=evalHandler('recordFailure','const handleYoutubeStatus=',context);await failure();assert.deepEqual(plain(calls),[{path:'/api/publishing/drafts/draft-a/refresh-api',body:{revision:3}},{path:'/api/publishing/drafts/draft-a/manual-failed',body:{revision:3,note:'封面不合适，等待重新上传'}}]);
});

test('actual action lock prevents double submission and leaves failures visible without replacing input',async()=>{
 const waiting=deferred(),errors=[],busy=[],context=vm.createContext({lock:{current:false},live:{current:true},setBusy:value=>busy.push(value),setError:value=>errors.push(value)});const operation=evalHandler('operation','async function createDraft',context);let calls=0;const first=operation('prepare',async()=>{calls++;await waiting.promise;throw new Error('封面已变化，请重新选择');});await operation('prepare',async()=>{calls++;});assert.equal(calls,1);assert.equal(context.lock.current,true);waiting.resolve();await first;assert.equal(errors.at(-1),'封面已变化，请重新选择');assert.deepEqual(busy,['prepare','']);assert.equal(context.lock.current,false);
});
