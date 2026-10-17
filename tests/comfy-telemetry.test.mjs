import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectComfyTelemetry, expectedVideo } from '../comfy-telemetry.mjs';

const baseUrl = 'http://127.0.0.1:19188';
const request = { prompt: 'A quiet animation test.', duration: 4, resolution: '352P', ratio: '16:9' };
const video = Buffer.from('This is a fixture for exact artifact correlation, not a generated video.');
const sha256 = createHash('sha256').update(video).digest('hex');
const promptId = '00000000-0000-4000-8000-000000000003';
const clone = value => structuredClone(value);
function record(id = promptId, file = 'toonflow_h3_00002_.mp4') {
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
    '6': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['1', 0], shift_video: 12, shift_audio: 3 } },
    '7': { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: request.prompt, width: 608, height: 352, length: 96 } },
    '8': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: 'blurry' } },
    '9': { class_type: 'KSampler', inputs: { model: ['6', 0], positive: ['7', 0], negative: ['8', 0], latent_image: ['7', 1], seed: 3019990633, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } },
    '11': { class_type: 'VAEDecodeAudio', inputs: { samples: ['9', 0], vae: ['4', 0] } },
    '12': { class_type: 'CreateVideo', inputs: { images: ['10', 0], fps: 24, audio: ['11', 0] } },
    '13': { class_type: 'SaveVideo', inputs: { video: ['12', 0], filename_prefix: 'rack/toonflow_h3' } },
  };
  return {
    prompt: [2, id, graph, { client_id: 'rack-toonflow', create_time: 1792044681426 }, ['13']],
    outputs: { '13': { images: [{ filename: file, subfolder: 'rack', type: 'output' }], animated: [true] } },
    status: { status_str: 'success', completed: true, messages: [
      ['execution_start', { prompt_id: id, timestamp: 1792044681427 }],
      ['execution_cached', { prompt_id: id, timestamp: 1792044681427, nodes: ['1', '2'] }],
      ['execution_success', { prompt_id: id, timestamp: 1792044805649 }],
    ] },
  };
}
function transport(history, outputs = {}, inspect) {
  return async (url, init) => {
    inspect?.(url, init);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url === baseUrl + '/history?max_items=100') return new Response(JSON.stringify(history));
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, baseUrl + '/view');
    assert.equal(parsed.searchParams.get('subfolder'), 'rack');
    assert.equal(parsed.searchParams.get('type'), 'output');
    return new Response(outputs[parsed.searchParams.get('filename')] || video);
  };
}
const collect = (history, extra = {}, fetcher) => collectComfyTelemetry({ baseUrl, request, sha256, bytes: video.length, fetcher: fetcher || transport(history), ...extra });

test('matches full video hash, actual graph references and server workflow timestamps', async () => {
  const result = await collect({ [promptId]: record() }, { legacy: true, startedAt: '2026-10-15T06:11:21.115Z', finishedAt: '2026-10-15T06:13:30.239Z' });
  assert.equal(result.promptId, promptId);
  assert.equal(result.serverExecutionMs, 124222);
  assert.equal(result.serverStartedAt, '2026-10-15T06:11:21.427Z');
  assert.equal(result.serverFinishedAt, '2026-10-15T06:13:25.649Z');
  assert.equal(result.parameters.seed, 3019990633);
  assert.equal(result.parameters.requestedFrames, 96);
  assert.equal(result.parameters.fps, 24);
  assert.equal(result.provenance.legacy, true);
  assert.equal(result.provenance.executionScope, 'server-workflow-wall-clock');
  assert.equal(result.provenance.serverQueueMs, 1);
  assert.deepEqual(result.provenance.cachedNodes, ['1', '2']);
});
test('never sends requests to untrusted or malformed origins', async () => {
  for (const url of ['http://example.com', 'http://127.0.0.1:19188/other', 'http://localhost:19188', 'http://127.0.0.1:18189']) {
    const result = await collect({}, { baseUrl: url }, () => assert.fail('Must not contact untrusted URL'));
    assert.ok(result.unavailable);
  }
});
test('does not claim the newest task when its artifact hash differs', async () => {
  const result = await collect({ [promptId]: record() }, { sha256: 'f'.repeat(64) });
  assert.ok(result.unavailable); assert.equal(result.parameters, undefined);
});
test('refuses ambiguous identical artifacts belonging to two prompts', async () => {
  const other = '00000000-0000-4000-8000-000000000002';
  const result = await collect({ [promptId]: record(), [other]: record(other, 'toonflow_h3_00003_.mp4') });
  assert.match(result.unavailable, /多个/); assert.equal(result.promptId, undefined);
});
test('validates requested text, dimensions and frame length before hash downloads', async () => {
  for (const [field, value] of [['prompt', 'A different request'], ['width', 864], ['length', 124]]) {
    const item = record(); item.prompt[2]['7'].inputs[field] = value;
    const urls = [];
    const result = await collect({ [promptId]: item }, {}, transport({ [promptId]: item }, {}, url => urls.push(url)));
    assert.ok(result.unavailable); assert.equal(urls.length, 1);
  }
});
test('long durations correlate their exact H3 graph and artifact for both text and first-frame modes', async () => {
  for (const [duration, length] of [[7,175],[15,362]]) for (const firstFrame of [false,true]) {
    const item = record(); item.prompt[2]['7'].inputs.length = length;
    if (firstFrame) {
      item.prompt[2]['15'] = { class_type:'LoadImage', inputs:{image:'registered-frame.png'} };
      item.prompt[2]['7'].inputs.first_frame = ['15',0];
    }
    const history = {[promptId]:item}, before = JSON.stringify(history), urls=[];
    const result = await collect(history, {request:{...request,duration}}, transport(history,{},url=>urls.push(url)));
    assert.equal(result.promptId,promptId);assert.equal(result.parameters.requestedFrames,length);
    assert.equal(result.parameters.mode,firstFrame?'image-to-video':'text-to-video');
    assert.equal(result.serverExecutionMs,124222);assert.equal(result.provenance.matchedBy,'exact-video-sha256-and-workflow-parameters');
    assert.equal(urls.length,2);assert.equal(JSON.stringify(history),before,'read-only verification must not rewrite history');
  }
});
test('a 7-second request never claims an old four-second graph even when artifact bytes match', async () => {
  const history = {[promptId]:record()},urls=[];
  const result = await collect(history,{request:{...request,duration:7}},transport(history,{},url=>urls.push(url)));
  assert.ok(result.unavailable);assert.equal(result.parameters,undefined);assert.equal(result.promptId,undefined);
  assert.equal(urls.length,1,'mismatched duration is rejected before downloading artifact bytes');
});
test('historical four and five second input lengths remain exact during full artifact correlation', async () => {
  for (const [duration,length,rejectedLength] of [[4,96,107],[5,124,120]]) {
    const item=record();item.prompt[2]['7'].inputs.length=length;
    const result=await collect({[promptId]:item},{request:{...request,duration},legacy:true});
    assert.equal(result.parameters.requestedFrames,length);assert.equal(result.promptId,promptId);assert.equal(result.provenance.legacy,true);
    item.prompt[2]['7'].inputs.length=rejectedLength;
    assert.ok((await collect({[promptId]:item},{request:{...request,duration},legacy:true})).unavailable);
  }
});
test('duration expectations permit only integer 4–15 seconds and retain the input/output distinction', async () => {
  assert.equal(expectedVideo(request).requestedFrames,96);
  assert.equal(expectedVideo({...request,duration:5}).requestedFrames,124);
  for(let duration=6;duration<=15;duration++)assert.equal(expectedVideo({...request,duration}).requestedFrames,17*Math.ceil((24*duration-5)/17)+5);
  for(const duration of [undefined,null,'7',3,4.5,15.1,16,Infinity,NaN]) {
    assert.equal(expectedVideo({...request,duration}),null);
    const result=await collect({}, {request:{...request,duration}},()=>assert.fail('invalid duration must not request remote history'));
    assert.ok(result.unavailable);
  }
  assert.deepEqual(expectedVideo({...request,duration:7,resolution:'480P',ratio:'9:16'}),{width:480,height:864,requestedFrames:175});
});
test('does not accept unrelated graph nodes as evidence of the saved artifact', async () => {
  const item = record(); item.prompt[2]['10'].inputs.samples = ['999', 0];
  const result = await collect({ [promptId]: item });
  assert.ok(result.unavailable);
});
test('missing or reversed success timestamps never produce a duration', async () => {
  for (const missing of [true, false]) {
    const item = record();
    if (missing) item.status.messages.pop(); else item.status.messages.at(-1)[1].timestamp = 1792044000000;
    const result = await collect({ [promptId]: item });
    assert.ok(result.unavailable); assert.equal(result.serverExecutionMs, undefined);
    assert.equal(result.promptId, promptId); assert.equal(result.parameters.seed, 3019990633);
    assert.equal(result.provenance.timestampSource, null);
  }
});
test('extracts actual sampler settings instead of copying assumed provider defaults', async () => {
  const item = record(); Object.assign(item.prompt[2]['9'].inputs, { seed: 42, steps: 25, cfg: 1.2, scheduler: 'normal' });
  const result = await collect({ [promptId]: item });
  assert.equal(result.parameters.steps, 25); assert.equal(result.parameters.cfg, 1.2); assert.equal(result.parameters.seed, 42); assert.equal(result.parameters.scheduler, 'normal');
});
test('skips definitely oversized mismatches but still uniquely matches a later artifact', async () => {
  const other = '00000000-0000-4000-8000-000000000002';
  const history = { [other]: record(other, 'toonflow_h3_00001_.mp4'), [promptId]: record() };
  const result = await collect(history, {}, transport(history, { 'toonflow_h3_00001_.mp4': Buffer.alloc(video.length + 1) }));
  assert.equal(result.promptId, promptId);
});
test('history size and maximum candidate bounds prevent unbounded downloads', async () => {
  let requests = 0;
  const huge = await collect({}, {}, async () => { requests++; return new Response('{}', { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } }); });
  assert.ok(huge.unavailable); assert.equal(requests, 1);
  const history = {};
  for (let index = 0; index < 9; index++) { const id = `fa88edf5-ebd7-4005-9aa6-a2c99282344${index}`; history[id] = record(id, `toonflow_h3_${index}_.mp4`); }
  const urls = [];
  const result = await collect(history, {}, transport(history, {}, url => urls.push(url)));
  assert.match(result.unavailable, /超过 8/); assert.equal(urls.length, 1);
});
test('failed downloads and missing artifacts remain explicitly unavailable', async () => {
  const history = { [promptId]: record() };
  const result = await collect(history, {}, async (url, init) => url.includes('/history') ? transport(history)(url, init) : new Response('', { status: 404 }));
  assert.match(result.unavailable, /HTTP 404/); assert.equal(result.parameters, undefined);
});

test('repeated prompts beyond eight histories use the current time window before exact hash correlation', async () => {
  const history = { [promptId]: record() };
  for (let index = 0; index < 10; index++) {
    const id = `aa88edf5-ebd7-4005-9aa6-a2c9928234${String(index).padStart(2, '0')}`;
    const item = record(id, `toonflow_h3_old_${index}_.mp4`);
    for (const message of item.status.messages) message[1].timestamp -= 3600_000;
    history[id] = item;
  }
  const urls = [];
  const result = await collect(history, { startedAt: '2026-10-15T06:11:21.115Z', finishedAt: '2026-10-15T06:13:30.239Z' }, transport(history, {}, url => urls.push(url)));
  assert.equal(result.promptId, promptId);
  assert.equal(result.provenance.timeWindowCheck, 'within-30-seconds');
  assert.equal(urls.length, 2); // One history plus only the current artifact.
});
test('time window permits up to thirty seconds of clock drift but never replaces artifact hashing', async () => {
  const item = record();
  for (const message of item.status.messages) message[1].timestamp += 29_000;
  const options = { startedAt: '2026-10-15T06:11:21.115Z', finishedAt: '2026-10-15T06:13:30.239Z' };
  const result = await collect({ [promptId]: item }, options);
  assert.equal(result.promptId, promptId);
  const wrongArtifact = await collect({ [promptId]: item }, { ...options, sha256: 'f'.repeat(64) });
  assert.ok(wrongArtifact.unavailable); assert.equal(wrongArtifact.promptId, undefined);
});
test('unsynchronized clocks remain unavailable without falling back to the most recent history', async () => {
  const urls = [], history = { [promptId]: record() };
  const result = await collect(history, { startedAt: '2026-10-15T07:11:21.115Z', finishedAt: '2026-10-15T07:13:30.239Z' }, transport(history, {}, url => urls.push(url)));
  assert.match(result.unavailable, /时钟可能不同步/);
  assert.equal(result.promptId, undefined); assert.equal(result.parameters, undefined); assert.equal(urls.length, 1);
});
test('missing server timestamps cannot falsely prune a candidate to force a unique match', async () => {
  const other = '00000000-0000-4000-8000-000000000002';
  const item = record(other, 'toonflow_h3_00003_.mp4'); item.status.messages = [];
  const history = { [promptId]: record(), [other]: item };
  const result = await collect(history, { startedAt: '2026-10-15T06:11:21.115Z', finishedAt: '2026-10-15T06:13:30.239Z' });
  assert.match(result.unavailable, /多个/); assert.equal(result.promptId, undefined);
  const single = await collect({ [other]: item }, { startedAt: '2026-10-15T06:11:21.115Z', finishedAt: '2026-10-15T06:13:30.239Z' });
  assert.equal(single.promptId, other); assert.equal(single.parameters.seed, 3019990633);
  assert.equal(single.serverExecutionMs, undefined); assert.equal(single.provenance.timeWindowCheck, 'server-events-unavailable');
});
