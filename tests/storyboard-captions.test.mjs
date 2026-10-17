import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStoryboardCaption} from '../storyboard-captions.mjs';

const work={id:'work',studio:{libraries:{characters:[{id:'cat',name:'示例角色甲'},{id:'boy',name:'示例角色乙'}]}}};
const cue=(text,extra={})=>({id:'line-1',speakerId:'cat',speakerLabel:'S1',text,planStart:null,planEnd:null,delivery:'平静地说',performanceSource:'用户确认',anchor:{kind:'event',description:'抬头看示例角色乙'},voiceSnapshot:{versionId:'locked-source'},...extra});
const shot=dialogue=>({id:'shot-007',number:7,title:'示例角色发言',duration:5,prompt:'MUST NEVER BE USED AS DIALOGUE',productionCues:{schemaVersion:1,revision:3,updatedAt:'2026-10-16T03:00:00Z',cues:{visualPlan:{camera:'固定膝高'},dialogue,ambience:[{name:'虫鸣'}],sfx:[],music:[]},versions:[{version:1,cues:{dialogue:[cue('旧版台词不能使用')]}}]}});
const rawFor=(result,index)=>result.events.filter(event=>event.cueIndex===index).map(event=>event.rawText).join('');

test('storyboard captions freeze only saved cue originals, exact speakers and complete source evidence',()=>{
 const original=shot([cue('示例已经准备好。')]),before=JSON.stringify(original),result=buildStoryboardCaption(work,original);
 assert.equal(JSON.stringify(original),before);assert.match(result.shotLabel,/镜号 007/);assert.match(result.text,/计划对白 · 示例角色甲：示例已经准备好。/);assert.equal(result.source,'production-cues');
 assert.equal(result.dialogueSnapshot[0].speakerName,'示例角色甲');assert.equal(result.dialogueSnapshot[0].delivery,'平静地说');assert.equal(result.dialogueSnapshot[0].voiceSnapshot.versionId,'locked-source');
 assert.deepEqual(result.sourceCuesSnapshot,{schemaVersion:1,revision:3,updatedAt:'2026-10-16T03:00:00Z',cues:original.productionCues.cues});assert.equal('versions'in result.sourceCuesSnapshot,false);
 assert.doesNotMatch(JSON.stringify(result),/MUST NEVER|旧版台词/);assert.equal(result.timing.audioGenerated,false);assert.equal(result.timing.measuredSpeech,false);
 original.productionCues.cues.dialogue[0].text='后来修改';work.studio.libraries.characters[0].name='临时角色';assert.equal(result.dialogueSnapshot[0].text,'示例已经准备好。');assert.equal(result.dialogueSnapshot[0].speakerName,'示例角色甲');work.studio.libraries.characters[0].name='示例角色甲';
});

test('shots without saved dialogue never invent captions from prompts, sounds or legacy text',()=>{
 for(const item of [{id:'empty',number:1,title:'空镜',duration:4,prompt:'Here is a complete fake dialogue'},shot([])]){
  const result=buildStoryboardCaption(work,item);assert.equal(result.text,'');assert.deepEqual(result.events,[]);assert.deepEqual(result.dialogueSnapshot,[]);assert.equal(result.timing.allocation,'none');assert.match(result.shotLabel,/镜号/);
 }
});

test('complete ordered plan bounds are used as planned clip-local caption windows',()=>{
 const original=shot([cue('可以开始了吗？',{planStart:0.5,planEnd:2}),cue('可以。',{id:'line-2',speakerId:'boy',speakerLabel:'S2',planStart:3,planEnd:4.5})]);
 const result=buildStoryboardCaption(work,original,{duration:5,fps:24});assert.equal(result.timing.allocation,'saved-plan-bounds');assert.equal(result.timing.reason,null);
 assert.equal(result.events[0].start,0.5);assert.equal(result.events[0].end,2);assert.equal(result.events[1].start,3);assert.equal(result.events[1].end,4.5);assert.equal(result.events[1].speakerName,'示例角色乙');assert.equal(result.events[0].timingSource,'saved-plan-bounds');assert.equal(result.timing.kind,'planned-only');
});

test('missing or unusable plan bounds use current timeline duration and retain original plan evidence',()=>{
 for(const [first,second,reason] of [[{}, {}, 'missing-plan-bounds'],[{planStart:0,planEnd:4},{planStart:3,planEnd:4},'overlapping-or-unordered-plan'],[{planStart:0,planEnd:1},{planStart:2,planEnd:7},'outside-current-clip']]){
  const source=shot([cue('第一句',first),cue('第二句',{id:'line-2',...second})]),result=buildStoryboardCaption(work,source,{duration:4});
  assert.equal(result.timing.duration,4);assert.equal(result.timing.allocation,'equal-segments');assert.equal(result.timing.reason,reason);assert.equal(result.events[0].start,0);assert.equal(result.events[0].end,2);assert.equal(result.events[1].start,2);assert.equal(result.events[1].end,4);assert.deepEqual(result.sourceCuesSnapshot.cues,source.productionCues.cues);assert.equal(result.timing.warnings.length,1);
 }
});

test('long Chinese and Unicode captions paginate safely without losing original punctuation or whitespace',()=>{
 const sentence=('她说：“百分之100%：{\\}，猫咪👩🏽‍🚀、e\u0301与家人👨‍👩‍👧‍👦。\r\n第二行\t保持  空格。”').repeat(12),original=shot([cue(sentence)]),result=buildStoryboardCaption(work,original,{duration:15,columns:24,maxLines:3});
 assert.ok(result.events.length>10);assert.equal(rawFor(result,0),sentence);assert.equal(result.dialogueSnapshot[0].text,sentence);assert.equal(result.sourceCuesSnapshot.cues.dialogue[0].text,sentence);
 const completeGraphemes=new Set([...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(sentence)].map(item=>item.segment));
 for(const event of result.events){assert.ok(event.text.split('\n').length<=3);assert.match(event.text,/计划对白/);assert.ok(event.endFrame>event.startFrame);assert.ok(event.start>=0&&event.end<=15);for(const part of [...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(event.rawText)].map(item=>item.segment))assert.ok(completeGraphemes.has(part));}
 for(let i=1;i<result.events.length;i++)assert.equal(result.events[i-1].endFrame,result.events[i].startFrame);assert.equal(result.events.at(-1).end,15);assert.match(result.text,/100%/);assert.ok(result.text.includes('{\\}'));
});

test('a too-small saved time window falls back rather than truncating a long original',()=>{
 const text='不能截断这一句计划对白。'.repeat(20),result=buildStoryboardCaption(work,shot([cue(text,{planStart:0,planEnd:0.05})]),{duration:6,columns:24,maxLines:3});
 assert.equal(result.timing.allocation,'equal-segments');assert.equal(result.timing.reason,'insufficient-planned-frames-for-pages');assert.equal(rawFor(result,0),text);assert.equal(result.events.at(-1).end,6);assert.deepEqual(result.events[0].sourcePlan,{start:0,end:0.05});
});

test('oversized names use stable speaker labels visually while retaining complete speaker snapshots',()=>{
 const local=structuredClone(work);local.studio.libraries.characters[0].name='很长的角色名字'.repeat(40);
 const result=buildStoryboardCaption(local,shot([cue('原句保持完整。')]),{columns:12,maxLines:3});assert.equal(result.events[0].displayedSpeaker,'S1');assert.equal(result.dialogueSnapshot[0].speakerName,local.studio.libraries.characters[0].name);assert.equal(rawFor(result,0),'原句保持完整。');
 const missing=buildStoryboardCaption({studio:{libraries:{characters:[]}}},shot([cue('找不到卡片时仍有说话者标签。')]));assert.equal(missing.dialogueSnapshot[0].speakerName,null);assert.equal(missing.events[0].displayedSpeaker,'S1');
});

test('malformed or impossible captions fail explicitly instead of dropping source dialogue',()=>{
 assert.throws(()=>buildStoryboardCaption(work,shot([cue('长句'.repeat(500))]),{duration:1/24,columns:8,maxLines:3}),/不足以完整显示/);
 for(const text of ['空\0字','坏\u0001字'])assert.throws(()=>buildStoryboardCaption(work,shot([cue(text)])),/控制字符/);
 assert.throws(()=>buildStoryboardCaption(work,shot([cue('台词',{planStart:'1',planEnd:2})])),/计划时码/);
 assert.throws(()=>buildStoryboardCaption(work,shot([cue('台词',{planStart:2,planEnd:1})])),/结束时间/);
 assert.throws(()=>buildStoryboardCaption(work,{productionCues:{schemaVersion:1,revision:1,cues:{dialogue:'bad'}}}),/记录无效/);
 for(const options of [{fps:25},{duration:Infinity},{duration:0},{columns:2},{maxLines:1}])assert.throws(()=>buildStoryboardCaption(work,shot([cue('台词')]),options));
});
