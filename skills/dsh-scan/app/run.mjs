#!/usr/bin/env node
// dsh-scan/app/run.mjs — 全扫一条龙，给入口（Codex 或 Claude Code）用，任何机器任何用户一样。
// 耿越 2026-09-16 定：全扫的意义是理解用户，不是数文件；扫完没有反思等于没扫。这个脚本把"跑、读、反思"串起来，
// 让入口不用自己拼命令、不用啃 70 KB 的汇总、也没法跳过反思。
//
// 用法（本 skill 目录 = SKILL.md 所在目录）：
//   node app/run.mjs [--config <connection.local.json>] [--max-files N] [--max-bytes N] [--max-seconds N]
//       跑 scan.mjs → 把汇总压成摘要打印 → 在 <工作区>/connection/entry/SCAN-<日期>-反思.md 生成骨架（已有不动）
//   node app/run.mjs --no-scan      不跑扫描，用最新的 SCAN-<日期>.md 做摘要和骨架（安装器已经扫过时）
//   node app/run.mjs check          最新扫描的反思写完没有：exit 0 写完 / 3 没写或没填完 / 4 还没有扫描
//   node app/run.mjs --force        骨架已存在也重写（只在骨架坏了时用；会覆盖已填的内容）
// 退出码：0 正常；2 扫描被权限拦住（结果不算，别说扫完）；3/4 见 check；1 脚本自己出错。
// 配置：本目录的 connection.local.json；没有就用旁边 dsh-dialogue/ 里的那份。scan.mjs 同理（本目录 app/ 没有就用 dsh-dialogue/app/）。
import {readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync} from 'node:fs';
import {join, resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {hostname} from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'run';
const fail = (msg, code) => { process.stderr.write(msg + '\n'); process.exit(code); };
const firstExisting = (...ps) => ps.find(p => existsSync(p));

const configPath = resolve(opt('--config', firstExisting(join(here, '..', 'connection.local.json'), join(here, '..', '..', 'dsh-dialogue', 'connection.local.json')) || join(here, '..', 'connection.local.json')));
if (!existsSync(configPath)) fail(`找不到配置 ${configPath}：本 skill 目录或旁边的 dsh-dialogue/ 里应有 connection.local.json（安装器写的）。`, 1);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (!config.workspace) fail(`配置 ${configPath} 里没有 workspace。`, 1);
const workspace = resolve(config.workspace);
const scanScript = firstExisting(join(here, 'scan.mjs'), join(here, '..', '..', 'dsh-dialogue', 'app', 'scan.mjs'));
const ctxDir = join(workspace, 'connection', 'context');
const entryDir = join(workspace, 'connection', 'entry');
const SECTIONS = ['1. 这次扫描说明了这个用户什么', '2. 哪里看不见、没覆盖、误判了', '3. 下一步读哪几处原文、问用户什么', '4. 和上一次扫描比变了什么', '5. 对用户说了什么'];

function latestScan() {
  if (!existsSync(ctxDir)) return null;
  const f = readdirSync(ctxDir).filter(x => /^SCAN-\d{4}-\d{2}-\d{2}\.md$/.test(x)).sort().pop();
  return f ? join(ctxDir, f) : null;
}
const dateOf = (scanFile) => basename(scanFile).match(/SCAN-(\d{4}-\d{2}-\d{2})\.md$/)[1];
const reflectionPath = (date) => join(entryDir, `SCAN-${date}-反思.md`);

// ---- 读 markdown ----
function section(text, title) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex(l => l.startsWith('## ') && l.slice(3).startsWith(title));
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length && !lines[j].startsWith('## '); j++) out.push(lines[j]);
  return out.join('\n');
}
function tableRows(body) {
  if (!body) return [];
  const rows = body.split(/\r?\n/).filter(l => l.startsWith('|'));
  return rows.slice(2).map(l => l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|')));
}
const unq = (s) => (s || '').replace(/^`|`$/g, '');
const parentKey = (p, n = 5) => { const parts = p.split(/[\\/]/); return parts.slice(0, Math.min(parts.length - 1, n)).join('/') || p; };
const tally = (arr, keyFn) => { const m = new Map(); for (const x of arr) { const k = keyFn(x); m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };

// ---- 摘要：给入口读的一页 ----
function digest(scanFile) {
  const text = readFileSync(scanFile, 'utf8');
  const date = dateOf(scanFile);
  const blocked = /⚠ 这份结果不完整/.test(text);
  const sum = Object.fromEntries(tableRows(section(text, '汇总')).map(r => [r[0], r[1]]));
  const roots = (sum['扫的根'] || '').split('；').map(s => s.trim()).filter(Boolean);
  const cand = tableRows(section(text, '候选来源')).filter(r => r[0] && !r[0].startsWith('（'));
  const byCat = new Map(); for (const r of cand) { const a = byCat.get(r[0]) || []; a.push(r); byCat.set(r[0], a); }
  const dirs = tableRows(section(text, '按目录'));
  const forb = tableRows(section(text, '禁区')).filter(r => r[0] && !r[0].startsWith('（'));
  const unc = (section(text, '未覆盖') || '').split(/\r?\n/).filter(l => l.startsWith('- '));
  const invisible = tableRows(section(text, '看不见的地方'));
  const chg = section(text, '变化') || '';
  const chgHead = (chg.match(/新增 \d+，修改 \d+，消失 \d+。/) || [''])[0];
  const chgPrev = ((section(text, '变化') !== null && text.match(/^## 变化（对比 (.+?)）/m)) || [])[1];
  const chgItems = chg.split(/\r?\n/).map(l => l.match(/^- (新增|修改|消失) `(.+)`$/)).filter(Boolean);
  const out = [];
  out.push(`# 全扫摘要 · ${date}`, '', `给入口读的一页；完整汇总在 \`${scanFile}\`，要看细节再开对应的节。清单只列文件名，没有读过任何内容。`, '');
  if (blocked) out.push('> **⚠ 这次扫描被权限拦住了，结果不算完整。** 不要说扫完了：让用户把当前这个工具（Codex 或 Claude Code）关掉重开一次再跑；Mac 上还要在系统设置里给它"文件与文件夹"权限。', '');
  out.push('## 汇总', '', `- 根 ${roots.length} 个：${roots.slice(0, 12).map(r => r.replace(/`/g, '')).join('；')}${roots.length > 12 ? `；…共 ${roots.length} 个` : ''}`,
    `- 目录 / 文件 / 字节：${sum['目录 / 文件 / 字节'] || '?'}；用时 ${sum['用时'] || '?'}；预算 ${sum['预算'] || '?'}`,
    `- 未覆盖 ${sum['未覆盖'] || '?'}；看不见：${sum['看不见'] || '?'}；禁区 ${sum['禁区'] || '?'}；私密/第三方只列：${sum['私密只列'] || '?'}；覆盖状态 ${sum['覆盖状态'] || '?'}`, '');
  if (invisible.length) { out.push('## 看不见的地方', ''); for (const r of invisible) out.push(`- ${r[0]}：${r[1]}，${r[2]}`); out.push(''); }
  out.push('## 候选来源（按类别；这是理解他的入口，不是清单）', '');
  const showPaths = {'用户维护的规则文件': 6, 'AI 工具的记忆': 8, '笔记库': 4, '内容区里的规则文件': 12, '本地课件目录': 15, '日历': 5};
  for (const [cat, rows] of byCat) {
    const n = showPaths[cat] ?? 0;
    if (!n) { out.push(`- ${cat} ${rows.length}（只计数）`); continue; }
    const shown = rows.slice(0, n).map(r => `\`${unq(r[1])}\`${r[3] && r[3] !== '课程名、周次、清单；谈话里确认后升级' && r[3] !== 'AI 记忆日志段落按 assistant_summary' ? `（${r[3]}）` : ''}`);
    out.push(`- ${cat} ${rows.length}：${shown.join('，')}${rows.length > n ? `，…` : ''}`);
  }
  out.push('', '## 最近在动的目录（按最近修改，前 25；看他最近把时间花在哪）', '', '| 目录 | 文件 | 大小 | 最近修改 | 主要类型 |', '|---|---|---|---|---|');
  for (const r of dirs.slice(0, 25)) out.push(`| \`${unq(r[0])}\` | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`);
  out.push('', `## 禁区 ${forb.length}（只登记，未读）：${tally(forb, r => r[1]).map(([k, v]) => `${k} ${v}`).join('；') || '无'}`);
  out.push('', `## 未覆盖 ${sum['未覆盖'] || unc.length + ' 处'}${unc.length ? '：' + unc.slice(0, 4).map(l => l.replace(/^- /, '')).join('；') + (unc.length > 4 ? '；…' : '') : ''}`);
  if (chgPrev) { out.push('', `## 变化（对比 ${chgPrev}）：${chgHead.replace(/。$/, '') || '无'}`); for (const kind of ['新增', '修改', '消失']) { const items = chgItems.filter(m => m[1] === kind); if (items.length) out.push(`- ${kind}集中在（汇总只列前 30 条）：${tally(items, m => parentKey(m[2])).slice(0, 6).map(([k, v]) => `${k} ${v}`).join('；')}`); } }
  else out.push('', '## 变化：第一次扫，没有上一次可比');
  return {markdown: out.join('\n') + '\n', date, blocked, files: (sum['目录 / 文件 / 字节'] || '').split('/')[1]?.trim() || '?', roots: roots.length, coverage: (sum['覆盖状态'] || '').match(/`([a-z_]+)`/)?.[1] || '?'};
}

// ---- 反思骨架 ----
function writeSkeleton(d, force) {
  const p = reflectionPath(d.date);
  if (existsSync(p) && !force) return {path: p, created: false};
  mkdirSync(entryDir, {recursive: true});
  const L = [
    `# 全扫反思 · ${d.date}`, '',
    `扫描：\`connection/context/SCAN-${d.date}.md\`（${d.files} 文件，${d.roots} 根，覆盖 \`${d.coverage}\`${d.blocked ? '，⚠ 被权限拦住' : ''}，本机 ${hostname()}）。写的人：（待填：Codex 或 Claude Code，写实际的那个）。写于：（待填：日期 时间）。`, '',
    '按 `protocols/DISCOVERY.md` 第 8 节写。每节三到五句，写完把所有「待填」标记连括号一起删掉，再跑 `node <本 skill 目录>/app/run.mjs check`，它报 ok 才算扫完。收件人是维护者、下一轮的入口和以后的 DSH，不是用户；对用户说的话在第 5 节。', '',
    `## ${SECTIONS[0]}`, '', '（待填：他是谁、在做什么、怎么组织自己的东西。用候选来源、目录结构、课件和笔记的分布说话，不列文件。从积极的一面开始；量他的尺度是层级不是数量。私密来源只写模式，标【含私密】。）', '',
    `## ${SECTIONS[1]}`, '', '（待填：权限、禁区误报、被当成课件的代码目录、网盘或 iCloud 副本、聊天软件缓存占掉的预算。下次怎么修；能改成规则的写成一句「以后……」。）', '',
    `## ${SECTIONS[2]}`, '', '（待填：三处以内的路径和为什么。只问一个问题，把那句话写出来。）', '',
    `## ${SECTIONS[3]}`, '', '（待填：没有上一次就写「第一次」；有就说变化集中在哪、说明他这几天在忙什么。）', '',
    `## ${SECTIONS[4]}`, '', '（待填：原样贴上对用户说的那几句和那一个问题。）', ''];
  writeFileSync(p, L.join('\n'), 'utf8');
  return {path: p, created: true};
}

function checkReflection(scanFile) {
  const p = reflectionPath(dateOf(scanFile));
  if (!existsSync(p)) return {ok: false, reflection: p, missing: ['文件不存在：先跑 node app/run.mjs --no-scan 生成骨架再填']};
  const t = readFileSync(p, 'utf8');
  const missing = [];
  for (const h of SECTIONS) {
    const body = section(t, h);
    if (body === null) { missing.push(`「${h}」这一节没了`); continue; }
    if (body.replace(/（待填[^）\n]*）/g, '').trim().length < 20) missing.push(`「${h}」没填`);
  }
  const m = t.match(/（待填[^）\n]*）/g);
  if (m) missing.push(`还有 ${m.length} 处「（待填」没删（含开头的写的人 / 写于）`);
  return {ok: missing.length === 0, reflection: p, missing};
}

// ---- 主流程 ----
if (mode === 'check') {
  const s = latestScan();
  if (!s) fail(`没有任何 SCAN-<日期>.md（${ctxDir}）：先跑 node app/run.mjs`, 4);
  const r = checkReflection(s);
  process.stdout.write(JSON.stringify({scan: s, ...r}, null, 2) + '\n');
  if (!r.ok) process.stderr.write(`反思没写完：${r.missing.join('；')}\n`);
  process.exit(r.ok ? 0 : 3);
}
if (mode !== 'run') fail(`不认识的子命令 ${mode}；只有 run（默认）和 check`, 1);

let scanFile, scanJson = null, scanExit = 0;
if (has('--no-scan')) {
  scanFile = latestScan();
  if (!scanFile) fail(`没有任何 SCAN-<日期>.md（${ctxDir}）：去掉 --no-scan 先扫一次`, 4);
} else {
  if (!scanScript) fail('找不到 scan.mjs：本目录 app/ 或旁边 dsh-dialogue/app/ 里应有一份', 1);
  const pass = ['--config', configPath];
  for (const f of ['--max-files', '--max-bytes', '--max-seconds']) { const v = opt(f); if (v !== undefined) pass.push(f, v); }
  const r = spawnSync(process.execPath, [scanScript, ...pass], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  scanExit = r.status ?? 1;
  try { scanJson = JSON.parse(r.stdout); } catch { fail(`scan.mjs 没有正常输出（退出码 ${r.status}）：\n${(r.stderr || r.stdout || r.error?.message || '').slice(0, 2000)}`, 1); }
  if (r.stderr) process.stderr.write(r.stderr);
  scanFile = scanJson.scan;
}
const d = digest(scanFile);
const sk = writeSkeleton(d, has('--force'));
const chk = checkReflection(scanFile);
process.stdout.write(d.markdown);
process.stdout.write(`\n## 反思：\`${sk.path}\`（${sk.created ? '骨架已生成，去填五节' : chk.ok ? '已写完' : '已存在，还没填完：' + chk.missing.join('；')}）\n\n`);
process.stdout.write(JSON.stringify({scan: scanFile, reflection: sk.path, reflection_created: sk.created, reflection_ok: chk.ok, blocked: d.blocked, coverage: d.coverage, files: d.files, roots: d.roots, scan_exit: scanExit, scan_json: scanJson}, null, 2) + '\n');
process.exitCode = d.blocked ? 2 : (scanExit === 2 ? 2 : 0);
