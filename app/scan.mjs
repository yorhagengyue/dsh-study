// 全扫脚本（protocols/DISCOVERY.md 的程序实现）。由主 agent（入口 Codex）在派工前运行，不用模型；DSH 不扫电脑，只读输出。
// 安装器装完会先跑一次（安装器跑在用户自己的权限下，不在 Codex 沙箱里）；之后由入口在 SCAN 缺失或过期时再跑。
// 用法：node app/scan.mjs [--config connection.local.json] [--max-files 20000] [--max-bytes 2147483648] [--max-seconds 600]
// 输出：<workspace>/connection/context/SCAN-<日期>.md（汇总）与 SCAN-<日期>-清单.md（完整清单）；回写 MANIFEST.md 的 coverage。
// 退出码：0 正常；2 = 根被权限挡住（列不了家目录根、读不了笔记库登记表、根目录进不去或列不出来；macOS 没批桌面/文稿/下载的隐私权限也算）。这时结果不完整：
//   汇总里有「看不见的地方」一节，覆盖状态 blocked，stderr 有一句人话。入口见到就报"被拦住"，不得报"扫完了"（DISCOVERY 第 0 节）。
import {readFileSync, writeFileSync, existsSync, readdirSync, statSync, lstatSync, mkdirSync, renameSync} from 'node:fs';
import {join, resolve, basename, extname, dirname, sep} from 'node:path';
import {homedir, hostname, platform, release} from 'node:os';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const configPath = resolve(opt('--config', join(homedir(), '.codex', 'skills', 'dsh-dialogue', 'connection.local.json')));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const workspace = resolve(config.workspace);
const MAX_FILES = Number(opt('--max-files', 20000));
const MAX_BYTES = Number(opt('--max-bytes', 2 * 1024 * 1024 * 1024));
const MAX_MS = Number(opt('--max-seconds', 600)) * 1000;
const HOME = homedir();
const started = Date.now();
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const dateTag = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const errCode = (e) => (e && e.code) ? String(e.code) : String(e && e.message ? e.message : e).slice(0, 60);

// ---- 范围（DISCOVERY 2.2）与排除（2.4） ----
const EXCLUDE_DIR = /^(node_modules|\.git|\.venv|venv|__pycache__|dist|build|\.cache|cache|caches|\.next|\.nuxt|target|\$recycle\.bin|\.pnpm-store|\.gradle|\.idea|\.vs|\.mypy_cache|\.pytest_cache|coverage|obj|bin)$/i;
const READ_EXT = new Set(['.md', '.txt', '.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.json', '.ics', '.html', '.htm']);
const LIST_ONLY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp3', '.mp4', '.wav', '.m4a', '.mov', '.mkv', '.zip', '.7z', '.rar', '.tar', '.gz', '.exe', '.msi', '.dll', '.dmg', '.iso', '.bin']);
const BIG_FILE = 50 * 1024 * 1024;

// ---- 禁区（DISCOVERY 5） ----
const FORBIDDEN_FILE = /^(\.env(\..*)?|.*\.(pem|key|kdbx|p12|pfx)|id_rsa.*|id_ed25519.*|.*(credential|credentials|cookie|cookies|token|secret|password|passwd).*)$/i;
const FORBIDDEN_DIR = /^(\.ssh|\.gnupg|\.aws|\.azure|\.config\/gcloud|User Data|Profiles|Login Data|Keychains)$/i;
const PRIVATE_NAME = /(diary|日记|journal|private|私密|健康|health|obsession)/i;
const EXPORT_PACK = /(chatgpt|claude|gemini|conversations|openai).*\.(zip|json)$/i;
const THIRD_PARTY = /(whatsapp|wechat|微信|telegram|classlist|名册|roster|群文件|chat[-_ ]?(log|history)|聊天记录)/i;
const COURSE_DIR = /(^[A-Z]{2,4}\s?\d{3}[A-Z]?$)|课件|课程|lecture|week\s?\d|semester|term\s?\d|^(smu|nus|ntu|usyd|unsw|canvas|elearn)$/i;
const RULE_FILE = /^(CLAUDE\.md|AGENTS\.md|\.cursorrules|GEMINI\.md|copilot-instructions\.md)$/i;

// ---- 看不见的地方：根一级被权限挡住就记在这里，结果不算完整 ----
const blocked = [];   // {path, what, error}
let deniedDirs = 0;   // 走目录时被权限拒绝的目录数（目录级，不算根级）

const roots = [];
let privateDirs = 0; // 放了 .dsh-private 标记的目录数（根或子目录），只计数不记路径
const addRoot = (p, label) => {
  if (!p) return;
  let st; try { st = statSync(p); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') blocked.push({path: p, what: `进根目录（${label}）`, error: errCode(e)}); return; }
  if (!st.isDirectory()) return;
  if (p.toLowerCase() === workspace.toLowerCase()) return; // 框架自己不算用户内容
  let priv = false; try { priv = existsSync(join(p, '.dsh-private')); } catch {}
  if (priv) { privateDirs++; return; } // 放了 .dsh-private 的根连名字都不列
  if (!roots.some(r => r.path.toLowerCase() === p.toLowerCase())) roots.push({path: p, label});
};
for (const [name, label] of [['Desktop', '桌面'], ['Documents', '文档'], ['Downloads', '下载']]) addRoot(join(HOME, name), label);
// 笔记库：Obsidian 登记的 vault。登记表读不了（不是"不存在"）就是被挡住了，要出声。
let vaults = [];
{
  const reg = platform() === 'darwin' ? join(HOME, 'Library', 'Application Support', 'obsidian', 'obsidian.json') : join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
  try { const j = JSON.parse(readFileSync(reg, 'utf8')); vaults = Object.values(j.vaults || {}).map(v => v.path).filter(Boolean); for (const v of vaults) addRoot(v, '笔记库'); }
  catch (e) { if (e && e.code && e.code !== 'ENOENT') blocked.push({path: reg, what: '读笔记库登记表（Obsidian）', error: errCode(e)}); }
}
// 用户目录下深度 ≤ 3 的代码仓（含 .git）。家目录根本身列不了就是被挡住了，要出声。
const repos = [];
(function findRepos(dir, depth) {
  if (depth > 3) return;
  let ents; try { ents = readdirSync(dir, {withFileTypes: true}); }
  catch (e) { if (dir === HOME) blocked.push({path: dir, what: '列家目录根（找代码仓）', error: errCode(e)}); else if (e.code === 'EPERM' || e.code === 'EACCES') deniedDirs++; return; }
  for (const e of ents) {
    if (!e.isDirectory() || EXCLUDE_DIR.test(e.name) || e.name.startsWith('.') && e.name !== '.git' || /^(AppData|Application Data|Library)$/i.test(e.name)) continue;
    const p = join(dir, e.name);
    if (existsSync(join(p, '.git'))) { repos.push(p); continue; }
    findRepos(p, depth + 1);
  }
})(HOME, 1);
for (const r of repos) addRoot(r, '代码仓');
const rootSet = new Set(roots.map(r => r.path.toLowerCase())); // 走一个根时，碰到另一个根就跳过：它会单独走一遍（避免仓库被计两次）

// ---- 已知入口（DISCOVERY 2.1） ----
const known = [];
const addKnown = (category, p, basis, note = '') => { if (existsSync(p)) known.push({category, path: p, basis, note}); };
for (const f of ['CLAUDE.md', 'AGENTS.md', '.cursorrules']) addKnown('用户维护的规则文件', join(HOME, f), 'user_rule_file');
addKnown('用户维护的规则文件', join(HOME, '.codex', 'AGENTS.md'), 'user_rule_file');
addKnown('用户维护的规则文件', join(HOME, '.claude', 'CLAUDE.md'), 'user_rule_file');
try { for (const d of readdirSync(join(HOME, '.claude', 'projects'))) { const m = join(HOME, '.claude', 'projects', d, 'memory'); if (existsSync(m)) addKnown('AI 工具的记忆', m, 'assistant_summary', `${readdirSync(m).filter(f => f.endsWith('.md')).length} 个文件`); } } catch {}
addKnown('AI 工具的记忆', join(HOME, '.codex', 'memories'), 'assistant_summary');
try { for (const d of readdirSync(join(HOME, '.codex', 'skills'))) addKnown('AI 工具的技能', join(HOME, '.codex', 'skills', d, 'SKILL.md'), '不抽事实'); } catch {}
try { for (const d of readdirSync(join(HOME, '.claude', 'skills'))) addKnown('AI 工具的技能', join(HOME, '.claude', 'skills', d), '不抽事实'); } catch {}
for (const v of vaults) addKnown('笔记库', v, 'user_rule_file', 'Obsidian vault');

// ---- 走目录 ----
const rows = [];        // 清单：{path,type,size,mtime,use,owner,handle}
const dirStats = new Map(); // 顶层目录统计
const forbidden = [];   // 禁区
const exportPacks = [];
const courseDirs = [];
const calendars = [];
const ruleFiles = [];
const uncovered = [];   // 预算外或读不了
let files = 0, bytes = 0, dirs = 0, stopped = null;
const topOf = (p, root) => { const rel = p.slice(root.length + 1); const i = rel.indexOf(sep); return join(root, i < 0 ? rel : rel.slice(0, i)); };
function walk(dir, root, depth, label = '') {
  if (stopped) return;
  if (Date.now() - started > MAX_MS) { stopped = '时间预算用完'; uncovered.push(dir); return; }
  if (files >= MAX_FILES) { stopped = '文件数预算用完'; uncovered.push(dir); return; }
  if (bytes >= MAX_BYTES) { stopped = '字节预算用完'; uncovered.push(dir); return; }
  if (depth > 6) { uncovered.push(dir + '（超过 6 层）'); return; }
  if (existsSync(join(dir, '.dsh-private'))) { privateDirs++; return; } // 放了标记的目录：不进、不列、不记路径，只计数
  let ents; try { ents = readdirSync(dir, {withFileTypes: true}); }
  catch (e) { const c = errCode(e); if (c === 'EPERM' || c === 'EACCES') deniedDirs++; if (depth === 1) blocked.push({path: dir, what: `进根目录（${label}）`, error: c}); uncovered.push(dir + `（读不了：${c}）`); return; } // 根本身列不出来（macOS 没给桌面/文稿/下载权限时 stat 能过、readdir 是 EPERM）也算被拦
  dirs++;
  for (const e of ents) {
    if (stopped) return;
    const p = join(dir, e.name);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) { rows.push({path: p, type: 'link', size: 0, mtime: st.mtime, use: '链接', owner: '不确定', handle: '只列，不跟随'}); continue; }
    if (e.isDirectory()) {
      if (EXCLUDE_DIR.test(e.name)) continue;
      if (FORBIDDEN_DIR.test(e.name)) { forbidden.push({path: p, kind: '凭证或浏览器数据目录，未进'}); continue; }
      if (rootSet.has(p.toLowerCase())) continue; // 另一个根（仓库、笔记库），单独走，不在这里重复列
      if (COURSE_DIR.test(e.name)) courseDirs.push(p);
      if (p.toLowerCase() === workspace.toLowerCase()) continue; // 框架自己不算用户内容
      walk(p, root, depth + 1);
      continue;
    }
    if (!e.isFile()) continue;
    files++;
    const ext = extname(e.name).toLowerCase();
    // 字节预算只算 DSH 可能去读的文件（可读类型且 ≤ 50 MB）；只列的大文件不占预算。
    if (READ_EXT.has(ext) && st.size <= BIG_FILE) bytes += st.size;
    const top = topOf(p, root);
    const ds = dirStats.get(top) || {files: 0, bytes: 0, latest: 0, types: new Map()};
    ds.files++; ds.bytes += st.size; ds.latest = Math.max(ds.latest, st.mtimeMs); ds.types.set(ext || '(无后缀)', (ds.types.get(ext || '(无后缀)') || 0) + 1); dirStats.set(top, ds);
    let use = '其他', owner = '本人', handle = READ_EXT.has(ext) ? '可读' : '只列';
    if (FORBIDDEN_FILE.test(e.name)) { handle = '禁区未读'; use = '凭证形态'; forbidden.push({path: p, kind: '文件名像凭证，未读'}); }
    else if (EXPORT_PACK.test(e.name)) { handle = '私密，只列'; use = 'AI 对话导出包'; exportPacks.push(p); }
    else if (PRIVATE_NAME.test(e.name) || PRIVATE_NAME.test(basename(dir))) { handle = '私密，只列'; use = '私密'; }
    else if (THIRD_PARTY.test(e.name) || THIRD_PARTY.test(basename(dir))) { handle = '第三方，只列'; owner = '他人'; use = '第三方资料'; }
    else if (RULE_FILE.test(e.name)) { use = '规则文件'; ruleFiles.push(p); }
    else if (ext === '.ics') { use = '日历'; calendars.push(p); }
    else if (COURSE_DIR.test(basename(dir)) || COURSE_DIR.test(basename(dirname(dir)))) use = '课件';
    else if (vaults.some(v => p.toLowerCase().startsWith(v.toLowerCase()))) use = '笔记';
    else if (repos.some(r => p.toLowerCase().startsWith(r.toLowerCase()))) use = '代码';
    else if (LIST_ONLY_EXT.has(ext)) use = '媒体或包';
    if (st.size > BIG_FILE && handle === '可读') handle = '只列（>50 MB）';
    rows.push({path: p, type: ext || '(无后缀)', size: st.size, mtime: st.mtime, use, owner, handle});
  }
}
for (const r of roots) walk(r.path, r.path, 1, r.label);
const elapsedMs = Date.now() - started;

// ---- 与上次比较（DISCOVERY 7） ----
const ctxDir = join(workspace, 'connection', 'context');
mkdirSync(ctxDir, {recursive: true});
let prevList = null;
try {
  const prev = readdirSync(ctxDir).filter(f => /^SCAN-\d{4}-\d{2}-\d{2}-清单\.md$/.test(f) && !f.startsWith(`SCAN-${dateTag}`)).sort().pop();
  if (prev) { prevList = new Map(); for (const line of readFileSync(join(ctxDir, prev), 'utf8').split('\n')) { const m = line.match(/^\| `(.+?)` \| [^|]* \| [^|]* \| ([^|]+) \|/); if (m) prevList.set(m[1], m[2].trim()); } prevList.name = prev; }
} catch {}
let changes = null;
if (prevList) {
  const cur = new Map(rows.map(r => [r.path, isoLocal(r.mtime)]));
  const added = [...cur.keys()].filter(k => !prevList.has(k));
  const modified = [...cur.keys()].filter(k => prevList.has(k) && prevList.get(k) !== cur.get(k));
  // 上次清单里有、这次没有的路径：如果现在处在放了 .dsh-private 标记的目录下，连"消失"也不记，免得泄露路径。
  const underPrivate = (p) => { let d = dirname(p); for (let i = 0; i < 12 && d && d !== dirname(d); i++) { if (existsSync(join(d, '.dsh-private'))) return true; d = dirname(d); } return false; };
  const gone = [...prevList.keys()].filter(k => !cur.has(k) && !underPrivate(k));
  changes = {prev: prevList.name, added, modified, gone};
}

// ---- 写 SCAN 文件 ----
const fmtBytes = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' KB';
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
// 全盘从不等于全部：正常是 partial，用户在谈话里确认后才升 user_confirmed_enough；根被权限挡住是 blocked，结果不算数。
const coverage = blocked.length ? 'blocked' : 'partial';
const capNote = (n, cap, what) => n > cap ? `| （${what}共 ${n} 条，这里只列前 ${cap} 条；完整清单见 \`SCAN-${dateTag}-清单.md\`） | | | |` : null;
const summary = [];
summary.push(`# 全扫 · ${dateTag}`, '', `由主 agent（入口 Codex）的脚本 \`scan.mjs\` 生成，${isoLocal(now)}（本机 ${hostname()}，${platform()} ${release()}）。只出清单，不复制原文；禁区只登记。DSH 读这份文件摆坐标，从"候选来源"里按需读原文；**DSH 自己不扫电脑**。完整清单在 \`SCAN-${dateTag}-清单.md\`。`, '');
if (blocked.length) summary.push('> **⚠ 这份结果不完整：根一级被权限挡住了（见下面「看不见的地方」）。** 跑脚本的 Codex 没有全盘权限。安装器已把用户的 Codex 设成全盘权限，但只对重开后的会话生效：让用户把 Codex 关掉重开一次，再重扫。DSH 不要把这份当已扫完。', '');
summary.push('## 汇总', '', '| 项 | 值 |', '|---|---|', `| 扫的根 | ${roots.map(r => `${r.label} \`${r.path}\``).join('；')} |`, `| 用时 | ${(elapsedMs / 1000).toFixed(1)} 秒 |`, `| 目录 / 文件 / 字节 | ${dirs} / ${files} / ${fmtBytes(bytes)} |`, `| 预算 | ${MAX_FILES} 文件、${fmtBytes(MAX_BYTES)}、${MAX_MS / 1000} 秒；${stopped ? '**' + stopped + '**' : '未用完'} |`, `| 未覆盖 | ${uncovered.length} 处 |`, `| 看不见 | 根一级权限拒绝 ${blocked.length} 处；目录一级读不了 ${deniedDirs} 处 |`, `| 禁区 | ${forbidden.length} 处（只登记，未读）；标记 .dsh-private 的目录 ${privateDirs} 个（不列） |`, `| 私密只列 | ${rows.filter(r => r.handle.startsWith('私密')).length}；第三方只列 ${rows.filter(r => r.handle.startsWith('第三方')).length} |`, `| 覆盖状态 | \`${coverage}\`（${coverage === 'blocked' ? '根被权限挡住，结果不算数；重开 Codex 后重扫' : '用户在谈话里确认够用后改 `user_confirmed_enough`'}） |`, '');
if (blocked.length) {
  summary.push('## 看不见的地方（权限被拒，本次结果不算完整）', '', '| 位置 | 想做什么 | 错误 |', '|---|---|---|');
  for (const b of blocked) summary.push(`| \`${cell(b.path)}\` | ${b.what} | ${b.error} |`);
  summary.push('', '按 `protocols/DISCOVERY.md` 第 0 节：这是跑脚本的 Codex 自己的沙箱把根挡住了，不是这些地方不存在。让用户把 Codex 关掉重开一次（安装器已给全盘权限，重开生效），再跑一次 `scan.mjs`。', '');
}
summary.push('## 候选来源（DSH 第一次见面从这里按需读原文）', '', '| 类别 | 路径 | basis | 备注 |', '|---|---|---|---|');
for (const k of known) summary.push(`| ${k.category} | \`${cell(k.path)}\` | \`${k.basis}\` | ${cell(k.note)} |`);
for (const p of ruleFiles.slice(0, 200)) summary.push(`| 内容区里的规则文件 | \`${cell(p)}\` | \`user_rule_file\` | AI 记忆日志段落按 assistant_summary |`);
{ const n = capNote(ruleFiles.length, 200, '内容区里的规则文件'); if (n) summary.push(n); }
const uniqueCourseDirs = [...new Set(courseDirs)];
for (const p of uniqueCourseDirs.slice(0, 100)) summary.push(`| 本地课件目录 | \`${cell(p)}\` | \`inferred_from_behavior\` | 课程名、周次、清单；谈话里确认后升级 |`);
{ const n = capNote(uniqueCourseDirs.length, 100, '本地课件目录'); if (n) summary.push(n); }
for (const p of calendars.slice(0, 20)) summary.push(`| 日历 | \`${cell(p)}\` | \`inferred_from_behavior\` | 课表、截止；谈话里确认 |`);
for (const p of [...new Set(exportPacks)].slice(0, 20)) summary.push(`| AI 对话导出包 | \`${cell(p)}\` | 私密 | 只列；用户允许后才抽用户自己发的消息 |`);
summary.push('', '## 按目录', '', '| 目录 | 文件 | 大小 | 最近修改 | 主要类型 |', '|---|---|---|---|---|');
for (const [d, s] of [...dirStats.entries()].sort((a, b) => b[1].latest - a[1].latest).slice(0, 80)) summary.push(`| \`${cell(d)}\` | ${s.files} | ${fmtBytes(s.bytes)} | ${isoLocal(new Date(s.latest))} | ${[...s.types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n}`).join('，')} |`);
summary.push('', '## 禁区（只登记存在，未读）', '', '| 路径 | 处理 |', '|---|---|');
for (const f of forbidden.slice(0, 150)) summary.push(`| \`${cell(f.path)}\` | ${f.kind} |`);
if (forbidden.length > 150) summary.push(`| （共 ${forbidden.length} 处，这里只列前 150 处） | |`);
if (!forbidden.length) summary.push('| （无） | |');
summary.push('', '## 未覆盖', '', uncovered.length ? uncovered.slice(0, 100).map(u => `- \`${cell(u)}\``).join('\n') + (uncovered.length > 100 ? `\n- （共 ${uncovered.length} 处，这里只列前 100 处）` : '') : '（无）', '');
if (changes) summary.push('## 变化（对比 ' + changes.prev + '）', '', `新增 ${changes.added.length}，修改 ${changes.modified.length}，消失 ${changes.gone.length}。`, '', ...changes.added.slice(0, 30).map(p => `- 新增 \`${cell(p)}\``), ...changes.modified.slice(0, 30).map(p => `- 修改 \`${cell(p)}\``), ...changes.gone.slice(0, 30).map(p => `- 消失 \`${cell(p)}\``), '');
summary.push('## 候选事实', '', '（由 DSH 在第一次见面读候选来源后按 `protocols/DISCOVERY.md` 第 6 节填：候选事实、来源、basis、去向。脚本不做这一步。）', '');
const listing = ['# 全扫清单 · ' + dateTag, '', `${rows.length} 条。列：路径、类型、大小、修改时间、用途猜测、归属猜测、处理。`, '', '| 路径 | 类型 | 大小 | 修改时间 | 用途 | 归属 | 处理 |', '|---|---|---|---|---|---|---|'];
for (const r of rows) listing.push(`| \`${cell(r.path)}\` | ${r.type} | ${fmtBytes(r.size)} | ${isoLocal(r.mtime)} | ${r.use} | ${r.owner} | ${r.handle} |`);
const atomic = (p, text) => { const tmp = p + '.tmp-' + process.pid; writeFileSync(tmp, text, 'utf8'); renameSync(tmp, p); };
const outSummary = join(ctxDir, `SCAN-${dateTag}.md`);
const outList = join(ctxDir, `SCAN-${dateTag}-清单.md`);
atomic(outSummary, summary.join('\n') + '\n');
atomic(outList, listing.join('\n') + '\n');

// ---- MANIFEST coverage ----
let manifestUpdated = false;
try {
  const mp = join(workspace, 'MANIFEST.md');
  const text = readFileSync(mp, 'utf8');
  const next = text.replace(/"coverage"\s*:\s*"[a-z_]*"/, `"coverage":"${coverage}"`);
  if (next !== text) { atomic(mp, next); manifestUpdated = true; }
} catch {}

process.stdout.write(JSON.stringify({
  scan: outSummary, listing: outList, roots: roots.length, dirs, files, bytes, elapsed_ms: elapsedMs, stopped, uncovered: uncovered.length,
  blocked: blocked.length, blocked_at: blocked.map(b => `${b.path}（${b.what}：${b.error}）`), denied_dirs: deniedDirs,
  forbidden: forbidden.length, private_dirs: privateDirs, known_entries: known.length, rule_files: ruleFiles.length, course_dirs: uniqueCourseDirs.length,
  calendars: calendars.length, export_packs: [...new Set(exportPacks)].length, coverage, manifest_updated: manifestUpdated,
  changes: changes ? {prev: changes.prev, added: changes.added.length, modified: changes.modified.length, gone: changes.gone.length} : null,
}, null, 2) + '\n');
if (blocked.length) {
  process.stderr.write(`全扫被权限拦住：${blocked.map(b => `${b.what}（${b.error}）`).join('；')}。结果不完整，覆盖状态 blocked。让用户把 Codex 关掉重开一次（安装器已给全盘权限，重开生效）再重扫；不要报"扫完了"。\n`);
  process.exitCode = 2;
}
