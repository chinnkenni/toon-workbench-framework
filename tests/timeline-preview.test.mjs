import test from 'node:test';
import assert from 'node:assert/strict';
import {exportMode,exportPreviewInfo,isExportCurrent} from '../public/timeline-preview.js';
import {buildStoryboardCaption} from '../storyboard-captions.mjs';

function fixture(){
  const work={shots:[{id:'one',selectedAssetId:'one-a'},{id:'two',selectedAssetId:'two-a'},{id:'unused',selectedAssetId:'unused-a'}],assets:[{id:'one-a',shotId:'one',type:'video'},{id:'one-b',shotId:'one',type:'video'},{id:'two-a',shotId:'two',type:'video'},{id:'unused-a',shotId:'unused',type:'video'}]};
  const timeline={width:1280,height:720,fps:24,updatedAt:'old',clips:[
    {id:'intro',type:'title',role:'intro',title:'片头',subtitle:'第一集',duration:2,trimStart:0,muted:false,enabled:true},
    {id:'clip-one',type:'shot',shotId:'one',role:null,title:'画面一',subtitle:'',duration:4,trimStart:0,muted:false,enabled:true},
    {id:'clip-two',type:'shot',shotId:'two',role:null,title:'画面二',subtitle:'',duration:4,trimStart:1,muted:false,enabled:true},
    {id:'disabled',type:'shot',shotId:'unused',duration:5,enabled:false},
    {id:'outro',type:'media',role:'outro',title:'片尾',subtitle:'',mediaId:'outro-video',duration:2,trimStart:0,muted:false,enabled:true},
  ],audio:[{id:'sound',kind:'music',mediaId:'music-a',start:0,trimStart:1,duration:10,gain:0.4,loop:true,enabled:true},{id:'voice',kind:'voice',mediaId:'voice-a',start:2,trimStart:0,duration:4,gain:1,loop:false,enabled:true},{id:'off',kind:'sfx',mediaId:'ignored',start:0,duration:1,enabled:false}]};
  const job={timelineSnapshot:structuredClone(timeline),selectionSnapshot:work.shots.map(shot=>({shotId:shot.id,selectedAssetId:shot.selectedAssetId}))};
  return {work,timeline,job};
}

test('current preview ignores timestamps, unknown metadata and object key order',()=>{
  const {work,timeline,job}=fixture();assert.equal(isExportCurrent(work,timeline,job),true);
  timeline.updatedAt='new';timeline.label='编辑器备注';timeline.clips[1].createdAt='new';timeline.audio[0].waveform=[1,2,3];
  timeline.clips=timeline.clips.map(clip=>Object.fromEntries(Object.entries(clip).reverse()));
  timeline.audio=timeline.audio.map(track=>Object.fromEntries(Object.entries(track).reverse()));
  timeline.clips[0].color='#101827';
  assert.equal(isExportCurrent(work,timeline,job),true);
});

test('override scope stays independent even when its frozen edit happens to equal the full timeline',()=>{
 const {work,timeline,job}=fixture();job.timelineSource='override';job.durationSeconds=811/24;
 assert.equal(isExportCurrent(work,timeline,job),false);assert.equal(exportPreviewInfo(job).label,'动态试片');assert.equal(exportPreviewInfo(job).clipCount,4);assert.equal(exportPreviewInfo(job).shotCount,2);
 job.exportOptions={mode:'storyboard'};assert.equal(exportPreviewInfo(job).label,'故事板预演');assert.equal(exportPreviewInfo(job).scopeLabel,'独立静态预演快照');assert.equal(isExportCurrent(work,timeline,job),false);
});

test('preview becomes stale after changing shot selection or fallback video',()=>{
  const {work,timeline,job}=fixture();work.shots[0].selectedAssetId='one-b';assert.equal(isExportCurrent(work,timeline,job),false);
  delete work.shots[0].selectedAssetId;work.assets.splice(1,1);assert.equal(isExportCurrent(work,timeline,job),true);
  work.assets.push({id:'one-new',shotId:'one',type:'video'});assert.equal(isExportCurrent(work,timeline,job),false);
  work.shots[0].selectedAssetId='foreign';assert.equal(isExportCurrent(work,timeline,job),false);
});

test('a frozen clip uses its explicit asset rather than the changed shot selection',()=>{
  const {work,timeline,job}=fixture();timeline.clips[1].assetId='one-a';job.timelineSnapshot=structuredClone(timeline);work.shots[0].selectedAssetId='one-b';job.selectionSnapshot[0].selectedAssetId='one-b';
  assert.equal(isExportCurrent(work,timeline,job),true);
  timeline.clips[1].assetId='one-b';assert.equal(isExportCurrent(work,timeline,job),false);
});

test('reframe coordinates and source dimensions invalidate exports while clearing and legacy null retain their meaning',()=>{
 const {work,timeline,job}=fixture(),assetId='00000000-0000-4000-8000-000000000004',rect={sourceWidth:800,sourceHeight:600,x:100,y:50,width:400,height:300};Object.assign(work.assets[0],{id:assetId,width:800,height:600});Object.assign(work.shots[0],{selectedAssetId:assetId,assetIds:[assetId]});Object.assign(timeline.clips[1],{assetId,reframe:rect});job.timelineSnapshot=structuredClone(timeline);
 assert.equal(isExportCurrent(work,timeline,job),true);timeline.clips[1].reframe.x=101;assert.equal(isExportCurrent(work,timeline,job),false);timeline.clips[1].reframe.x=100;assert.equal(isExportCurrent(work,timeline,job),true);
 delete timeline.clips[1].reframe;assert.equal(isExportCurrent(work,timeline,job),false);delete job.timelineSnapshot.clips[1].reframe;assert.equal(isExportCurrent(work,timeline,job),true);timeline.clips[1].reframe=null;assert.equal(isExportCurrent(work,timeline,job),true);job.timelineSnapshot.clips[1].reframe=null;delete timeline.clips[1].reframe;assert.equal(isExportCurrent(work,timeline,job),true);
 timeline.clips[1].reframe=structuredClone(rect);job.timelineSnapshot=structuredClone(timeline);work.assets[0].width=801;assert.equal(isExportCurrent(work,timeline,job),false,'a changed registered source size cannot reuse a frozen rectangle');work.assets[0].width=800;job.timelineSource='override';assert.equal(isExportCurrent(work,timeline,job),false);
});

test('dynamic currentness resolves per-clip snapshots before a shot-level legacy fallback',()=>{
 const {work,timeline,job}=fixture();timeline.clips[2].shotId='one';timeline.clips[2].trimStart=0;job.timelineSnapshot=structuredClone(timeline);job.selectionSnapshot=[{shotId:'one',selectedAssetId:'one-b'},{clipId:'clip-one',shotId:'one',selectedAssetId:'one-a'},{clipId:'clip-two',shotId:'one',selectedAssetId:'one-a'}];assert.equal(isExportCurrent(work,timeline,job),true);job.selectionSnapshot[2].selectedAssetId='one-b';assert.equal(isExportCurrent(work,timeline,job),false);job.selectionSnapshot[2].selectedAssetId='one-a';job.selectionSnapshot.reverse();assert.equal(isExportCurrent(work,timeline,job),true);
});

test('trim, duration, order, mute, titles, visual sources and canvas changes invalidate preview',()=>{
  const changes=[value=>value.clips[1].trimStart=0.5,value=>value.clips[1].duration=5,value=>[value.clips[1],value.clips[2]]=[value.clips[2],value.clips[1]],value=>value.clips[1].muted=true,value=>value.clips[0].title='新片头',value=>value.clips[0].subtitle='第二集',value=>value.clips[0].background='ffffff',value=>value.clips[4].mediaId='other-video',value=>value.width=720,value=>value.height=1280,value=>value.fps=30,value=>value.clips[1].enabled=false];
  for(const change of changes){const {work,timeline,job}=fixture();change(timeline);assert.equal(isExportCurrent(work,timeline,job),false);}
});

test('audio timing, trimming, volume, looping, source, order and enable changes invalidate preview',()=>{
  const changes=[value=>value.audio[0].start=1,value=>value.audio[0].trimStart=2,value=>value.audio[0].duration=8,value=>value.audio[0].gain=0.5,value=>value.audio[0].loop=false,value=>value.audio[0].mediaId='music-b',value=>value.audio[0].enabled=false,value=>[value.audio[0],value.audio[1]]=[value.audio[1],value.audio[0]]];
  for(const change of changes){const {work,timeline,job}=fixture();change(timeline);assert.equal(isExportCurrent(work,timeline,job),false);}
});

test('audio fades and gain envelopes require an updated whole-film export while empty defaults match old snapshots',()=>{
 const {work,timeline,job}=fixture();timeline.audio[0].fadeIn=0;timeline.audio[0].fadeOut=0;timeline.audio[0].envelope=[];assert.equal(isExportCurrent(work,timeline,job),true);
 timeline.audio[0].fadeIn=.5;assert.equal(isExportCurrent(work,timeline,job),false);timeline.audio[0].fadeIn=0;timeline.audio[0].envelope=[{time:0,gain:1},{time:2,gain:.25}];assert.equal(isExportCurrent(work,timeline,job),false);job.timelineSnapshot=structuredClone(timeline);assert.equal(isExportCurrent(work,timeline,job),true);timeline.audio[0].envelope[1].gain=.4;assert.equal(isExportCurrent(work,timeline,job),false);
});

test('disabled or unused material changes do not invalidate the rendered preview',()=>{
  const {work,timeline,job}=fixture();
  timeline.clips[3].duration=30;timeline.clips[3].shotId='not-in-work';timeline.clips[3].trimStart=10;timeline.audio[2].gain=2;timeline.audio[2].mediaId='another-ignored';work.shots[2].selectedAssetId='new-unused';
  timeline.clips.push({id:'other-disabled',type:'shot',shotId:'missing',enabled:false});
  assert.equal(isExportCurrent(work,timeline,job),true);
  timeline.clips[3].enabled=true;assert.equal(isExportCurrent(work,timeline,job),false);
});

test('missing snapshots, unresolved sources and invalid settings never count as current',()=>{
  const {work,timeline,job}=fixture();
  for(const incomplete of [{},{selectionSnapshot:[]},{timelineSnapshot:timeline},{timelineSnapshot:null,selectionSnapshot:[]}])assert.equal(isExportCurrent(work,timeline,incomplete),false);
  const absent=structuredClone(job);absent.selectionSnapshot=[];assert.equal(isExportCurrent(work,timeline,absent),false);
  work.assets=[];assert.equal(isExportCurrent(work,timeline,job),false);
  timeline.width=NaN;assert.equal(isExportCurrent(work,timeline,job),false);
});

test('storyboard currentness follows frozen first frames, planned dialogue and speakers rather than later video picks',()=>{
 const {work,timeline,job}=fixture();work.studio={media:[{id:'frame-one',type:'image',bytes:10,relativePath:'one.png'},{id:'frame-two',type:'image',bytes:12,relativePath:'two.png'}],libraries:{characters:[{id:'role',name:'示例角色甲'}]}};
 work.shots[0].firstFrameMediaId='frame-one';work.shots[1].firstFrameMediaId='frame-two';work.shots[0].productionCues={schemaVersion:1,revision:1,cues:{dialogue:[{speakerId:'role',speakerLabel:'S1',text:'请查看。'}]}};job.exportOptions={mode:'storyboard',enhance:'none'};
 job.selectionSnapshot=work.shots.slice(0,2).map(shot=>({shotId:shot.id,firstFrameMediaId:shot.firstFrameMediaId,firstFrameSnapshot:structuredClone(work.studio.media.find(item=>item.id===shot.firstFrameMediaId)),captionSnapshot:buildStoryboardCaption(work,shot,{duration:4})}));
 assert.equal(exportMode({}), 'video');assert.equal(exportMode({mode:'storyboard'}),'storyboard');assert.equal(isExportCurrent(work,timeline,job),true);work.shots[0].selectedAssetId='one-b';assert.equal(isExportCurrent(work,timeline,job),true);
 work.studio.libraries.characters[0].name='示例角色乙';assert.equal(isExportCurrent(work,timeline,job),false);work.studio.libraries.characters[0].name='示例角色甲';work.shots[0].productionCues.cues.dialogue[0].text='新台词';assert.equal(isExportCurrent(work,timeline,job),false);work.shots[0].productionCues.cues.dialogue[0].text='请查看。';
 work.studio.media[0].bytes=11;assert.equal(isExportCurrent(work,timeline,job),false);work.studio.media[0].bytes=10;work.shots[0].firstFrameMediaId='frame-two';assert.equal(isExportCurrent(work,timeline,job),false);
});

test('storyboard preview detects a changed registered SHA at the same image ID and size without filling legacy hashes',()=>{
 const image={id:'frame',type:'image',relativePath:'frame.png',bytes:10,sha256:'a'.repeat(64)},shot={id:'shot',firstFrameMediaId:'frame'},work={shots:[shot],studio:{media:[image]}};
 const timeline={width:1280,height:720,fps:24,clips:[{id:'cut',type:'shot',shotId:'shot',duration:4}],audio:[]},entry={clipId:'cut',shotId:'shot',firstFrameMediaId:'frame',firstFrameSnapshot:structuredClone(image),captionSnapshot:buildStoryboardCaption(work,shot,{duration:4})},job={exportOptions:{mode:'storyboard'},timelineSnapshot:structuredClone(timeline),selectionSnapshot:[entry]};
 assert.equal(isExportCurrent(work,timeline,job),true);image.sha256='b'.repeat(64);assert.equal(isExportCurrent(work,timeline,job),false);delete entry.firstFrameSnapshot.sha256;assert.equal(isExportCurrent(work,timeline,job),true,'legacy absent SHA stays absent rather than using current registration');assert.equal(entry.firstFrameSnapshot.sha256,undefined);
 entry.firstFrameSnapshot.sha256='a'.repeat(64);delete image.sha256;assert.equal(isExportCurrent(work,timeline,job),true);image.sha256='unrecorded';assert.equal(isExportCurrent(work,timeline,job),true);
});
test('storyboard selection uses the exact clip ID for multiple cuts of one shot, with legacy shot-only fallback',()=>{
 const shot={id:'shot',firstFrameMediaId:'frame'},work={shots:[shot],studio:{media:[{id:'frame',type:'image'}]}},timeline={width:1280,height:720,fps:24,clips:[{id:'cut-a',type:'shot',shotId:'shot',duration:4},{id:'cut-b',type:'shot',shotId:'shot',duration:4}],audio:[]};
 const entry=clipId=>({clipId,shotId:'shot',firstFrameMediaId:'frame',captionSnapshot:buildStoryboardCaption(work,shot,{duration:4})}),a=entry('cut-a'),b=entry('cut-b'),job={exportOptions:{mode:'storyboard'},timelineSnapshot:structuredClone(timeline),selectionSnapshot:[a,b]};
 b.firstFrameMediaId='different-frame';assert.equal(isExportCurrent(work,timeline,job),false,'the first cut cannot satisfy both cuts');b.firstFrameMediaId='frame';job.selectionSnapshot.reverse();assert.equal(isExportCurrent(work,timeline,job),true);b.clipId='unrelated-cut';assert.equal(isExportCurrent(work,timeline,job),false,'a different cut ID is not a shot-only legacy snapshot');delete b.clipId;assert.equal(isExportCurrent(work,timeline,job),true);
});
