import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedStyleMetrics} from '../style-metrics.mjs';

test('style metrics preserve only the same saved output/timing/rates/parameters and explicit zero/false values',()=>{
 const output={durationSeconds:107/24,containerDurationSeconds:4.5,width:864,height:480,frames:107,fps:24,hasAudio:false},telemetry={queueMs:0,productionMs:130000,serverExecutionMs:125000,totalMs:130350,parameters:{modelFile:'actual.safetensors',steps:20,cfg:1,seed:987654321,nodes:[{actual:true}]},rates:{productionFps:0.82,secondsPerVideoSecond:29.16,videoSecondsPerMinute:2.05,serverFps:null}},before=structuredClone({output,telemetry}),actual=recordedStyleMetrics({output,telemetry,includeEmpty:true});assert.deepEqual(actual,{...output,duration:null,...telemetry,generationMs:null,modelRevision:null});assert.deepEqual({output,telemetry},before);actual.parameters.nodes[0].actual=false;assert.equal(telemetry.parameters.nodes[0].actual,true);
});

test('missing or explicit-null job output and timings do not borrow media, requested duration, historical timing or derive rates',()=>{
 const actual=recordedStyleMetrics({output:{durationSeconds:null,width:null},media:{width:999,height:888,duration:4,durationSeconds:4,productionMs:10},telemetry:{productionMs:null,serverExecutionMs:null,queueMs:null,totalMs:null,parameters:null,rates:null},includeEmpty:true});for(const key of ['duration','durationSeconds','containerDurationSeconds','width','height','frames','fps','hasAudio','productionMs','queueMs','serverExecutionMs','totalMs','parameters','rates'])assert.equal(actual[key],null,key);assert.equal(recordedStyleMetrics({media:{id:'a',bytes:123}}),undefined);const flat=recordedStyleMetrics({metrics:{width:1,generationMs:1234,modelRevision:'saved-revision'}});assert.equal(flat.generationMs,1234);assert.equal(flat.modelRevision,'saved-revision');assert.equal(flat.productionMs,null);assert.equal(flat.durationSeconds,null);assert.equal(flat.rates,null);
});

test('invalid metrics stay null and unsafe or unbounded parameter trees are not exposed as production evidence',()=>{
 const actual=recordedStyleMetrics({metrics:{width:-1,height:1.5,frames:Infinity,fps:'24',productionMs:-1,queueMs:0,hasAudio:'false',parameters:{request:{api_key:'private'}},rates:{value:'-----BEGIN '+'RSA PRIVATE KEY-----'}}});assert.equal(actual.width,null);assert.equal(actual.height,null);assert.equal(actual.frames,null);assert.equal(actual.fps,null);assert.equal(actual.productionMs,null);assert.equal(actual.queueMs,0);assert.equal(actual.hasAudio,null);assert.equal(actual.parameters,null);assert.equal(actual.rates,null);const huge=recordedStyleMetrics({metrics:{parameters:{value:'x'.repeat(256*1024)}}});assert.equal(huge.parameters,null);
});
