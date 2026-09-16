// 入口侧（Codex 或 Claude Code）的框架客户端：查档位、让 DSH 进程在用户默认浏览器里打开自己的界面、看开场大小。
// 用法：node app/framework.mjs state | open | opening   [--config connection.local.json]
import {readFileSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client, envValues} from './connection-client.mjs';

const args = process.argv.slice(2);
let configPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'connection.local.json'); // 按脚本自己所在的 skill 目录找配置
const ci = args.indexOf('--config');
if (ci >= 0) { configPath = resolve(args[ci + 1]); args.splice(ci, 2); }
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const client = new Client(config);
const command = args[0] ?? 'state';

async function api(path, body) {
  if (!client.cookie) await client.login();
  const r = await fetch(client.base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Cookie: client.cookie, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let v; try { v = JSON.parse(text); } catch { v = {raw: text}; }
  if (!r.ok) throw new Error(v.error ?? ('FRAMEWORK_HTTP_' + r.status));
  return v;
}
const brief = s => ({stage: s.stage, scan: s.scan ?? null, first_meeting_done: s.first_meeting_done, required_slots: s.required_slots, runs: s.runs, talk_runs: s.talk_runs, drawer_open: s.drawer_open, stale: s.stale, conflicted: s.conflicted});

try {
  let out;
  if (command === 'state') out = brief(await api('/framework/api/state'));
  else if (command === 'open') {
    const token = envValues(config.dsh_root).STUDY_LAUNCH_TOKEN ?? envValues(config.dsh_root).DSH_DIALOGUE_LAUNCH_TOKEN;
    const r = await api('/framework/api/open', token ? {path: '/?token=' + encodeURIComponent(token)} : {});
    out = {...r, state: brief(await api('/framework/api/state'))};
  } else if (command === 'opening') {
    const r = await api('/framework/api/opening?format=json');
    out = {stage: r.stage, bytes: r.bytes, omitted: r.omitted};
  } else throw new Error('UNKNOWN_COMMAND');
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} catch (e) { console.error(e.message); process.exitCode = 1; }
