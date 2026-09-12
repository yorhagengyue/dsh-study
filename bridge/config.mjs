import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export async function readEnv(projectRoot) {
  const values = {};
  for (const line of (await readFile(join(projectRoot, '.env'), 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return values;
}

export async function loadConfig(projectRoot) {
  const config = JSON.parse(await readFile(join(projectRoot, 'bridge.local.json'), 'utf8'));
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('BRIDGE_CONFIG_PORT');
  for (const name of ['dshInstall', 'runtimeHome']) if (typeof config[name] !== 'string' || !isAbsolute(config[name])) throw new Error('BRIDGE_CONFIG_PATH');
  if (!Array.isArray(config.workspaceRoots) || !config.workspaceRoots.length || config.workspaceRoots.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('BRIDGE_CONFIG_WORKSPACES');
  return {...config, host: '127.0.0.1'};
}

export async function initializeLocal(projectRoot, options = {}) {
  await mkdir(projectRoot, {recursive: true});
  const dshInstall = resolve(options.dshInstall ?? join(homedir(), 'dsh'));
  // Only the existing runtime's model credential may be reused, only with the explicit flag.
  const envPath = join(projectRoot, '.env');
  let raw = await readFile(envPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const existing = raw ? await readEnv(projectRoot) : {};
  const added = [];
  if (!existing.BRIDGE_API_TOKEN) { raw += `\nBRIDGE_API_TOKEN=${randomBytes(40).toString('base64url')}\n`; added.push('BRIDGE_API_TOKEN'); }
  if (!existing.DEEPSEEK_API_KEY && options.reuseDshCredential) {
    const dshEnv = await readEnv(dshInstall);
    if (!dshEnv.DEEPSEEK_API_KEY || /[\r\n]/.test(dshEnv.DEEPSEEK_API_KEY)) throw new Error('DSH_MODEL_CREDENTIAL_MISSING');
    raw += `DEEPSEEK_API_KEY=${dshEnv.DEEPSEEK_API_KEY}\n`;
    added.push('DEEPSEEK_API_KEY');
  }
  if (added.length) await writeFile(envPath, raw, {encoding: 'utf8', mode: 0o600});
  const config = {
    port: options.port ?? 8767, dshInstall,
    runtimeHome: join(projectRoot, 'runtime', 'bridge', 'runtime-home'),
    workspaceRoots: [join(projectRoot, 'work', 'bridge-tasks')],
    maxConcurrent: 1, runTimeoutMs: 240000,
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low', maxTokens: 2048,
    allowedStudySources: ['personal-example'],
    python: options.python ?? (process.platform === 'win32' ? 'python' : 'python3'),
  };
  let configCreated = false;
  try { await writeFile(join(projectRoot, 'bridge.local.json'), JSON.stringify(config, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'}); configCreated = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const actual = await loadConfig(projectRoot);
  for (const path of actual.workspaceRoots) await mkdir(path, {recursive: true});
  return {configured: true, config_created: configCreated, credential_fields_added: added, credential_values_printed: false};
}
