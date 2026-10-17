import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {H3_REQUEST_DURATIONS,h3RequestDuration} from '../frontend/src/segment-duration-ui.mjs';
import {selectedVideoMeasurement} from '../frontend/src/execution-prompt-ui.mjs';

const source=await readFile(new URL('../frontend/src/SegmentEditor.jsx',import.meta.url),'utf8');
const context=vm.createContext({h3RequestDuration});
vm.runInContext(source.slice(source.indexOf('function restoreValues('),source.indexOf('function saveDraft(')),context);

test('duration selection exposes every integer 4 through 15 and rejects coercion of invalid saved inputs',()=>{
 assert.deepEqual(H3_REQUEST_DURATIONS,[4,5,6,7,8,9,10,11,12,13,14,15]);
 for(const duration of H3_REQUEST_DURATIONS){assert.equal(h3RequestDuration(duration),duration);assert.equal(h3RequestDuration(String(duration)),duration);}
 for(const value of [null,undefined,true,false,{},[],NaN,Infinity,-1,0,3,16,7.5,'','7.5','7x',' 7 ','0x7','1e1'])assert.equal(h3RequestDuration(value),null);
});
test('actual editor draft restoration retains 7 and 15 seconds without altering base values or timeline occupancy',()=>{
 const base={title:'镜头',duration:5,characterIds:['role']},timeline={clips:[{id:'clip',duration:4}]};
 for(const duration of [7,'7',15,'15'])assert.equal(context.restoreValues(base,{duration}).duration,Number(duration));
 for(const duration of [null,true,16,7.5,'7x',Infinity])assert.equal(context.restoreValues(base,{duration}).duration,5);
 assert.equal(base.duration,5);assert.equal(timeline.clips[0].duration,4);
});
test('compatibility page duration options restore longer drafts and use saved shot duration for corrupt drafts',async()=>{
 const legacy=await readFile(new URL('../public/works.js',import.meta.url),'utf8'),start=legacy.indexOf('export function legacyDurationOptions('),end=legacy.indexOf('const stamp=',start),h=vm.createContext({});
 vm.runInContext(legacy.slice(start,end).replace('export function','function'),h);
 for(const value of [7,15,'7','15']){const html=h.legacyDurationOptions(value);assert.equal((html.match(/<option /g)||[]).length,12);assert.match(html,new RegExp(`value="${Number(value)}" selected`));assert.equal((html.match(/ selected/g)||[]).length,1);}
 assert.match(h.legacyDurationOptions('7x',9),/value="9" selected/);assert.match(h.legacyDurationOptions(null,15),/value="15" selected/);assert.match(h.legacyDurationOptions(7.5,4),/value="4" selected/);
 assert.ok(legacy.includes('legacyDurationOptions(data.duration,current.duration)'),'real compatibility select must use its validated options');
});
test('a seven-second request keeps that job actual output measurement distinct from clip occupancy and older versions',()=>{
 const jobs=[{assetId:'old',status:'succeeded',request:{duration:4},telemetry:{output:{durationSeconds:4.458333,frames:107,fps:24}}},{assetId:'new',status:'succeeded',request:{duration:7},telemetry:{output:{durationSeconds:7.291667,frames:175,fps:24}}}],clip={duration:4};
 assert.deepEqual(selectedVideoMeasurement(jobs,'new'),{jobId:undefined,requestedSeconds:7,durationSeconds:7.291667,frames:175,fps:24});assert.equal(selectedVideoMeasurement(jobs,'old').requestedSeconds,4);assert.equal(clip.duration,4);assert.equal(jobs[0].request.duration,4);
});
