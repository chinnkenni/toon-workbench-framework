import { readFile, writeFile, mkdir, stat, realpath, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import {performance} from 'node:perf_hooks';
import {withGpuLease} from './gpu-lease.mjs';
import {initialTelemetry,measureGeneration,writeGenerationAudit,measurementDefinitions,elapsed,calculateRates} from './generation-telemetry.mjs';
import {videoPoster} from './art-media.mjs';
import {hydrateStudio,handleStudio,studioMediaPath,validateTimeline} from './studio.mjs';
import {inheritOpEdFromPrevious} from './op-ed.mjs';
import {prepareVideoRecovery,verifyRecoveredVideo} from './works-recovery.mjs';
import {compiledExecutionForJob,executionHash} from './h3-execution.mjs';
import {renameWithWindowsRetry} from './windows-rename-retry.mjs';

const stores = new Map();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = 'MiniMax-H3-GB10';
const WORK_TYPES = ['short-film', 'series'];
const PROVIDER = 'http://127.0.0.1:19300';
const capabilities = { textToVideo: true, imageToVideo: true, audio: true, durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['352P', '480P'], ratios: ['16:9', '9:16', '1:1', '47:20'], canvasOptions: [
  {ratio:'16:9',resolution:'352P',width:608,height:352},{ratio:'16:9',resolution:'480P',width:864,height:480},
  {ratio:'9:16',resolution:'352P',width:352,height:608},{ratio:'9:16',resolution:'480P',width:480,height:864},
  {ratio:'1:1',resolution:'352P',width:512,height:512},{ratio:'1:1',resolution:'480P',width:640,height:640},
  {ratio:'47:20',resolution:'352P',width:832,height:352},
], canvasNote:'ratios/resolutions不是任意笛卡尔积；合法组合及实际节点画布见canvasOptions。47:20仅352P，按32像素网格为832×352，不是精确47:20；宽幅实机结果以实际任务回执为准。' };
const requiredFiles = {
  UNETLoader: ['unet_name', 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'],
  CLIPLoader: ['clip_name', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'],
  VAELoader: ['vae_name', 'minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors'],
};
const now = () => new Date().toISOString();
const copy = value => structuredClone(value);
function presentWork(work) {
  const result = copy(work);
  hydrateWorkType(result);
  hydrateStudio(result);
  for (const asset of result.assets || []) if (asset.type === 'video' && asset.mimeType === 'video/mp4' && UUID.test(asset.id || '')) asset.posterUrl = `/api/works/${result.id}/assets/${asset.id}/poster`;
  result.coverUrl = [...(result.assets || [])].reverse().find(asset => asset.posterUrl)?.posterUrl || null;
  return result;
}
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function workType(value) { if (!WORK_TYPES.includes(value)) fail('作品类型只能选择主题短片或长篇剧集'); return value; }
function hydrateWorkType(work) { if (!WORK_TYPES.includes(work.type)) work.type = 'short-film'; return work; }
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function id(value) { if (!UUID.test(value || '')) fail('作品、分集或分镜编号无效'); return value; }
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}${required ? '不能为空，且' : ''}最多 ${max} 字`);
  return value.trim();
}
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) fail('请求超过 128 KB', 413); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail('请求必须是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('请求必须是 JSON 对象');
  return value;
}
function inside(base, ...parts) {
  const target = resolve(base, ...parts), rel = relative(resolve(base), target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('媒体路径越界');
  return target;
}
function workspace(store, workId) { return inside(store.workspaceRoot, 'works-' + id(workId)); }
async function mediaPath(store, workId, path) {
  if (typeof path !== 'string' || !/^assets\/generated\/video[0-9a-f-]{36}\.mp4$/i.test(path)) fail('工作台返回了不属于本作品的媒体路径');
  const directory = await realpath(workspace(store, workId)), file = await realpath(inside(directory, path));
  inside(directory, relative(directory, file));
  return file;
}
function tunnel(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || +url.port < 1024 || +url.port > 65535 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
async function persist(store) {
  for (const work of store.works) { hydrateWorkType(work); hydrateStudio(work); }
  const temporary = store.file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify({ version: 1, works: store.works }, null, 2), { mode: 0o600 });
  // The serial transaction stays held while retrying this one replacement.
  // The optional filesystem adapter is supplied only by trusted isolated tests.
  await renameWithWindowsRetry(temporary, store.file, store.context.catalogPersistence);
}
function serial(store, operation) {
  const promise = store.writes.then(async () => {
    const previous = copy(store.works);
    try { return await operation(); }
    catch (error) { store.works = previous; throw error; }
  });
  store.writes = promise.catch(() => {});
  return promise;
}
async function getStore(context) {
  if (!context?.dataDir || typeof context.getState !== 'function') throw new Error('作品管理缺少本机配置');
  const base = resolve(context.dataDir, 'works');
  let pending = stores.get(base);
  if (!pending) {
    pending = (async () => {
      await mkdir(base, { recursive: true });
      const store = { base, workspaceRoot: resolve(context.dataDir, 'toonflow', 'workspaces'), file: join(base, 'catalog.json'), works: [], writes: Promise.resolve(), queue: [], running: false, models: null, modelsAt: 0, modelsKey: '', context };
      try {
        const data = JSON.parse(await readFile(store.file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.works)) throw new Error('作品索引格式不正确');
        store.works = data.works;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let changed = false;
      for (const work of store.works) {
        id(work.id);
        hydrateWorkType(work);
        if (!work.studio) changed = true;
        hydrateStudio(work);
        for (const job of work.studio.exports) if (['queued', 'running'].includes(job.status)) { job.status = 'interrupted'; job.finishedAt = now(); job.message = '应用重启，本机合成未自动重复执行；原镜头和素材保留'; changed = true; }
        for (const job of work.jobs || []) if (['queued', 'running'].includes(job.status)) {
          job.status = 'interrupted'; job.finishedAt = now(); job.message = '应用重启，原任务状态需人工核对；未重复提交到 GB10';
          const shot = work.shots.find(item => item.id === job.shotId); if (shot) shot.status = 'interrupted';
          changed = true;
        }
        for(const job of work.jobs||[])if(!job.telemetry){job.telemetry=initialTelemetry(job);changed=true;}
      }
      if (changed) await persist(store);
      return store;
    })();
    stores.set(base, pending);
    pending.catch(() => { if (stores.get(base) === pending) stores.delete(base); });
  }
  const store = await pending; store.context = context; return store;
}
function workById(store, workId) { id(workId); const work = store.works.find(item => item.id === workId); if (!work) fail('作品不存在', 404); return work; }
function validateCanvasCombination(ratio,resolution){if(ratio==='47:20'&&resolution!=='352P')fail('H3 宽幅 47:20 仅支持 352P（832×352），不支持 480P；请明确修改分辨率。');}
function shotFields(body, partial = false, current = {}) {
  const value = {};
  if (!partial || 'title' in body) value.title = text(body.title ?? '未命名分镜', '分镜名称', 120, true);
  if (!partial || 'prompt' in body) value.prompt = text(body.prompt ?? '', '提示词', 24000);
  if (!partial || 'duration' in body) { value.duration = body.duration === undefined ? 4 : body.duration; if (!Number.isInteger(value.duration) || !capabilities.durations.includes(value.duration)) fail('H3 请求时长须为 4–15 秒整数'); }
  if (!partial || 'ratio' in body) { value.ratio = body.ratio ?? '16:9'; if (!capabilities.ratios.includes(value.ratio)) fail('画幅只支持 16:9、9:16、1:1 或仅352P的47:20'); }
  if (!partial || 'resolution' in body) { value.resolution = body.resolution ?? '352P'; if (!capabilities.resolutions.includes(value.resolution)) fail('分辨率只支持 352P 或 480P'); }
  validateCanvasCombination(value.ratio??current.ratio??'16:9',value.resolution??current.resolution??'352P');return value;
}
async function discover(store, force = false) {
  const state = await store.context.getState();
  const servers = (state?.servers || []).filter(server => server.serviceLinks?.comfyui || /GB10/i.test(`${server.name || ''} ${server.metric?.gpu?.name || ''}`));
  const key = JSON.stringify(servers.map(server => [server.id, server.online, server.serviceLinks?.comfyui]));
  if (!force && store.models && store.modelsKey === key && Date.now() - store.modelsAt < 3000) return store.models;
  const fetcher = store.context.fetch || fetch;
  let providerReady = false;
  try {
    const response = await fetcher(PROVIDER + '/api/ai/media/models', { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const body = response.ok ? await response.json() : null;
    providerReady = body?.code === 200 && Array.isArray(body.data) && body.data.some(model => model.providerId === 'gb10H3' && model.modelId === MODEL && model.type === 'video');
  } catch {}
  const models = await Promise.all(servers.map(async server => {
    const baseUrl = tunnel(server.serviceLinks?.comfyui);
    const model = { id: MODEL, label: 'MiniMax H3 · GB10', provider: 'gb10H3', type: 'video', serverId: server.id, serverName: server.name, status: 'offline', available: false, message: 'GB10 离线或 SSH 服务隧道未就绪', capabilities: copy(capabilities) };
    if (!server.online || !baseUrl) return model;
    try {
      const response = await fetcher(baseUrl + '/object_info', { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
      const info = await response.json();
      const missingNodes = ['MiniMaxH3ImageToVideo', 'MiniMaxH3SigmaShift', 'VAEDecodeAudio', 'CreateVideo', 'SaveVideo'].filter(node => !info[node]);
      const missingFiles = [];
      for (const [node, [field, ...files]] of Object.entries(requiredFiles)) {
        const options = info[node]?.input?.required?.[field]?.[0];
        for (const file of files) if (!Array.isArray(options) || !options.includes(file)) missingFiles.push(file);
      }
      if (missingNodes.length || missingFiles.length) { model.status = 'missing-models'; model.message = 'H3 节点或完整模型权重未就绪'; model.missing = [...missingNodes, ...missingFiles]; }
      else if (!providerReady) { model.status = 'error'; model.message = 'GB10 模型就绪，但本机工作台的 gb10H3 提供商未连接'; }
      else if (baseUrl !== 'http://127.0.0.1:19188') { model.status = 'error'; model.message = '此服务器未绑定到当前 GB10 提供商；当前工作台使用主 GB10 隧道 19188'; }
      else { model.status = 'ready'; model.available = true; model.message = '本机工作台与 GB10 已接通；视频与音频模型就绪'; }
    } catch (error) { model.status = 'error'; model.message = '无法探测 GB10：' + error.message; }
    return model;
  }));
  if (!models.length) models.push({ id: MODEL, label: 'MiniMax H3 · GB10', provider: 'gb10H3', type: 'video', serverId: null, serverName: 'GB10', status: 'offline', available: false, message: '请先在服务器页连接 GB10', capabilities: copy(capabilities) });
  store.models = models; store.modelsAt = Date.now(); store.modelsKey = key; return models;
}
async function changeJob(store, workId, jobId, fields) {
  return serial(store, async () => {
    const work = workById(store, workId), job = work.jobs.find(item => item.id === jobId);
    Object.assign(job, fields); work.updatedAt = now();
    const shot = work.shots.find(item => item.id === job.shotId); if (shot) { shot.status = job.status; shot.updatedAt = now(); }
    await persist(store); return copy(job);
  });
}
async function runJob(store, entry) {
  const { workId, jobId, baseUrl } = entry;
  let job;
  const fetcher = store.context.fetch || fetch;
  const startedAt=now(),timerStart=performance.now();
  try {
    job=await serial(store,async()=>{
      const work=workById(store,workId),current=work.jobs.find(item=>item.id===jobId);if(!current||current.status!=='queued')return null;
      Object.assign(current,{status:'running',startedAt,telemetry:{version:1,source:'measured',queueMs:elapsed(current.createdAt,startedAt)},progress:10,message:'正在通过本机工作台提交 GB10 视频生成'});
      const shot=work.shots.find(item=>item.id===current.shotId);if(shot){shot.status='running';shot.updatedAt=startedAt;}work.updatedAt=startedAt;await persist(store);return copy(current);
    });
    if(!job)return;
    const state = await store.context.getState();
    if (!(state?.servers || []).some(server => server.id === job.serverId && server.online && tunnel(server.serviceLinks?.comfyui) === baseUrl)) throw new Error('GB10 连接已变化，请重新检查模型连接');
    const directory = workspace(store, workId);
    await mkdir(directory, { recursive: true });
    if(job.executionMode==='compiled'&&job.request.firstFrame){const media=job.executionSnapshot?.bindingSnapshot?.media?.find(item=>item.id===job.executionSnapshot.bindingSnapshot.firstFrameMediaId);if(!media||executionHash(await readFile(await studioMediaPath(directory,media)))!==media.sha256)throw new Error('排队期间首帧文件已改变，未提交 GB10；请核对原执行稿');}
    const signal = AbortSignal.timeout(65 * 60_000);
    const response = await fetcher(PROVIDER + '/api/ai/media/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PROVIDER, 'x-toonflow-workspace': '1' },
      // Local execution metadata belongs in the saved job, not Toonflow's strict media schema.
      body: JSON.stringify({
        directory, mediaType: 'video', providerId: 'gb10H3', modelId: MODEL,
        mode: job.request.firstFrame ? 'startFrameOptional' : 'text',
        prompt: job.request.prompt, duration: job.request.duration,
        ratio: job.request.ratio, resolution: job.request.resolution,
        ...(job.request.firstFrame ? { firstFrame: job.request.firstFrame } : {}),
        outputDirectory: 'assets/generated',
      }), signal, redirect: 'error',
    });
    if (!response.ok) throw new Error('本机工作台调用失败：HTTP ' + response.status);
    await changeJob(store, workId, jobId, { progress: 35, message: 'GB10 生成中，工作台完成后会自动保存到本机作品' });
    // The production API sends whitespace keepalives before its final JSON object.
    let raw = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      raw += decoder.decode(chunk, { stream: true });
      if (raw.length > 1024 * 1024) throw new Error('本机工作台返回的结果过大');
    }
    raw += decoder.decode();
    let result; try { result = JSON.parse(raw); } catch { throw new Error('本机工作台返回了无效结果'); }
    if (result.code !== 200) throw new Error(typeof result.message === 'string' ? result.message.slice(0, 2000) : '视频生成失败');
    const outputReadyAt=now(),productionMs=performance.now()-timerStart;
    const media = Array.isArray(result.data) ? result.data.find(asset => asset.mediaType === 'video' && asset.mimeType === 'video/mp4') : null;
    if (!media?.path) throw new Error('本机工作台没有保存生成的视频');
    await changeJob(store, workId, jobId, { outputReadyAt, progress: 90, message: '正在核对本机成片、测量实际时长与保存生产参数' });
    const target = await mediaPath(store, workId, media.path), info = await stat(target);
    if (!info.isFile() || info.size < 16 || info.size > 100 * 1024 * 1024) throw new Error('工作台视频文件为空、无效或超过 100 MB');
    const handle = await open(target, 'r');
    try { const prefix = Buffer.alloc(12); await handle.read(prefix, 0, 12, 0); if (prefix.subarray(4, 8).toString('ascii') !== 'ftyp') throw new Error('工作台保存的内容不是 MP4 文件'); }
    finally { await handle.close(); }
    const assetId = randomUUID(), filename = media.path.split('/').at(-1), size = info.size;
    const telemetry=await measureGeneration({job:{...job,startedAt},file:target,bytes:size,baseUrl,dataDir:store.context.dataDir,context:store.context,productionMs,outputReadyAt});
    await serial(store, async () => {
      const current = workById(store, workId), currentJob = current.jobs.find(item => item.id === jobId), shot = current.shots.find(item => item.id === job.shotId);
      const asset = { id: assetId, shotId: job.shotId, jobId, type: 'video', mimeType: 'video/mp4', filename, relativePath: media.path, bytes: size, url: `/api/works/${workId}/assets/${assetId}`, createdAt: now() };
      current.assets.push(asset); shot.assetIds.push(assetId); shot.selectedAssetId = assetId; shot.status = 'succeeded'; shot.updatedAt = now(); current.updatedAt = now();
      const finishedAt=now();telemetry.totalMs=elapsed(currentJob.createdAt,finishedAt);
      Object.assign(currentJob, { status: 'succeeded', progress: 100, assetId, finishedAt,telemetry, message: '视频已保存到本机作品素材库，生产指标已记录' });
      try{await writeGenerationAudit(workspace(store,workId),copy(currentJob));}catch(error){telemetry.warnings.push('日志副本写入失败，参数保留在主索引：'+error.message);}
      await persist(store);
    });
  } catch (error) {if(!job)throw error;const finishedAt=now();await changeJob(store, workId, jobId, { status: 'failed', finishedAt,telemetry:{version:1,source:'measured',queueMs:elapsed(job.createdAt,startedAt),productionMs:performance.now()-timerStart,totalMs:elapsed(job.createdAt,finishedAt),output:null,rates:null}, progress: 0, error: error.message.slice(0, 2000), message: error.message.slice(0, 2000) }); }
  const endedJob=workById(store,workId).jobs.find(item=>item.id===jobId);
  if(endedJob.status==='failed')try{await writeGenerationAudit(workspace(store,workId),copy(endedJob));}catch(error){console.error('生产日志副本写入失败，主索引已保留：',error.message);}
}
function startQueue(store) {
  if (store.running) return; store.running = true;
  setImmediate(async () => {
    try { while (store.queue.length) {const entry=store.queue.shift();await withGpuLease(()=>runJob(store,entry));} }
    catch (error) { console.error('作品任务状态保存失败：', error.message); }
    finally { store.running = false; if (store.queue.length) startQueue(store); }
  });
}
async function serveAsset(req, res, store, workId, assetId) {
  id(assetId); const work = workById(store, workId), asset = work.assets.find(item => item.id === assetId);
  if (!asset) fail('该作品中找不到此媒体', 404);
  if (asset.mimeType !== 'video/mp4') fail('媒体索引无效', 500);
  let file, size; try { file = await mediaPath(store, workId, asset.relativePath); size = (await stat(file)).size; } catch (error) { if (error.code === 'ENOENT') fail('本机媒体文件不存在', 404); throw error; }
  if (size < 16) fail('本机媒体文件已损坏', 409);
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || (!range[1] && !range[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    if (!range[1]) { const length = Number(range[2]); start = Math.max(0, size - length); }
    else { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), size - 1); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!range[1] && Number(range[2]) === 0)) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    status = 206;
  }
  const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  await pipeline(createReadStream(file, { start, end }), res).catch(error => { if (!res.destroyed) res.destroy(error); });
}

async function servePoster(req, res, store, workId, assetId) {
  id(assetId); const work = workById(store, workId), asset = work.assets.find(item => item.id === assetId);
  if (!asset) fail('该作品中找不到此媒体', 404);
  if (asset.type !== 'video' || asset.mimeType !== 'video/mp4') fail('该媒体不支持视频首帧', 400);
  let output;
  try {
    const file = await mediaPath(store, workId, asset.relativePath);
    output = await videoPoster({file, workspaceDirectory: workspace(store, workId), assetId, dataDir: store.context.dataDir, extract: store.context.extractPoster});
  } catch (error) { if (error.code === 'ENOENT') fail('本机媒体文件不存在', 404); throw error; }
  res.writeHead(200, {'Content-Type': 'image/jpeg', 'Content-Length': output.length, 'Cache-Control': 'private, max-age=0, must-revalidate', 'X-Content-Type-Options': 'nosniff'});
  res.end(req.method === 'HEAD' ? undefined : output);
}

/** context.fetch is an optional test transport. Production uses native fetch only. */
export async function handleWorks(req, res, url, context) {
  if (url.pathname !== '/api/works' && !url.pathname.startsWith('/api/works/')) return false;
  try {
    const store = await getStore(context), path = url.pathname;
    if (path === '/api/works' && req.method === 'GET') {
      const models = await discover(store); await store.writes;
      json(res, 200, { works: store.works.map(presentWork).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), models: copy(models), jobs: copy(store.works.flatMap(work => work.jobs)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), textModel: { configured: false, message: '未配置文本大模型；提示词由用户或当前助手编写，GB10 H3 负责生成视频' } }); return true;
    }
    if (path === '/api/works' && req.method === 'POST') {
      const body = await readBody(req), title = text(body.title, '作品名称', 120, true), synopsis = text(body.synopsis ?? '', '作品简介', 10000), style = text(body.style ?? '', '视觉风格', 2000);
      const type = 'type' in body ? workType(body.type) : 'short-film';
      const work = await serial(store, async () => {
        const timestamp = now(), work = { id: randomUUID(), title, type, synopsis, style, createdAt: timestamp, updatedAt: timestamp, episodes: [{ id: randomUUID(), title: '第 1 集', synopsis: '', number: 1, createdAt: timestamp }], shots: [], assets: [], jobs: [] };
        work.workspacePath = workspace(store, work.id); await mkdir(work.workspacePath, { recursive: true }); store.works.push(work); await persist(store); return copy(work);
      }); json(res, 201, { work }); return true;
    }
    const match = /^\/api\/works\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) fail('未找到作品接口', 404);
    const workId = id(match[1]), action = match[2] || '';
    if (action === 'studio' || action.startsWith('studio/')) return await handleStudio(req,res,url,store,workId,{serial,persist,workById,workspace,readBody,presentWork,json,shotFields});
    if(action==='generation-log'&&req.method==='GET'){
      await store.writes;const work=workById(store,workId);
      res.setHeader('Content-Disposition',`attachment; filename="generation-log-${workId}.json"`);
      json(res,200,{version:1,work:{id:work.id,title:work.title},exportedAt:now(),definitions:measurementDefinitions,jobs:copy(work.jobs)});return true;
    }
    const posterMatch = /^assets\/([^/]+)\/poster$/.exec(action);
    if (posterMatch && ['GET', 'HEAD'].includes(req.method)) { await store.writes; await servePoster(req, res, store, workId, posterMatch[1]); return true; }
    const assetMatch = /^assets\/([^/]+)$/.exec(action);
    if (assetMatch && ['GET', 'HEAD'].includes(req.method)) { await store.writes; await serveAsset(req, res, store, workId, assetMatch[1]); return true; }
    if (!action && req.method === 'GET') { await store.writes; json(res, 200, { work: presentWork(workById(store, workId)) }); return true; }
    if (req.method !== 'POST') fail('未找到作品接口', 404);
    const body = await readBody(req);
    const cancelMatch=/^jobs\/([^/]+)\/cancel$/.exec(action);
    if(cancelMatch){
      const jobId=id(cancelMatch[1]);if(Object.keys(body).length)fail('取消只接受任务编号和空 JSON 对象');
      const result=await serial(store,async()=>{
        const work=workById(store,workId),job=work.jobs.find(item=>item.id===jobId);if(!job)fail('任务不属于当前作品',404);
        if(job.status==='cancelled')return {cancelled:true,alreadyCancelled:true,job:copy(job)};
        if(job.status==='running')fail('任务已经运行；当前提供商无可归属单任务取消回执，不能安全取消运行任务',409);
        if(job.status!=='queued')fail('仅可取消本机尚未运行的 queued 视频任务',409);
        const timestamp=now();Object.assign(job,{status:'cancelled',cancelledAt:timestamp,finishedAt:timestamp,progress:0,message:'已取消本机排队任务，未提交 GB10'});
        const shot=work.shots.find(item=>item.id===job.shotId);if(shot){shot.status='cancelled';shot.updatedAt=timestamp;}work.updatedAt=timestamp;
        await persist(store);store.queue=store.queue.filter(item=>item.workId!==workId||item.jobId!==jobId);
        try{await writeGenerationAudit(workspace(store,workId),copy(job));}catch(error){console.error('排队取消日志副本写入失败，主索引保留：',error.message);}
        return {cancelled:true,alreadyCancelled:false,job:copy(job)};
      });json(res,200,result);return true;
    }
    const recoveryMatch=/^jobs\/([^/]+)\/recover$/.exec(action);
    if(recoveryMatch){
      const jobId=id(recoveryMatch[1]);if(Object.keys(body).length)fail('恢复仅接受原任务编号，不接受新参数、路径或远端地址');
      const result=await serial(store,async()=>{
        const work=workById(store,workId),job=work.jobs.find(item=>item.id===jobId),shot=work.shots.find(item=>item.id===job?.shotId);
        if(!job||!shot)fail('原作品任务或分镜不存在',404);
        if(job.recovery?.version===1&&job.status==='succeeded')return await verifyRecoveredVideo({dataDir:store.context.dataDir,work,job});
        if(job.status!=='interrupted'||work.jobs.some(item=>item.shotId===job.shotId&&['queued','running'].includes(item.status))||store.queue.some(item=>item.jobId===job.id))fail('仅可找回当前没有生成任务的已中断视频',409);
        const state=await store.context.getState(),server=state?.servers?.find(item=>item.id===job.serverId);
        let prepared,committed=false;
        try{
          const claimedPromptIds=store.works.flatMap(item=>item.jobs||[]).filter(item=>item.id!==job.id).flatMap(item=>[item.telemetry?.promptId,item.recovery?.promptId].filter(Boolean));
          prepared=await prepareVideoRecovery({dataDir:store.context.dataDir,work,job,server,fetcher:store.context.fetch||fetch,probe:store.context.probeMedia,claimedPromptIds,otherJobs:store.works.flatMap(item=>item.jobs||[]).filter(item=>item.id!==job.id)});
          const {asset,telemetry,recovery}=prepared;recovery.selectionApplied=!shot.selectedAssetId&&shot.status==='interrupted';
          work.assets.push(asset);shot.assetIds??=[];shot.assetIds.push(asset.id);if(recovery.selectionApplied)shot.selectedAssetId=asset.id;if(shot.status==='interrupted')shot.status='succeeded';shot.updatedAt=recovery.recoveredAt;
          Object.assign(job,{status:'succeeded',progress:100,assetId:asset.id,recoveredAt:recovery.recoveredAt,recovery,telemetry,message:'已核对原工作流和首帧，找回原视频；未重新生成，本机缺失耗时保持未记录'});work.updatedAt=recovery.recoveredAt;
          await persist(store);committed=true;
          try{await writeGenerationAudit(workspace(store,workId),copy(job));}catch(error){console.error('恢复视频日志副本写入失败，原请求及恢复证据保留在主索引：',error.message);}
          return {recovered:true,alreadyRecovered:false,job:copy(job),asset:copy(asset)};
        }catch(error){if(!committed)await prepared?.cleanup();if(error.code==='ENOENT')fail('原首帧、工作区或恢复证据文件缺失',409);throw error;}
      });
      json(res,200,result);return true;
    }
    if(action==='refresh-metrics'){
      await store.writes;const work=workById(store,workId);
      if(body.jobId)id(body.jobId);
      const selectedJobs=work.jobs.filter(job=>job.status==='succeeded'&&(!body.jobId||job.id===body.jobId)).slice(-10);
      let updated=0;
      for(const job of selectedJobs){
        const asset=work.assets.find(a=>a.id===job.assetId);if(!asset)continue;
        const file=await mediaPath(store,workId,asset.relativePath);
        const state=await store.context.getState(),server=(state?.servers||[]).find(s=>s.id===job.serverId);
        const telemetry=await measureGeneration({job:copy(job),file,bytes:asset.bytes,baseUrl:server?.online?tunnel(server.serviceLinks?.comfyui):null,dataDir:store.context.dataDir,context:store.context,productionMs:job.telemetry?.source==='measured'?job.telemetry.productionMs:undefined,outputReadyAt:job.outputReadyAt});
        if(job.recovery?.version===1){telemetry.source='recovered-artifact';for(const key of ['queueMs','productionMs','totalMs'])telemetry[key]=job.telemetry?.[key]??null;telemetry.rates=calculateRates(telemetry.output,telemetry.productionMs,telemetry.serverExecutionMs);}else telemetry.totalMs=elapsed(job.createdAt,job.finishedAt);
        await serial(store,async()=>{workById(store,workId).jobs.find(j=>j.id===job.id).telemetry=telemetry;await persist(store);});
        await writeGenerationAudit(workspace(store,workId),copy(workById(store,workId).jobs.find(j=>j.id===job.id)));updated++;
      }
      json(res,200,{updated,work:copy(workById(store,workId))});return true;
    }
    if (action === 'generate') {
      const shotId = id(body.shotId), modelId = body.modelId ?? MODEL;
      if (modelId !== MODEL) fail('只允许使用已接入的 GB10 H3 模型');
      const models = await discover(store, true), selected = models.find(model => model.id === modelId && model.available);
      if (!selected) fail('GB10 H3 尚未连接就绪，请检查服务器和模型状态', 409);
      const state = await store.context.getState(), server = (state?.servers || []).find(item => item.id === selected.serverId), baseUrl = tunnel(server?.serviceLinks?.comfyui);
      if (!baseUrl) fail('GB10 SSH 隧道尚未就绪', 409);
      const result = await serial(store, async () => {
        const work = workById(store, workId), shot = work.shots.find(item => item.id === shotId);
        if (!shot) fail('分镜不存在', 404);
        validateCanvasCombination(shot.ratio,shot.resolution);
        if (work.jobs.some(job => job.shotId === shotId && ['queued', 'running'].includes(job.status))) fail('这个分镜已有进行中的生成任务', 409);
        const executionMode=body.executionMode??(shot.executionPrompt?'compiled':'legacy');if(!['compiled','legacy'].includes(executionMode))fail('executionMode 仅支持 compiled 或 legacy');
        if(executionMode==='legacy'&&!shot.prompt.trim())fail('请先为分镜填写旧版提示词，或明确编译并锁定最终 H3 执行稿');
        const executionSnapshot=executionMode==='compiled'?await compiledExecutionForJob(work,shot,{resolveMedia:media=>studioMediaPath(workspace(store,workId),media)}):null;
        let firstFrame;
        if(shot.firstFrameMediaId){const media=hydrateStudio(work).media.find(item=>item.id===shot.firstFrameMediaId&&item.type==='image');if(!media)fail('当前分镜首帧素材不存在');await studioMediaPath(workspace(store,workId),media);firstFrame={path:media.relativePath,mimeType:media.mimeType};}
        const job = { id: randomUUID(), workId, shotId,shotTitle:shot.title, modelId, serverId: selected.serverId,serverSnapshot:{name:server.name,host:server.host,hostname:server.metric?.hostname,gpu:server.metric?.gpu?.name,driver:server.metric?.gpu?.driver,architecture:server.metric?.architecture,os:server.metric?.os}, status: 'queued', progress: 0, message: '已加入本机作品队列，等待 GB10 生成', createdAt: now(),executionMode,...(executionSnapshot?{executionSnapshot}:{}), request: { prompt: executionSnapshot?.prompt??shot.prompt,executionMode, duration: shot.duration, ratio: shot.ratio, resolution: shot.resolution,...(firstFrame?{firstFrame}:{} ) },bindingSnapshot:executionSnapshot?copy(executionSnapshot.bindingSnapshot):shot.promptSnapshot?copy(shot.promptSnapshot):{characterIds:copy(shot.characterIds||[]),sceneId:shot.sceneId||null,voiceIds:copy(shot.voiceIds||[]),firstFrameMediaId:shot.firstFrameMediaId||null} };
        job.telemetry={version:1,source:'measured',queueMs:null,productionMs:null,totalMs:null,output:null,rates:null,parameters:null};
        work.jobs.push(job); shot.status = 'queued'; shot.updatedAt = now(); work.updatedAt = now(); await persist(store);
        store.queue.push({ workId, jobId: job.id, baseUrl }); return { job: copy(job), work: copy(work) };
      }); json(res, 202, result); startQueue(store); return true;
    }
    const result = await serial(store, async () => {
      const work = workById(store, workId);
      if (action === 'update') {
        const changes = {};
        if ('title' in body) changes.title = text(body.title, '作品名称', 120, true);
        if ('type' in body) changes.type = workType(body.type);
        if ('synopsis' in body) changes.synopsis = text(body.synopsis, '作品简介', 10000);
        if ('style' in body) changes.style = text(body.style, '视觉风格', 2000);
        Object.assign(work, changes);
      } else if (action === 'episodes') {
        const previousEpisodeId=work.episodes.at(-1)?.id,candidate=copy(work),selected={id:randomUUID(),title:text(body.title??`第 ${work.episodes.length+1} 集`,'分集名称',120,true),synopsis:text(body.synopsis??'','分集简介',10000),number:work.episodes.length+1,createdAt:now()};
        candidate.episodes.push(selected);hydrateStudio(candidate);inheritOpEdFromPrevious(candidate,selected.id,previousEpisodeId,{validateTimeline});work.episodes=candidate.episodes;work.studio=candidate.studio;
      } else if (action === 'shots') {
        const episodeId = id(body.episodeId); if (!work.episodes.some(episode => episode.id === episodeId)) fail('分集不属于这个作品');
        work.shots.push({ id: randomUUID(), episodeId, ...shotFields(body), number: work.shots.filter(shot => shot.episodeId === episodeId).length + 1, status: 'draft', assetIds: [], createdAt: now(), updatedAt: now() });
      } else {
        const episodeEdit = /^episodes\/([^/]+)\/update$/.exec(action);
        if (episodeEdit) {
          const episodeId = id(episodeEdit[1]), episode = work.episodes.find(item => item.id === episodeId); if (!episode) fail('分集不存在', 404);
          const changes = {};
          if ('title' in body) changes.title = text(body.title, '分集名称', 120, true);
          if ('synopsis' in body) changes.synopsis = text(body.synopsis, '分集简介', 10000);
          Object.assign(episode, changes, { updatedAt: now() });
        } else {
          const edit = /^shots\/([^/]+)\/(update|select-asset|duplicate)$/.exec(action); if (!edit) fail('未找到作品接口', 404);
          const shotId = id(edit[1]), shot = work.shots.find(item => item.id === shotId); if (!shot) fail('分镜不存在', 404);
          if (edit[2] === 'select-asset') {
            const assetId = id(body.assetId), asset = work.assets.find(item => item.id === assetId);
            if (!asset || asset.shotId !== shotId || !shot.assetIds.includes(assetId) || asset.type !== 'video') fail('只能选用当前分镜已经生成的视频版本');
            shot.selectedAssetId = assetId; shot.updatedAt = now();
          } else if (edit[2] === 'duplicate') {
            const timestamp = now();
            work.shots.push({id: randomUUID(), episodeId: shot.episodeId, ...shotFields({...shot, title: shot.title.slice(0, 117) + ' 副本'}), characterIds:copy(shot.characterIds||[]),sceneId:shot.sceneId||null,voiceIds:copy(shot.voiceIds||[]),firstFrameMediaId:shot.firstFrameMediaId||null,skillIds:copy(shot.skillIds||[]),skillSnapshot:copy(shot.skillSnapshot||[]),...(shot.visualInstructions?{visualInstructions:shot.visualInstructions,soundInstructions:shot.soundInstructions||'',musicInstructions:shot.musicInstructions||''}:{}), number: work.shots.filter(item => item.episodeId === shot.episodeId).length + 1, status: 'draft',approvalStatus:'draft', assetIds: [], createdAt: timestamp, updatedAt: timestamp});
          } else {
            if (work.jobs.some(job => job.shotId === shotId && ['queued', 'running'].includes(job.status))) fail('分镜生成中，请完成后再编辑', 409);
            const fields = shotFields(body, true, shot), changed = Object.entries(fields).some(([key, value]) => shot[key] !== value);
            Object.assign(shot, fields, { updatedAt: now(), ...(changed ? { status: 'draft' } : {}) });
          }
        }
      }
      work.updatedAt = now(); await persist(store); return presentWork(work);
    });
    json(res, action === 'episodes' || action === 'shots' ? 201 : 200, { work: result }); return true;
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.message }); else res.destroy(error);
  }
  return true;
}
