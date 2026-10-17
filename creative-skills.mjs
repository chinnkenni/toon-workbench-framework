import {readFile, writeFile, mkdir, rename, unlink, lstat, realpath} from 'node:fs/promises';
import {dirname, join, resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const locks = new Map();
const maxBodyBytes = 64 * 1024;
const maxReadableBytes = 768 * 1024;
const skillId = /^[a-z0-9][a-z0-9-]{0,63}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), {status});

function inside(base, target) {
  const part = relative(base, target);
  if (!part || part === '..' || part.startsWith('..\\') || part.startsWith('../') || isAbsolute(part)) throw fail('技能文件路径越界');
}

async function safeRegisteredFile(base, file) {
  const root = resolve(base), target = resolve(root, file);
  inside(root, target);
  if ((await lstat(root)).isSymbolicLink()) throw fail('技能目录不能是符号链接');
  let cursor = root;
  for (const part of relative(root, target).split(/[\\/]/)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw fail('技能文件不能经过符号链接');
  }
  const actualRoot = await realpath(root), actualFile = await realpath(target);
  inside(actualRoot, actualFile);
  const details = await lstat(target);
  if (!details.isFile()) throw fail('技能原文不是普通文件');
  return {path: target, bytes: details.size};
}

async function loadSeed(rootDir = projectRoot) {
  const skillsRoot = join(resolve(rootDir), 'skills');
  let seed;
  try {
    const file = await safeRegisteredFile(skillsRoot, 'workbench-catalog.json');
    seed = JSON.parse(await readFile(file.path, 'utf8'));
  } catch (error) {
    throw fail('工作台技能目录尚未就绪：' + error.message, 503);
  }
  if (!Array.isArray(seed.skills) || !Array.isArray(seed.scenarios)) throw fail('工作台技能登记格式无效', 503);
  const ids = new Set(), scenarioIds = new Set(seed.scenarios.map(s => s.id));
  for (const entry of seed.skills) {
    if (!skillId.test(entry.id) || ids.has(entry.id) || !scenarioIds.has(entry.scenario) || entry.rootPath !== 'packages/' + entry.id || !Array.isArray(entry.files)) throw fail('工作台技能登记无效', 503);
    ids.add(entry.id);
    for (const file of entry.files) if (!validRelativePath(file.path) || !Number.isSafeInteger(file.bytes) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw fail('技能文件登记无效', 503);
  }
  return {seed, skillsRoot};
}

function validRelativePath(value) {
  return typeof value === 'string' && value.length <= 300 && !value.includes('\\') && !value.includes(':') && !value.includes('\0') && !value.startsWith('/') && value.split('/').every(s => s && s !== '.' && s !== '..');
}

function locked(dataDir, operation) {
  const key = resolve(dataDir);
  const before = locks.get(key) || Promise.resolve();
  const current = before.catch(() => {}).then(operation);
  const settled = current.catch(() => {});
  locks.set(key, settled);
  settled.finally(() => { if (locks.get(key) === settled) locks.delete(key); });
  return current;
}

async function saveCatalog(dataDir, catalog) {
  const directory = join(resolve(dataDir), 'creative-skills');
  await mkdir(directory, {recursive: true});
  if ((await lstat(directory)).isSymbolicLink()) throw fail('技能设置目录不能是符号链接');
  const target = join(directory, 'catalog.json');
  try { if ((await lstat(target)).isSymbolicLink()) throw fail('技能设置不能是符号链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(directory, '.catalog-' + randomUUID() + '.tmp');
  try { await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', {flag: 'wx'}); await rename(temporary, target); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function loadCatalog(dataDir, seed) {
  const file = join(resolve(dataDir), 'creative-skills', 'catalog.json');
  let catalog;
  try {
    if ((await lstat(dirname(file))).isSymbolicLink() || (await lstat(file)).isSymbolicLink()) throw fail('技能设置不能是符号链接');
    const bytes = await readFile(file);
    if (bytes.length > 32 * 1024 * 1024) throw fail('技能修订记录过大，请先归档', 503);
    catalog = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail('无法读取技能设置：' + error.message, error.status || 503);
    catalog = {schemaVersion: 1, version: 1, updatedAt: new Date().toISOString(), skills: seed.skills.map(s => ({id: s.id, name: s.name, scenario: s.scenario, enabled: s.enabled !== false, instructions: s.instructions, version: s.version || 1})), revisions: []};
    await saveCatalog(dataDir, catalog);
  }
  if (!Array.isArray(catalog.skills) || !Array.isArray(catalog.revisions) || !Number.isSafeInteger(catalog.version)) throw fail('技能设置格式无效', 503);
  const scenarioIds = new Set(seed.scenarios.map(s => s.id));
  for (const row of catalog.skills) if (!skillId.test(row.id) || typeof row.enabled !== 'boolean' || typeof row.name !== 'string' || typeof row.instructions !== 'string' || !scenarioIds.has(row.scenario) || !Number.isSafeInteger(row.version)) throw fail('技能设置条目无效', 503);
  return catalog;
}

function mergedSkills(seed, catalog) {
  return seed.skills.map(source => {
    const saved = catalog.skills.find(s => s.id === source.id);
    return {...source, ...(saved ? {name: saved.name, scenario: saved.scenario, enabled: saved.enabled, instructions: saved.instructions, version: saved.version, updatedAt: saved.updatedAt || null} : {})};
  });
}

async function installationState(skillsRoot, skills) {
  let verifiedFiles = 0, totalFiles = 0;
  const packages = [];
  for (const skill of skills) {
    const failures = [];
    for (const registered of skill.files) {
      totalFiles++;
      try {
        const file = await safeRegisteredFile(skillsRoot, skill.rootPath + '/' + registered.path);
        if (file.bytes !== registered.bytes) throw new Error('文件大小改变');
        if (digest(await readFile(file.path)) !== registered.sha256) throw new Error('SHA256 改变');
        verifiedFiles++;
      } catch (error) { failures.push({path: registered.path, reason: error.code === 'ENOENT' ? '原文件缺失' : error.message}); }
    }
    packages.push({id: skill.id, complete: failures.length === 0, expectedFiles: skill.files.length, verifiedFiles: skill.files.length - failures.length, failures});
  }
  return {scope: 'workbench-only', execution: 'guidance-only', scriptsExecuted: false, complete: verifiedFiles === totalFiles, packageCount: packages.length, totalFiles, verifiedFiles, packages};
}

async function bodyJson(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > maxBodyBytes) throw fail('技能设置请求过大', 413); chunks.push(buffer); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('技能设置不是有效 JSON'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw fail('技能设置须为对象');
  return body;
}

function json(req, res, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store'});
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

function updateFields(body, entry, scenarios) {
  const keys = Object.keys(body);
  if (!keys.length || keys.some(k => !['enabled', 'name', 'scenario', 'instructions'].includes(k))) throw fail('仅能修改启停、名称、情境和指导内容');
  const updated = {...entry};
  if ('enabled' in body) { if (typeof body.enabled !== 'boolean') throw fail('启停状态须为布尔值'); updated.enabled = body.enabled; }
  for (const [field, max, label] of [['name', 80, '技能名称'], ['instructions', 6000, '创作指导']]) {
    if (!(field in body)) continue;
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].trim().length > max || body[field].includes('\0')) throw fail(label + '不能为空或超过 ' + max + ' 字');
    updated[field] = body[field].trim();
  }
  if ('scenario' in body) { if (typeof body.scenario !== 'string' || !scenarios.some(s => s.id === body.scenario)) throw fail('请选择已登记的使用情境'); updated.scenario = body.scenario; }
  return updated;
}

/** Resolve only explicitly selected, enabled guidance. No skill script or model is executed. */
export async function resolveCreativeSkills(dataDir, ids, {rootDir = projectRoot} = {}) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !skillId.test(id))) throw fail('请选择不超过 10 项已登记的创作技能');
  const selectedIds = [...new Set(ids)];
  if (selectedIds.length > 10) throw fail('请选择不超过 10 项已登记的创作技能');
  if (!selectedIds.length) return [];
  return locked(dataDir, async () => {
    const {seed} = await loadSeed(rootDir), catalog = await loadCatalog(dataDir, seed), skills = mergedSkills(seed, catalog);
    return selectedIds.map(id => {
      const skill = skills.find(s => s.id === id);
      if (!skill) throw fail('未知创作技能：' + id);
      if (!skill.enabled) throw fail('创作技能已停用：' + skill.name);
      return {id: skill.id, name: skill.name, scenario: skill.scenario, version: skill.version, instructions: skill.instructions, source: structuredClone(skill.source), ...(skill.referenceOnly ? {referenceOnly: true} : {})};
    });
  });
}

/** Must be mounted behind the studio's existing Host and Origin validation. */
export async function handleCreativeSkills(req, res, url, {dataDir, rootDir = projectRoot} = {}) {
  if (!(url.pathname === '/api/creative-skills' || url.pathname.startsWith('/api/creative-skills/'))) return false;
  try {
    if (!dataDir) throw fail('工作台数据目录缺失', 503);
    const match = /^\/api\/creative-skills(?:\/([a-z0-9][a-z0-9-]{0,63})(?:\/(read))?)?\/?$/.exec(url.pathname);
    if (!match) throw fail('未找到创作技能接口', 404);
    const id = match[1], action = match[2];
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) throw fail('不支持该技能操作', 405);
    if (req.method === 'POST' && (!id || action)) throw fail('未找到技能写入接口', 404);
    const body = req.method === 'POST' ? await bodyJson(req) : null;
    await locked(dataDir, async () => {
      const {seed, skillsRoot} = await loadSeed(rootDir), catalog = await loadCatalog(dataDir, seed);
      let skills = mergedSkills(seed, catalog), skill = id ? skills.find(s => s.id === id) : null;
      if (id && !skill) throw fail('未知创作技能：' + id, 404);
      if (action === 'read') {
        const requested = url.searchParams.get('path') || 'SKILL.md';
        if (!validRelativePath(requested)) throw fail('技能文件路径无效');
        const registered = skill.files.find(f => f.path === requested);
        if (!registered || !registered.readable || !(/\.(?:md|json|txt)$/i.test(requested) || /^LICENSE(?:\.[a-z]+)?$/i.test(requested))) throw fail('仅可读取已登记的技能文档与许可', 404);
        const file = await safeRegisteredFile(skillsRoot, skill.rootPath + '/' + requested);
        if (file.bytes > maxReadableBytes) throw fail('技能原文过大，请选择具体参考文档', 413);
        const bytes = await readFile(file.path);
        let text; try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { throw fail('技能原文不是有效 UTF-8 文本'); }
        const sha256 = digest(bytes);
        json(req, res, 200, {skillId: skill.id, path: requested, content: text, text, bytes: bytes.length, sha256, expectedSha256: registered.sha256, integrity: sha256 === registered.sha256 && bytes.length === registered.bytes});
        return;
      }
      if (req.method === 'POST') {
        const updated = updateFields(body, skill, seed.scenarios), fields = ['name', 'scenario', 'enabled', 'instructions'];
        if (fields.some(k => updated[k] !== skill[k])) {
          const before = Object.fromEntries(['id', ...fields, 'version'].map(k => [k, skill[k]]));
          const after = {...before, ...Object.fromEntries(fields.map(k => [k, updated[k]])), version: skill.version + 1, updatedAt: new Date().toISOString()};
          const index = catalog.skills.findIndex(s => s.id === skill.id);
          if (index === -1) catalog.skills.push(after); else catalog.skills[index] = after;
          catalog.version++; catalog.updatedAt = after.updatedAt;
          catalog.revisions.push({id: randomUUID(), skillId: skill.id, createdAt: after.updatedAt, before, after: structuredClone(after)});
          await saveCatalog(dataDir, catalog);
          skills = mergedSkills(seed, catalog); skill = skills.find(s => s.id === id);
        }
      }
      const installation = await installationState(skillsRoot, skills);
      json(req, res, 200, {skills, scenarios: seed.scenarios, installation, ...(skill ? {skill} : {})});
    });
  } catch (error) { json(req, res, error.status || (error.code === 'ENOENT' ? 404 : 500), {error: error.message}); }
  return true;
}
