import { createHash } from 'node:crypto';

const BASE = 'http://127.0.0.1:19188';
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const UNET = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors';
const CLIP = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors';
const VIDEO_VAE = 'minimax_h3_video_vae_fp16.safetensors';
const AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sizeError = () => Object.assign(new Error('GB10 执行记录或视频超过核对大小限制'), { code: 'TELEMETRY_SIZE_LIMIT' });

export function expectedVideo(request) {
  if (!object(request) || typeof request.prompt !== 'string' || !request.prompt.trim() || !Number.isSafeInteger(request.duration) || request.duration < 4 || request.duration > 15 || !['352P', '480P'].includes(request.resolution) || !['16:9', '9:16', '1:1', '47:20'].includes(request.ratio) || request.ratio === '47:20' && request.resolution !== '352P') return null;
  let width = request.resolution === '480P' ? 864 : 608;
  let height = request.resolution === '480P' ? 480 : 352;
  if (request.ratio === '9:16') [width, height] = [height, width];
  if (request.ratio === '1:1') width = height = request.resolution === '480P' ? 640 : 512;
  if (request.ratio === '47:20') { width = 832; height = 352; }
  // These are the actual node inputs, not measured output frames. Preserve the
  // original 4s/5s graphs exactly; the H3 node itself snaps 96 up to 107 frames.
  // New 6–15s requests use the installed ComfyUI v0.30.0 17k+5 frame grid.
  const requestedFrames = request.duration === 4 ? 96 : request.duration === 5 ? 124 : 17 * Math.ceil((24 * request.duration - 5) / 17) + 5;
  return { width, height, requestedFrames };
}

// Follow the saved output's actual graph rather than selecting unrelated nodes by class.
export function graphParameters(workflow, outputId, request, expected) {
  if (!object(workflow)) return null;
  const node = (id, type) => { const value = workflow[String(id)]; return value?.class_type === type && object(value.inputs) ? value.inputs : null; };
  const linked = (value, type, index = 0) => Array.isArray(value) && value.length === 2 && value[1] === index ? node(value[0], type) : null;
  const sameLink = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 2 && b.length === 2 && String(a[0]) === String(b[0]) && a[1] === b[1];
  const save = node(outputId, 'SaveVideo');
  const video = linked(save?.video, 'CreateVideo');
  const decode = linked(video?.images, 'VAEDecode');
  const sampler = linked(decode?.samples, 'KSampler');
  const positive = linked(sampler?.positive, 'MiniMaxH3ImageToVideo');
  const negative = linked(sampler?.negative, 'CLIPTextEncode');
  const shift = linked(sampler?.model, 'MiniMaxH3SigmaShift');
  const unet = linked(shift?.model, 'UNETLoader');
  const clip = linked(positive?.clip, 'CLIPLoader');
  const videoVae = linked(decode?.vae, 'VAELoader');
  const audio = linked(video?.audio, 'VAEDecodeAudio');
  const audioVae = linked(audio?.vae, 'VAELoader');
  if (!save || !video || !decode || !sampler || !positive || !negative || !shift || !unet || !clip || !videoVae || !audio || !audioVae) return null;
  if (!sameLink(sampler.positive, [sampler.latent_image?.[0], 0]) || sampler.latent_image?.[1] !== 1 || !sameLink(audio.samples, decode.samples) || !sameLink(positive.vae, decode.vae) || !sameLink(positive.clip, negative.clip)) return null;
  if (unet.unet_name !== UNET || clip.clip_name !== CLIP || clip.type !== 'minimax' || videoVae.vae_name !== VIDEO_VAE || audioVae.vae_name !== AUDIO_VAE) return null;
  if (positive.prompt !== request.prompt.trim() || positive.width !== expected.width || positive.height !== expected.height || positive.length !== expected.requestedFrames || video.fps !== 24) return null;
  if (!integer(sampler.seed) || !Number.isSafeInteger(sampler.steps) || sampler.steps <= 0 || !finite(sampler.cfg) || !finite(sampler.denoise) || !finite(shift.shift_video) || !finite(shift.shift_audio) || typeof sampler.sampler_name !== 'string' || typeof sampler.scheduler !== 'string' || typeof negative.text !== 'string') return null;
  return {
    modelFile: unet.unet_name, weightDtype: unet.weight_dtype,
    textEncoder: clip.clip_name, videoVae: videoVae.vae_name, audioVae: audioVae.vae_name,
    width: positive.width, height: positive.height, requestedFrames: positive.length, fps: video.fps,
    seed: sampler.seed, steps: sampler.steps, cfg: sampler.cfg, sampler: sampler.sampler_name,
    scheduler: sampler.scheduler, denoise: sampler.denoise,
    shiftVideo: shift.shift_video, shiftAudio: shift.shift_audio, negativePrompt: negative.text,
    mode: positive.first_frame ? 'image-to-video' : 'text-to-video', audio: true,
  };
}

export function executionTimes(history, promptId) {
  const messages = history.status?.messages;
  if (!Array.isArray(messages)) return null;
  const eventTime = name => messages.filter(item => Array.isArray(item) && item[0] === name && object(item[1]) && item[1].prompt_id === promptId && integer(item[1].timestamp)).map(item => item[1].timestamp);
  const starts = eventTime('execution_start'), finishes = eventTime('execution_success');
  if (starts.length !== 1 || finishes.length !== 1 || finishes[0] < starts[0] || starts[0] < 1_000_000_000_000 || finishes[0] > 8_640_000_000_000_000) return null;
  const cached = messages.filter(item => Array.isArray(item) && item[0] === 'execution_cached' && Array.isArray(item[1]?.nodes)).flatMap(item => item[1].nodes).filter(item => typeof item === 'string');
  return { start: starts[0], finish: finishes[0], cachedNodes: cached };
}

/** Read-only, bounded artifact correlation. Missing or ambiguous evidence stays unavailable. */
export async function collectComfyTelemetry({ fetcher = fetch, baseUrl, sha256, bytes, request, startedAt, finishedAt, legacy = false } = {}) {
  if (baseUrl !== BASE) return { unavailable: '仅允许通过主 GB10 的本机 19188 隧道核对执行记录' };
  if (!/^[a-f0-9]{64}$/i.test(sha256 || '') || !Number.isSafeInteger(bytes) || bytes < 16 || bytes > MAX_VIDEO_BYTES) return { unavailable: '本机 MP4 的 SHA256 或字节数无效' };
  const expected = expectedVideo(request);
  if (!expected) return { unavailable: '缺少可核对的提示词、时长、分辨率或画幅参数' };
  const localStart = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  const localFinish = typeof finishedAt === 'string' ? Date.parse(finishedAt) : NaN;
  // Time only limits bounded candidates. SHA256 and graph checks still establish ownership.
  const window = Number.isFinite(localStart) && Number.isFinite(localFinish) && localStart >= 1_000_000_000_000 && localFinish >= localStart
    ? { start: localStart - 30_000, finish: localFinish + 30_000 } : null;
  const deadline = performance.now() + 15_000;
  async function readUrl(url, limit, consume) {
    const remaining = Math.min(5000, deadline - performance.now());
    if (remaining <= 0) throw new Error('核对执行记录超过 15 秒预算');
    const controller = new AbortController();
    let timer, reader;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reader?.cancel().catch(() => {}); reject(new Error('GB10 执行记录读取超时')); }, remaining); });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetcher(url, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) throw new Error('GB10 执行记录读取失败：HTTP ' + response.status);
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await response.body?.cancel(); throw sizeError(); }
        reader = response.body?.getReader();
        if (!reader) throw new Error('GB10 返回空执行记录');
        let count = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            count += part.value.byteLength;
            if (count > limit) throw sizeError();
            consume(part.value);
          }
          return count;
        } finally { await reader.cancel().catch(() => {}); }
      })()]);
    } finally { clearTimeout(timer); }
  }
  try {
    const chunks = [];
    await readUrl(BASE + '/history?max_items=100', MAX_HISTORY_BYTES, chunk => chunks.push(chunk));
    const history = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(history)) throw new Error('GB10 历史记录格式无效');
    const candidates = [];
    let outsideWindow = 0;
    for (const [promptId, record] of Object.entries(history)) {
      if (!/^[a-f0-9-]{36}$/i.test(promptId) || !object(record) || !Array.isArray(record.prompt) || record.prompt[1] !== promptId || record.status?.status_str !== 'success' || record.status?.completed !== true || !object(record.outputs)) continue;
      const times = executionTimes(record, promptId);
      for (const [outputId, output] of Object.entries(record.outputs)) {
        if (!object(output)) continue;
        const parameters = graphParameters(record.prompt[2], outputId, request, expected);
        if (!parameters) continue;
        for (const files of Object.values(output)) {
          if (!Array.isArray(files)) continue;
          for (const file of files) {
            if (!object(file) || file.type !== 'output' || file.subfolder !== 'rack' || typeof file.filename !== 'string' || !/^toonflow_h3_[a-zA-Z0-9_-]+\.mp4$/.test(file.filename)) continue;
            // Missing/invalid server events cannot prove that a candidate lies outside the window.
            if (window && times && (times.start < window.start || times.finish > window.finish)) { outsideWindow++; continue; }
            const key = `${promptId}/${file.filename}`;
            if (candidates.some(item => item.key === key)) continue;
            candidates.push({ key, promptId, record, file, parameters, times });
          }
        }
      }
    }
    if (candidates.length > 8) return { unavailable: '匹配参数的历史候选超过 8 个，未凭时间先后认领执行记录' };
    if (!candidates.length && outsideWindow) return { unavailable: '本机生成时间前后 30 秒窗口内没有可核对的 GB10 执行记录；两机时钟可能不同步，未改用最近任务认领' };
    const matches = [];
    for (const candidate of candidates) {
      const digest = createHash('sha256');
      const params = new URLSearchParams({ filename: candidate.file.filename, subfolder: 'rack', type: 'output' });
      let count;
      try { count = await readUrl(BASE + '/view?' + params.toString(), bytes, chunk => digest.update(chunk)); }
      catch (error) { if (error.code === 'TELEMETRY_SIZE_LIMIT') continue; throw error; }
      if (count === bytes && digest.digest('hex') === sha256.toLowerCase()) matches.push(candidate);
    }
    if (matches.length !== 1) return { unavailable: matches.length ? '多个远端任务输出与本机视频完全一致，无法唯一关联执行记录' : '最近 100 条历史中没有与本机视频 SHA256 和参数唯一匹配的 GB10 输出' };
    const match = matches[0], times = match.times;
    const queuedAt = match.record.prompt[3]?.create_time;
    return {
      promptId: match.promptId,
      ...(times ? {
        serverExecutionMs: times.finish - times.start,
        serverStartedAt: new Date(times.start).toISOString(), serverFinishedAt: new Date(times.finish).toISOString(),
      } : { unavailable: '视频 SHA256 与工作流已唯一匹配，实际参数已证实；缺少可信执行开始与成功事件，服务器耗时不可用' }),
      parameters: match.parameters,
      provenance: {
        source: 'comfyui-history-sha256', matchedBy: 'exact-video-sha256-and-workflow-parameters',
        sha256: sha256.toLowerCase(), bytes, remoteArtifact: { ...match.file },
        timestampSource: times ? 'ComfyUI execution_start/execution_success milliseconds' : null,
        executionScope: 'server-workflow-wall-clock', cachedNodes: times?.cachedNodes || [],
        serverQueueMs: times && integer(queuedAt) && queuedAt <= times.start ? times.start - queuedAt : null,
        timeWindowCheck: window ? times ? 'within-30-seconds' : 'server-events-unavailable' : 'not-applied',
        observedAt: new Date().toISOString(), legacy: Boolean(legacy),
        localStartedAt: typeof startedAt === 'string' ? startedAt : null,
        localFinishedAt: typeof finishedAt === 'string' ? finishedAt : null,
      },
    };
  } catch (error) { return { unavailable: String(error?.message || '无法核对 GB10 执行记录').slice(0, 500) }; }
}
