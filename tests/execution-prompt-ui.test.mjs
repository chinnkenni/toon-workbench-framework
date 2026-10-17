import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {executionRecipe,executionPayload,executionState,recipeSignature,selectedVideoMeasurement,submitExecutionPrompt} from '../frontend/src/execution-prompt-ui.mjs';

const recipe=()=>({integrated_multimodal_description:'[Shot 1] A black cat (S1) turns toward the lamp and says <d>[Chinese]别怕。</d>',overall_soundscape:'Soft rain outside the window.',non_diegetic_music:'No background music.',speakers:[{label:'S1',characterId:'character-a'}]});
const hash='a'.repeat(64),plain=value=>JSON.parse(JSON.stringify(value));

test('model recipe inputs never infer, translate, or append Chinese production notes and bindings',()=>{
 const production={visual:'示例角色坐在窗台',sound:'角色：别怕',music:'安静',prompt:'old concatenated character cards',characters:[{biography:'private production notes'}]};
 assert.deepEqual(executionRecipe(production),{integrated_multimodal_description:'',overall_soundscape:'',non_diegetic_music:'',speakers:[]});
 const explicit=recipe(),snapshot={draft:{recipe:explicit},compilation:{sourceRecipe:{...explicit,integrated_multimodal_description:'older'}}};assert.equal(executionRecipe(snapshot).integrated_multimodal_description,explicit.integrated_multimodal_description);const clone=executionRecipe(snapshot);clone.speakers[0].characterId='later';assert.equal(explicit.speakers[0].characterId,'character-a');assert.equal(recipeSignature(explicit),JSON.stringify(explicit));
});

test('compile and lock capture exact submitted values with revision and hash preconditions',async()=>{
 const calls=[],value=recipe(),api=async(path,body)=>{calls.push({path,body});return {executionPrompt:{revision:2}};};await submitExecutionPrompt({api,workId:'work-a',shotId:'shot-a',action:'preview',recipe:value});await submitExecutionPrompt({api,workId:'work-a',shotId:'shot-a',action:'compile',revision:4,recipe:value});await submitExecutionPrompt({api,workId:'work-a',shotId:'shot-a',action:'lock',revision:5,hash});value.speakers[0].characterId='later';value.integrated_multimodal_description='later';
 assert.equal(calls[0].path,'/api/works/work-a/studio/shots/shot-a/execution-prompt/preview');assert.deepEqual(Object.keys(calls[0].body),['recipe']);assert.equal(calls[1].body.expectedRevision,4);assert.equal(calls[1].body.recipe.speakers[0].characterId,'character-a');assert.match(calls[1].body.recipe.integrated_multimodal_description,/别怕/);assert.deepEqual(calls[2].body,{expectedRevision:5,expectedHash:hash});assert.throws(()=>executionPayload('lock',{revision:1,hash:'unknown'}),/先保存编译/);assert.throws(()=>executionPayload('compile',{revision:-1,recipe:recipe()}),/修订号/);assert.throws(()=>executionPayload('compile',{recipe:{...recipe(),speakers:[{label:'S1',characterId:''}]}}),/选择/);
});

test('generation readiness is revoked by local unsaved notes, recipe edits, server stale status and unresolved reads',()=>{
 assert.equal(executionState({status:{state:'locked'}}).canGenerate,true);for(const properties of [{dirty:true},{recipeDirty:true},{loading:true}])assert.equal(executionState({status:{state:'locked'},...properties}).canGenerate,false);for(const state of ['missing','draft','compiled','stale','unexpected'])assert.equal(executionState({status:{state}}).canGenerate,false);assert.match(executionState({status:{state:'stale'}}).label,/过期/);
});

test('selected video measurements use that media task only, and never request duration as actual output',()=>{
 const jobs=[{id:'first',assetId:'old',status:'succeeded',request:{duration:4},telemetry:{output:{durationSeconds:4.458333,frames:107,fps:24}}},{id:'latest',assetId:'new',status:'succeeded',request:{duration:5}}];assert.deepEqual(selectedVideoMeasurement(jobs,'old'),{jobId:'first',requestedSeconds:4,durationSeconds:4.458333,frames:107,fps:24});assert.deepEqual(selectedVideoMeasurement(jobs,'new'),{jobId:'latest',requestedSeconds:5,durationSeconds:null,frames:null,fps:null});assert.equal(selectedVideoMeasurement(jobs,'missing'),null);assert.equal(selectedVideoMeasurement([{assetId:'failed',status:'failed'}],'failed'),null);
});

test('actual compiled-generation handler targets the opened shot, sends explicit mode, and does not resave production notes',async()=>{
 const source=await readFile(new URL('../frontend/src/SegmentEditor.jsx',import.meta.url),'utf8'),start=source.indexOf('  async function generateCompiled(){'),end=source.indexOf('  async function cancelQueued(',start),calls=[];assert.ok(start>=0&&end>start);let ends=0;
 const context=vm.createContext({generating:false,sessionRef:{current:{dirty:false}},productionCueDirty:false,executionStatus:{canGenerate:true},begin:()=>({workId:'work-a',shotId:'shot-a'}),api:async(path,body)=>calls.push({path,body}),refreshWork:async()=>{},toast:()=>{},setError:()=>{},end:()=>ends++});vm.runInContext(source.slice(start,end),context);await context.generateCompiled();assert.deepEqual(plain(calls),[{path:'/api/works/work-a/generate',body:{shotId:'shot-a',executionMode:'compiled'}}]);assert.equal(ends,1);context.productionCueDirty=true;await context.generateCompiled();context.productionCueDirty=false;context.sessionRef.current.dirty=true;await context.generateCompiled();assert.equal(calls.length,1);context.sessionRef.current.dirty=false;context.executionStatus.canGenerate=false;await context.generateCompiled();assert.equal(calls.length,1);
});

test('queued cancellation captures its own job and work, and running tasks never expose a cancel request',async()=>{
 const source=await readFile(new URL('../frontend/src/SegmentEditor.jsx',import.meta.url),'utf8'),start=source.indexOf('  async function cancelQueued(){'),end=source.indexOf('  async function selectVersion(',start),calls=[];assert.ok(start>=0&&end>start);let ends=0;const context=vm.createContext({latestJob:{id:'job-a',status:'queued'},begin:()=>({workId:'work-a',shotId:'shot-a'}),api:async(path,body)=>calls.push({path,body}),refreshWork:async()=>{},toast:()=>{},setError:()=>{},end:()=>ends++});vm.runInContext(source.slice(start,end),context);await context.cancelQueued();assert.deepEqual(plain(calls),[{path:'/api/works/work-a/jobs/job-a/cancel',body:{}}]);assert.equal(ends,1);context.latestJob={id:'job-b',status:'running'};await context.cancelQueued();assert.equal(calls.length,1);
});

function runHarness(api){
 const calls=[],state={record:{revision:3,compilation:{hash}},status:{state:'compiled'},recipe:recipe()},context={structuredClone,disabled:false,busy:null,loading:false,productionDirty:false,recipeDirty:false,compilation:state.record.compilation,record:state.record,recipeRef:{current:state.recipe},onBegin:kind=>{calls.push({begin:kind});return {workId:'work-a'};},requestId:{current:0},setBusy:value=>calls.push({busy:value}),setLoading:()=>{},setError:value=>calls.push({error:value}),submitExecutionPrompt,apiRef:{current:api},workId:'work-a',shot:{id:'shot-a'},mounted:{current:true},setPreview:value=>calls.push({preview:value}),setStatus:value=>calls.push({status:value}),accept:(value,options)=>calls.push({accepted:value,options}),toast:message=>calls.push({toast:message}),onCommitted:async()=>{},onEnd:()=>calls.push({end:true})};return {context,calls};
}

test('actual compile handler retains committed state after refresh failure and never retries a successful mutation',async()=>{
 const source=await readFile(new URL('../frontend/src/ExecutionPromptPanel.jsx',import.meta.url),'utf8'),start=source.indexOf(' async function run(action){'),end=source.indexOf(' function addSpeaker()',start),apiCalls=[],result={executionPrompt:{revision:4,compilation:{hash,prompt:'exact model prompt'}},status:{state:'compiled'}};assert.ok(start>=0&&end>start);const h=runHarness(async(path,body)=>{apiCalls.push({path,body});return result;});h.context.onCommitted=async()=>{throw new Error('read failed');};vm.createContext(h.context);vm.runInContext(source.slice(start,end),h.context);await h.context.run('compile');assert.equal(apiCalls.length,1);assert.equal(apiCalls[0].body.expectedRevision,3);assert.equal(h.calls.find(value=>value.accepted).options.replace,true);assert.match(h.calls.filter(value=>value.error).at(-1).error,/已保存.*暂未刷新/);assert.equal(h.calls.at(-1).end,true);
});

test('actual preview is read only, and a stale lock or dirty production never sends a mutation',async()=>{
 const source=await readFile(new URL('../frontend/src/ExecutionPromptPanel.jsx',import.meta.url),'utf8'),start=source.indexOf(' async function run(action){'),end=source.indexOf(' function addSpeaker()',start),apiCalls=[],h=runHarness(async(path,body)=>{apiCalls.push({path,body});return {preview:{hash,prompt:'exact preview'},status:{state:'compiled'}};});vm.createContext(h.context);vm.runInContext(source.slice(start,end),h.context);await h.context.run('preview');assert.equal(apiCalls.length,1);assert.equal(Object.hasOwn(apiCalls[0].body,'expectedRevision'),false);assert.equal(h.calls.some(value=>value.accepted),false);assert.equal(h.calls.find(value=>value.preview).preview.prompt,'exact preview');h.context.productionDirty=true;await h.context.run('compile');h.context.productionDirty=false;h.context.status={state:'stale'};await h.context.run('lock');h.context.status={state:'compiled'};h.context.recipeDirty=true;await h.context.run('lock');assert.equal(apiCalls.length,1);
});
