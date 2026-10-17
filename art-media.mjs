import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile, rename, stat, realpath} from 'node:fs/promises';
import {join, relative, isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_POSTER_BYTES = 2 * 1024 * 1024;
const pending = new Map();
function error(message, status = 500) { return Object.assign(new Error(message), {status}); }
function within(directory, file) {
  const path = relative(directory, file);
  if (!path || path.startsWith('..') || isAbsolute(path)) throw error('缩略图缓存路径越界', 400);
}
function signature(info) { return {size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs}; }
function matches(a, b) { return a?.size === b.size && a?.mtimeMs === b.mtimeMs && a?.ctimeMs === b.ctimeMs; }
function jpeg(value) {
  if (!Buffer.isBuffer(value) || value.length < 4 || value.length > MAX_POSTER_BYTES || value[0] !== 0xff || value[1] !== 0xd8 || value.at(-2) !== 0xff || value.at(-1) !== 0xd9) throw error('无法取得有效的视频首帧', 502);
  return value;
}

/** Extracts the actual first video frame, using only a fixed local executable. */
export async function extractPoster(file, dataDir) {
  const executable = process.platform === 'win32' ? join(dataDir, 'toonflow', 'ffmpeg', 'win32-x64', 'ffmpeg.exe') : 'ffmpeg';
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-q:v', '3', '-threads', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], {windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    const chunks = []; let bytes = 0, stderr = '', done = false;
    const finish = (failure) => {
      if (done) return; done = true; clearTimeout(timer);
      if (failure) reject(failure);
      else { try { resolve(jpeg(Buffer.concat(chunks))); } catch (failure) { reject(failure); } }
    };
    const timer = setTimeout(() => { child.kill(); finish(error('读取视频首帧超时，请稍后重试', 504)); }, 20_000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_POSTER_BYTES) { child.kill(); finish(error('视频首帧超过 2 MB 限制', 502)); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
    child.on('error', failure => finish(failure.code === 'ENOENT' ? error('本机 FFmpeg 尚未安装，无法生成真实首帧', 503) : failure));
    child.on('close', code => finish(code === 0 ? null : error('读取视频首帧失败' + (stderr ? '：' + stderr : ''), 502)));
  });
}

async function boundedCacheFile(directory, file, maxBytes) {
  const canonical = await realpath(file); within(directory, canonical);
  const info = await stat(canonical);
  if (!info.isFile() || info.size > maxBytes) throw error('缩略图缓存无效');
  return readFile(canonical);
}

/** file and workspaceDirectory must already be resolved from registered media. */
export async function videoPoster({file, workspaceDirectory, assetId, dataDir, extract = extractPoster}) {
  if (!UUID.test(assetId || '')) throw error('媒体编号无效', 400);
  const directory = await realpath(workspaceDirectory), canonical = await realpath(file); within(directory, canonical);
  const key = join(directory, assetId);
  if (pending.has(key)) return pending.get(key);
  const operation = (async () => {
    const source = await stat(canonical);
    if (!source.isFile() || source.size < 16 || source.size > 100 * 1024 * 1024) throw error('本机媒体文件已损坏', 409);
    const identity = signature(source), cachePath = join(directory, '.rack-previews');
    await mkdir(cachePath, {recursive: true});
    const cacheDirectory = await realpath(cachePath); within(directory, cacheDirectory);
    const poster = join(cacheDirectory, assetId + '.jpg'), metadata = poster + '.json';
    try {
      const stored = JSON.parse((await boundedCacheFile(cacheDirectory, metadata, 2048)).toString('utf8'));
      if (stored.source === canonical && matches(stored, identity)) return jpeg(await boundedCacheFile(cacheDirectory, poster, MAX_POSTER_BYTES));
    } catch (failure) { if (failure.code !== 'ENOENT' && failure.status === 400) throw failure; }
    const output = jpeg(await extract(canonical, dataDir));
    if (!matches(signature(await stat(canonical)), identity)) throw error('视频文件刚刚发生变化，请重新加载首帧', 409);
    const temporary = poster + '.' + randomUUID() + '.tmp', temporaryMetadata = metadata + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, output, {mode: 0o600});
    await writeFile(temporaryMetadata, JSON.stringify({source: canonical, ...identity}), {mode: 0o600});
    await rename(temporary, poster); await rename(temporaryMetadata, metadata);
    return output;
  })();
  pending.set(key, operation);
  try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
}
