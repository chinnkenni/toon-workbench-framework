import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {workType,groupWorks,filterWorks,isWorkGroupExpanded,metadataDraft,metadataSubmission} from '../frontend/src/work-types.mjs';

const source=await readFile(new URL('../frontend/src/App.jsx',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
function work(id,type,title){return {id,...(type?{type}:{}),title,synopsis:'星河来信',style:'2D Animation',episodes:[{id:id+'-episode'}],shots:[{id:id+'-shot'}],assets:[{id:id+'-asset'}]};}

test('sidebar groups include legacy short films and empty groups while preserving each original work and order',()=>{
 const works=[work('series-new','series','星灯长篇'),work('legacy',undefined,'旧短片'),work('film','short-film','星灯短片'),work('series-old','series','旧剧集')],before=structuredClone(works),groups=groupWorks(works);
 assert.deepEqual(groups.map(group=>[group.id,group.total,group.works.map(work=>work.id)]),[['short-film',2,['legacy','film']],['series',2,['series-new','series-old']]]);
 assert.equal(groups[0].works[0],works[1]);assert.equal(workType(works[1]),'short-film');assert.deepEqual(works,before);assert.equal(Object.hasOwn(works[1],'type'),false,'Grouping must not migrate or rewrite legacy user data');
 const emptySeries=groupWorks([works[1]]);assert.equal(emptySeries[1].label,'长篇剧集');assert.deepEqual(emptySeries[1].works,[]);assert.equal(emptySeries[1].total,0);
});

test('search spans both groups and combines with type filtering without moving or sorting source works',()=>{
 const works=[work('series-a','series','星灯之旅'),work('film-a',undefined,'星灯来信'),work('film-b','short-film','远山')],before=structuredClone(works);
 const search=groupWorks(works,'  星灯  ');assert.deepEqual(search.map(group=>({total:group.total,ids:group.works.map(work=>work.id)})),[{total:2,ids:['film-a']},{total:1,ids:['series-a']}]);
 assert.deepEqual(filterWorks(works,'星灯','all').map(work=>work.id),['series-a','film-a']);assert.deepEqual(filterWorks(works,'星灯','series').map(work=>work.id),['series-a']);assert.deepEqual(filterWorks(works,'星灯','short-film').map(work=>work.id),['film-a']);assert.equal(filterWorks(works,'  ANIMATION  ','all').length,3);assert.deepEqual(filterWorks(works,'长篇剧集','all').map(work=>work.id),['series-a']);assert.deepEqual(works,before);
});

test('local collapsed groups reopen matching searches and restore their prior collapse state after clearing search',()=>{
 const works=[work('series-a','series','星灯之旅'),work('film-a',undefined,'旧短片')],collapsed={'short-film':true,series:true},before=structuredClone(collapsed),groups=groupWorks(works);
 assert.equal(isWorkGroupExpanded(groups[0],'',{}),true);assert.equal(isWorkGroupExpanded(groups[1],'',{}),true);assert.equal(isWorkGroupExpanded(groups[0],'',collapsed),false);
 const searched=groupWorks(works,'星灯');assert.equal(isWorkGroupExpanded(searched[1],'星灯',collapsed),true);assert.equal(isWorkGroupExpanded(searched[0],'星灯',collapsed),false);assert.equal(isWorkGroupExpanded(groups[1],'',collapsed),false);assert.deepEqual(collapsed,before);
});

test('new and edited metadata retain the intended type, while episode requests keep their independent schema',()=>{
 const series=work('series','series','长篇作品'),legacy=work('legacy',undefined,'旧作品'),before=structuredClone({series,legacy});
 assert.equal(metadataDraft('create-work').type,'short-film');assert.equal(metadataDraft('create-work',null,null,'series').type,'series');assert.equal(metadataDraft('update-work',series).type,'series');assert.equal(metadataDraft('update-work',legacy).type,'short-film');
 const created=metadataSubmission({...metadataDraft('create-work',null,null,'series'),title:'  星灯长篇  ',synopsis:'原简介',style:'原风格'});assert.deepEqual(created,{path:'/api/works',payload:{title:'星灯长篇',synopsis:'原简介',style:'原风格',type:'series'},isWork:true,creating:true});
 const edited=metadataSubmission({...metadataDraft('update-work',series),type:'short-film'});assert.equal(edited.path,'/api/works/series/update');assert.equal(edited.payload.type,'short-film');
 const episode=metadataSubmission(metadataDraft('create-episode',series));assert.equal(episode.path,'/api/works/series/episodes');assert.equal(Object.hasOwn(episode.payload,'type'),false);assert.equal(Object.hasOwn(episode.payload,'style'),false);assert.equal(episode.payload.title,'第 2 集');assert.deepEqual({series,legacy},before);
 for(const type of [null,'all','unknown',undefined])assert.throws(()=>metadataSubmission({...metadataDraft('create-work'),title:'作品',type}),/作品类型/);
});

async function saveHarness(entry,api){
 const events={workId:null,episodes:[],tabs:[],metadata:entry,errors:[],busy:[]};
 const context=vm.createContext({metadata:entry,metadataBusy:false,metadataSubmission,noop:()=>{},setMetadataBusy:value=>events.busy.push(value),setMetadataError:value=>events.errors.push(value),api,setMetadata:value=>{events.metadata=value;},setWorkId:value=>{events.workId=value;},setContentMode:value=>{events.contentMode=value;},setEpisodeId:value=>events.episodes.push(value),setTab:value=>events.tabs.push(value),refresh:async()=>{},toast:()=>{}});
 const start=source.indexOf(' const saveMetadata=async event=>{'),end=source.indexOf(' const saveTimeline=',start);assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end)+'\nglobalThis.submit=saveMetadata;',context);await context.submit({preventDefault(){}});return events;
}

test('the actual save handler sends the chosen new-work type and enters its first episode only after success',async()=>{
 const calls=[],entry={...metadataDraft('create-work',null,null,'series'),title:'星灯长篇'},created=work('new-work','series',entry.title);
 const events=await saveHarness(entry,async(path,body)=>{calls.push({path,body});return {work:created};});assert.deepEqual(plain(calls),[{path:'/api/works',body:{title:'星灯长篇',synopsis:'',style:'',type:'series'}}]);assert.equal(events.workId,'new-work');assert.deepEqual(events.episodes,['new-work-episode']);assert.deepEqual(events.tabs,['script']);assert.equal(events.metadata,null);assert.deepEqual(events.busy,[true,false]);
});

test('changing a saved work type preserves its current episode, and failed saves keep the editable draft',async()=>{
 const original=work('existing','series','原作品'),entry={...metadataDraft('update-work',original),type:'short-film'},calls=[];
 const events=await saveHarness(entry,async(path,body)=>{calls.push({path,body});return {work:{...original,type:body.type}};});assert.equal(calls[0].path,'/api/works/existing/update');assert.equal(calls[0].body.type,'short-film');assert.deepEqual(events.episodes,[]);assert.deepEqual(events.tabs,[]);
 const failed=await saveHarness(entry,async()=>{throw new Error('模拟保存失败');});assert.equal(failed.metadata,entry);assert.equal(failed.workId,null);assert.deepEqual(failed.episodes,[]);assert.equal(failed.errors.at(-1),'模拟保存失败');assert.deepEqual(failed.busy,[true,false]);
});
