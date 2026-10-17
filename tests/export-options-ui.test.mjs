import test from 'node:test';
import assert from 'node:assert/strict';
import {exportOutput} from '../frontend/src/export-options-ui.mjs';
import {publishingExportLabel} from '../frontend/src/publishing-ui.mjs';

test('export form defaults to video while explicit storyboard forces CPU original size even if stale UI AI choice survives',()=>{
 assert.deepEqual(exportOutput({width:1280,height:720}),{mode:'video',enhance:'none',width:1280,height:720});
 assert.deepEqual(exportOutput({mode:'video',enhance:'ai-1080p',ready:true,width:1280,height:720}),{mode:'video',enhance:'ai-1080p',width:1920,height:1080});
 assert.deepEqual(exportOutput({mode:'storyboard',enhance:'ai-1080p',ready:true,width:1280,height:720}),{mode:'storyboard',enhance:'none',width:1280,height:720});
 assert.throws(()=>exportOutput({mode:'auto'}),/请选择/);
});
test('publishing source label distinguishes static previs when it is explicitly offered',()=>{
 assert.match(publishingExportLabel({id:'export-id',mode:'storyboard',episodeTitle:'第一集'}),/^故事板预演 · 第一集/);
 assert.doesNotMatch(publishingExportLabel({id:'export-id',episodeTitle:'第一集'}),/故事板预演/);
});
