import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeTranscriptionJob,savedTranscriptionLines,transcriptionIsActive,transcriptionJobsForAsset,transcriptionLineState,transcriptionPayload,transcriptionQuality,transcriptionTime} from '../frontend/src/transcription-ui.mjs';

test('ASR expected text comes from persisted cue lines in order, never draft recipes or prose',()=>{
 const shot={productionCues:{revision:3,cues:{dialogue:[{id:'a',text:'示例已经准备好。'},{id:'b',text:'收到示例了！'}]}},executionPrompt:{draft:{recipe:{integrated_multimodal_description:'<d>[Chinese]未保存的句子</d>'}}}};
 assert.deepEqual(savedTranscriptionLines(shot).lines,[{id:'a',text:'示例已经准备好。'},{id:'b',text:'收到示例了！'}]);
 assert.deepEqual(savedTranscriptionLines({productionCues:{cues:{dialogue:[]}},executionPrompt:{compilation:{sourceRecipe:{integrated_multimodal_description:'<d>[Chinese]旧句</d>'}}}}).lines,[]);
 assert.deepEqual(savedTranscriptionLines({visualInstructions:'不应当识别的制作备注',executionPrompt:shot.executionPrompt}).lines,[]);
});
test('compiled fallback extracts only tagged Chinese original lines and preserves punctuation',()=>{
 const shot={executionPrompt:{compilation:{sourceRecipe:{integrated_multimodal_description:'Example role A says <d>[Chinese]请确认。</d> Another says <d>[Chinese]可以开始了吗？</d> Do not read this prose.'}}}};
 assert.deepEqual(savedTranscriptionLines(shot).lines,[{text:'请确认。'},{text:'可以开始了吗？'}]);
});
test('transcription request carries only registered asset ID and confirmed expected lines',()=>{
 assert.deepEqual(transcriptionPayload('work','asset',' 示例已经准备好。\r\n\n收到示例了！ '),{workId:'work',source:{kind:'asset',id:'asset'},expectedLines:[{text:'示例已经准备好。'},{text:'收到示例了！'}]});
 assert.deepEqual(transcriptionPayload('work','asset',''),{workId:'work',source:{kind:'asset',id:'asset'}});
 assert.throws(()=>transcriptionPayload('work',null,'句子'),/选择/);
 assert.throws(()=>transcriptionPayload('work','asset',Array(202).fill('句子').join('\n')),/200行/);
});
test('history is confined to the current work and exact selected asset version',()=>{
 const job=(id,workId,kind,asset,createdAt)=>({id,workId,request:{source:{kind,id:asset}},createdAt});
 const jobs=[job('old','w','asset','a','2026-10-15T01:00:00Z'),job('new','w','asset','a','2026-10-15T02:00:00Z'),job('other-work','v','asset','a','2026-10-15T03:00:00Z'),job('media','w','media','a','2026-10-15T03:00:00Z'),job('other-version','w','asset','b','2026-10-15T03:00:00Z')];
 assert.deepEqual(transcriptionJobsForAsset(jobs,'w','a').map(item=>item.id),['new','old']);assert.equal(jobs[0].id,'old');
});
test('late in-progress reads cannot regress a completed transcription but new jobs remain distinct',()=>{
 const done={id:'a',status:'succeeded',result:{text:'原声'}},running={id:'a',status:'running'};
 assert.equal(mergeTranscriptionJob(done,running),done);assert.deepEqual(mergeTranscriptionJob(done,{id:'b',status:'queued'}),{id:'b',status:'queued'});
 assert.equal(transcriptionIsActive({status:'queued'}),true);assert.equal(transcriptionIsActive({status:'succeeded'}),false);
});
test('ASR result labels distinguish literal, normalized, absent and missing evidence without hearing claims',()=>{
 assert.equal(transcriptionLineState({rawExact:true}).label,'原句检出');assert.equal(transcriptionLineState({rawExact:false,normalized:true}).label,'规范化后检出');
 assert.match(transcriptionLineState({rawExact:false,normalized:false}).label,/试听/);assert.equal(transcriptionLineState({}).label,'未记录');
 assert.equal(transcriptionTime(2.345),'00:02.345');assert.equal(transcriptionTime(65.9998),'01:06.000');assert.equal(transcriptionTime(null),'未记录');
});
test('ASR quality compares offsets to measured audio with 50ms tolerance and never clamps or changes original segments',()=>{
 const segments=[{start:0,end:5.20,text:'原句'},{start:5,end:6,text:'原句'}],before=structuredClone(segments);
 const quality=transcriptionQuality({full:{audio:{duration:5.184},source:{probe:{duration:5.166688}}},job:{audio:{duration:9}},segments});
 assert.equal(quality.inputDuration,5.184);assert.equal(quality.sourceDuration,5.166688);assert.deepEqual(quality.outOfBounds,[1]);assert.deepEqual(quality.repeated,[1]);assert.match(quality.warning,/时码超出实测原音/);assert.match(quality.warning,/可能幻听，须听原音/);assert.deepEqual(segments,before);
 assert.equal(transcriptionQuality({job:{audio:{duration:5}},segments:[{end:5.05,text:'甲'}]}).warning,null);assert.deepEqual(transcriptionQuality({job:{audio:{duration:5}},segments:[{end:5.051,text:'甲'}]}).outOfBounds,[0]);
});
test('ASR quality duration fallback never uses requested duration and repetition means adjacent identical text only',()=>{
 assert.equal(transcriptionQuality({job:{audio:{duration:4},sourceSnapshot:{probe:{duration:3}}}}).inputDuration,4);
 assert.equal(transcriptionQuality({job:{sourceSnapshot:{probe:{duration:3}},request:{duration:10}}}).inputDuration,3);
 const result=transcriptionQuality({job:{request:{duration:10}},segments:[{end:99,text:'甲'},{text:'乙'},{text:'甲'},{text:' 甲 '},{text:''},{text:''}]});
 assert.equal(result.inputDuration,null);assert.deepEqual(result.outOfBounds,[]);assert.deepEqual(result.repeated,[3]);assert.match(result.warning,/相邻识别文本重复/);
});
