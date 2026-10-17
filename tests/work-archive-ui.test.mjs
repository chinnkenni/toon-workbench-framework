import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveAutoBackup,archiveBilling,archiveBytes,archiveEvidence,archiveProfilePayload,archiveProfileView,archiveSummary,createArchiveReader,mergeArchiveState,safeLanOrigin} from '../frontend/src/work-archive-ui.mjs';

const state=(jobs=[])=>({workId:'work',profile:null,nas:{configured:true,available:true,state:'ready'},jobs,archives:[],records:[]});
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('automatic export backup defaults on only for a newly enabled profile and never backfills an old missing setting',()=>{
 const profile={workId:'work',kind:'red-alert'},original=structuredClone(profile);assert.equal(archiveAutoBackup(null),true);assert.equal(archiveAutoBackup(profile),false);assert.equal(archiveAutoBackup({...profile,autoBackupOnExport:true}),true);assert.equal(archiveAutoBackup(profile,true),true);assert.equal(archiveAutoBackup({...profile,autoBackupOnExport:true},false),false);assert.deepEqual(profile,original);
 assert.deepEqual(archiveProfilePayload('work',null,null),{workId:'work',kind:'red-alert',sourceMode:'cloud-lowres',targetResolution:'1080p',autoBackupOnExport:true});assert.equal(archiveProfilePayload('work',profile,false).autoBackupOnExport,false);assert.equal(Object.hasOwn(archiveProfilePayload('work',profile,true),'type'),false);
});

test('native style-library archives preserve their separate profile, manual default and GPT/GB10/NAS workflow',()=>{
 const profile={workId:'work',kind:'style-library',sourceMode:'gpt-image-gb10',targetResolution:'native'},before=structuredClone(profile),view=archiveProfileView(profile);assert.equal(view.supported,true);assert.equal(view.title,'画风样片档案');assert.equal(archiveAutoBackup(profile),false);assert.deepEqual(archiveProfilePayload('work',profile,null),profile);assert.deepEqual(archiveProfilePayload('work',profile,true),{...profile,autoBackupOnExport:true});assert.equal(Object.hasOwn(archiveProfilePayload('work',profile,null),'autoBackupOnExport'),false);assert.equal(archiveProfilePayload('work',{...profile,autoBackupOnExport:false},null).autoBackupOnExport,false);assert.match(view.steps.map(step=>step.title).join(' '),/GPT.*GB10.*NAS/);assert.doesNotMatch(view.steps.map(step=>step.title).join(' '),/积分平台|1080P/);assert.deepEqual(profile,before);
 assert.equal(archiveProfileView(null).title,'外部原片制作流');assert.equal(archiveProfilePayload('work',null,null).autoBackupOnExport,true);assert.equal(archiveProfileView({...profile,targetResolution:'1080p'}).supported,false);assert.throws(()=>archiveProfilePayload('work',{...profile,targetResolution:'1080p'},true),/不会替换原制作流/);
});

test('archive statistics retain recorded counts and distinguish publishing drafts from publication success',()=>{
 const result=archiveSummary({...state(),summary:{originalVideos:12,flowSnapshots:7,upscaledExports:2,publishingRecords:4}});assert.deepEqual(result.map(item=>item.count),[12,7,2,4]);assert.equal(result[3].label,'发布草稿');assert.match(result[3].description,/不等于发布成功/);
 assert.deepEqual(archiveSummary({summary:{originalVideos:-1,flowSnapshots:'7',upscaledExports:0}}).map(item=>item.count),[null,null,0,null]);
});
test('backup verification uses only a successful immutable receipt and never fills missing historical SHA or size',()=>{
 const job={status:'succeeded',archive:{manifestSha256:'a'.repeat(64),bytes:0}},before=structuredClone(job);assert.equal(archiveEvidence(job).verified,true);assert.equal(archiveBytes(job.archive.bytes),'0 B');assert.deepEqual(job,before);delete job.archive.manifestSha256;assert.equal(archiveEvidence(job).saved,true);assert.equal(archiveEvidence(job).verified,false);assert.equal(archiveBytes(undefined),'未记录');assert.equal(archiveEvidence({status:'running',archive:before.archive}).verified,false);
});
test('credit receipts and user reports remain distinct from verified platform billing',()=>{
 assert.deepEqual(archiveBilling({amount:0,unit:'credits',verification:'user-reported'}),{amount:0,label:'用户登记，未核验扣费'});assert.match(archiveBilling({amount:25,unit:'credits',verification:'provider-receipt'}).label,/附平台回执，未核验扣费/);for(const value of [{amount:'25',unit:'credits'},{amount:-1,unit:'credits'},{amount:25,unit:'USD'},null])assert.equal(archiveBilling(value),null);
});
test('late state reads preserve accepted backup receipts and immutable record history without crossing works',()=>{
 const previous={...state([{id:'job',workId:'work',status:'succeeded',archive:{manifestSha256:'b'.repeat(64)}}]),profile:{workId:'work',kind:'red-alert'},records:[{id:'record',title:'当次请求'}]},next=state([{id:'job',workId:'work',status:'running'}]),merged=mergeArchiveState(previous,next);assert.equal(merged.jobs[0].status,'succeeded');assert.equal(merged.profile.kind,'red-alert');assert.equal(merged.records[0].title,'当次请求');assert.equal(mergeArchiveState(previous,{...state(),workId:'other'}).records.length,0);
});
test('one open archive reader only performs scoped GETs and coalesces pending reads',async()=>{
 const calls=[],data=[],errors=[];let release;const reader=createArchiveReader({workId:'work',api:(...args)=>{calls.push(args);return new Promise(resolve=>{release=resolve;});},onData:value=>data.push(value),onError:error=>errors.push(error)});assert.equal(calls.length,0);const one=reader.read(),two=reader.read();assert.equal(calls.length,1);assert.deepEqual(calls[0],['/api/work-archives/state?workId=work']);release(state());await Promise.all([one,two]);assert.equal(data.length,1);assert.deepEqual(errors,['']);reader.dispose();
});
test('archive reader ignores completion after close and refuses a different work response',async()=>{
 let release;const data=[],errors=[],reader=createArchiveReader({workId:'work',api:()=>new Promise(resolve=>{release=resolve;}),onData:value=>data.push(value),onError:value=>errors.push(value)}),pending=reader.read();reader.dispose();release(state());await pending;assert.deepEqual(data,[]);assert.deepEqual(errors,[]);
 const other=createArchiveReader({workId:'work',api:async()=>({...state(),workId:'other'}),onData:value=>data.push(value),onError:value=>errors.push(value)});assert.equal(await other.read(),null);assert.equal(data.length,0);assert.match(errors[0],/不同作品/);other.dispose();
});
test('explicit fresh read waits out an older in-flight snapshot and then requests new backup evidence',async()=>{
 let release,count=0;const values=[],reader=createArchiveReader({workId:'work',api:()=>++count===1?new Promise(resolve=>{release=resolve;}):Promise.resolve(state([{id:'new',workId:'work',status:'queued'}])),onData:value=>values.push(value),onError:()=>{}}),old=reader.read(),fresh=reader.readFresh();release(state());await old;const latest=await fresh;assert.equal(count,2);assert.equal(latest.jobs[0].id,'new');assert.equal(values.length,2);reader.dispose();
});
test('archive poll speed follows queued background jobs and disposal cancels its future read',async()=>{
 let snapshot=state([{id:'job',workId:'work',status:'queued'}]),calls=0;const timers=new Map(),reader=createArchiveReader({workId:'work',api:async()=>{calls++;return snapshot;},onData:()=>{},onError:()=>{},setTimer:(fn,ms)=>{timers.set(fn,ms);return fn;},clearTimer:id=>timers.delete(id)});reader.start();reader.start();await turn();assert.equal(calls,1);assert.equal([...timers.values()][0],2000);const next=[...timers.keys()][0];timers.delete(next);snapshot=state([{id:'job',workId:'work',status:'succeeded'}]);await next();assert.equal([...timers.values()][0],10000);reader.dispose();assert.equal(timers.size,0);assert.equal(calls,2);
});
test('LAN links allow only HTTPS origins and never credentials, paths or token queries',()=>{
 assert.equal(safeLanOrigin('https://127.0.0.2:18995'),'https://127.0.0.2:18995');for(const value of ['javascript:alert(1)','http://127.0.0.2:18995','https://user:secret@example.com','https://example.com/?token=secret','https://example.com/path','https://example.com/#token'])assert.equal(safeLanOrigin(value),null);
});
