// 全扫脚本（protocols/DISCOVERY.md 的程序实现）。由主 agent（入口 Codex）在派工前运行，不用模型；DSH 不扫电脑，只读输出。
// 安装器装完会先跑一次（安装器跑在用户自己的权限下，不在 Codex 沙箱里）；之后由入口在 SCAN 缺失或过期时再跑。
// 用法：node app/scan.mjs [--config connection.local.json] [--max-files 100000] [--max-bytes 2147483648] [--max-seconds 600]
// 输出：<workspace>/connection/context/SCAN-<日期>.md（汇总）与 SCAN-<日期>-清单.md（完整清单）；回写 MANIFEST.md 的 coverage。
// 退出码：0 正常；2 = 根被权限挡住（列不了家目录根、读不了笔记库登记表、根目录进不去或列不出来；macOS 没批桌面/文稿/下载的隐私权限也算）。这时结果不完整：
//   汇总里有「看不见的地方」一节，覆盖状态 blocked，stderr 有一句人话。入口见到就报"被拦住"，不得报"扫完了"（DISCOVERY 第 0 节）。
import {readFileSync, writeFileSync, existsSync, readdirSync, statSync, lstatSync, mkdirSync, renameSync} from 'node:fs';
import {join, resolve, basename, extname, dirname, sep} from 'node:path';
import {homedir, hostname, platform, release} from 'node:os';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const configPath = resolve(opt('--config', join(dirname(fileURLToPath(import.meta.url)), '..', 'connection.local.json'))); // 按脚本自己所在的 skill 目录找配置
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const workspace = resolve(config.workspace);
const MAX_FILES = Number(opt('--max-files', 100000)); // 09-16 Mac 实测 22 个仓库的桌面 20,000 不够（0.7 秒就撞顶）；100,000 约 4 秒
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
const EXCLUDE_DIR = /^(node_modules|\.git|[\w.-]*venv[\w.-]*|\.?env\d*|site-packages|\.tox|\.nox|__pycache__|dist|build|\.cache|cache|caches|\.next|\.nuxt|target|\$recycle\.bin|\.pnpm-store|\.gradle|\.idea|\.vs|\.mypy_cache|\.pytest_cache|coverage|obj|bin|Pods|DerivedData|\.terraform)$/i;
// 名字不像也可能是虚拟环境（Mac 实测 09-16：Desktop/intern/.aivenv 吃光了 20,000 文件预算）：目录里有 pyvenv.cfg 就是 venv，不进。
const isVirtualEnv = (p) => { try { return existsSync(join(p, 'pyvenv.cfg')); } catch { return false; } };
const READ_EXT = new Set(['.md', '.txt', '.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.json', '.ics', '.html', '.htm']);
const LIST_ONLY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp3', '.mp4', '.wav', '.m4a', '.mov', '.mkv', '.zip', '.7z', '.rar', '.tar', '.gz', '.exe', '.msi', '.dll', '.dmg', '.iso', '.bin']);
const BIG_FILE = 50 * 1024 * 1024;

// ---- 禁区（DISCOVERY 5） ----
const FORBIDDEN_FILE = /^(\.env(\..*)?|.*\.(pem|key|kdbx|p12|pfx)|id_rsa.*|id_ed25519.*|.*(credential|credentials|cookie|cookies|token|secret|password|passwd).*)$/i;
const FORBIDDEN_DIR = /^(\.ssh|\.gnupg|\.aws|\.azure|\.config\/gcloud|User Data|Profiles|Login Data|Keychains)$/i;
const PRIVATE_NAME = /(diary|日记|journal|private|私密|健康|health|obsession)/i;
const EXPORT_PACK = /(chatgpt|claude|gemini|conversations|openai).*\.(zip|json)$/i;
const THIRD_PARTY = /(whatsapp|wechat|微信|telegram|tencent files|classlist|名册|roster|群文件|chat[-_ ]?(log|history)|聊天记录)/i;
const COURSE_DIR = /(^[A-Z]{2,4}\s?\d{3}[A-Z]?$)|课件|课程|lecture|week\s?\d|semester|term\s?\d|^(smu|nus|ntu|usyd|unsw|canvas|elearn)$/i;
const RULE_FILE = /^(CLAUDE\.md|AGENTS\.md|\.cursorrules|GEMINI\.md|copilot-instructions\.md)$/i;
// 09-16 第二版规则。规则一变就改这个标记：清单头部记下它，比较两次清单时才分得清"规则变了"和"用户动了"（09-16 消失 660 里 631 条其实是不再列工作区）。
const SCAN_RULES_VERSION = '2026-09-16b';
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.sql', '.css', '.scss', '.less', '.html', '.vue', '.svelte', '.sh', '.ps1']);
const CONFIG_EXT = new Set(['', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.secret', '.key']);
const STRONG_SECRET_WORD = /(^|[^a-z])(credentials?|cookies?|secrets?|passwords?|passwd|私钥|密码)([^a-z]|$)/i;
const TOKEN_WORD = /(^|[^a-z])tokens?([^a-z]|$)/i;
// 禁区判定（DISCOVERY 5）。09-16 实测 54 处"文件名像凭证"里大半是 tokens.ts、approval_tokens.rs、带 token 字样的纪要：源码文件名里的 token / secret 是代码，不是凭证。
const isForbiddenFile = (name) => {
  const ext = extname(name).toLowerCase();
  if (/^(\.env(\..*)?|.*\.(pem|key|kdbx|p12|pfx|ppk)|id_rsa.*|id_ed25519.*|\.netrc|\.npmrc|\.pypirc|.*[-_]key)$/i.test(name)) return true;
  if (CODE_EXT.has(ext)) return false;
  if (STRONG_SECRET_WORD.test(name)) return true;
  return TOKEN_WORD.test(name) && CONFIG_EXT.has(ext); // token 只在配置形态的文件名里才算（api-token、tokens.json），纪要和文档不算
};
const COURSE_EXT = new Set(['.pptx', '.ppt', '.pdf', '.docx', '.doc', '.bpmn', '.ipynb', '.xlsx']);
const NOT_COURSE_PARENT = /^(src|lib|app|pages|components|packages|public|assets|static|test|tests|spec|__tests__|vendor|work|outputs|runs|workspace|cases)$/i;
// 代码或 AI 工作区（按日期命名的目录）里叫 canvas / week1 的目录不是课件（09-16：13 处里 5 处是这种）
const underCodeParent = (p, root) => p.slice(root.length + 1).split(sep).slice(0, -1).some(c => NOT_COURSE_PARENT.test(c) || /^\d{4}-\d{2}-\d{2}$/.test(c));

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
    if (!e.isDirectory() || EXCLUDE_DIR.test(e.name) || e.name.startsWith('.') && e.name !== '.git' || /^(AppData|Application Data|Library)$/i.test(e.name) || isVirtualEnv(join(dir, e.name))) continue; // p 还没定义，别用它
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
try { for (const d of readdirSync(join(HOME, '.claude', 'projects'))) { const m = join(HOME, '.claude', 'projects', d, 'memory'); if (!existsSync(m)) continue; const n = readdirSync(m).filter(f => f.endsWith('.md')).length; if (n) addKnown('AI 工具的记忆', m, 'assistant_summary', `${n} 个文件`); } } catch {}
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
const topOf = (p, root) => { const rel = p.slice(root.length + 1); const i = rel.indexOf(sep); return i < 0 ? join(root, '（根上的零散文件）') : join(root, rel.slice(0, i)); }; // 桌面根上的快捷方式、zip 归成一行，不各占一行
function walk(dir, root, depth, label = '', flags = {third: false, priv: false}) { // flags：祖先目录里有聊天软件 / 私密名字，整棵子树都按只列（09-16：微信缓存深处的文件之前被当成普通文件进了变化统计）
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
      if (EXCLUDE_DIR.test(e.name) || isVirtualEnv(p)) continue;
      if (FORBIDDEN_DIR.test(e.name)) { forbidden.push({path: p, kind: '凭证或浏览器数据目录，未进'}); continue; }
      if (rootSet.has(p.toLowerCase())) continue; // 另一个根（仓库、笔记库），单独走，不在这里重复列
      if (COURSE_DIR.test(e.name) && !underCodeParent(p, root)) courseDirs.push(p);
      if (p.toLowerCase() === workspace.toLowerCase()) continue; // 框架自己不算用户内容
      walk(p, root, depth + 1, '', {third: flags.third || THIRD_PARTY.test(e.name), priv: flags.priv || PRIVATE_NAME.test(e.name)});
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
    if (isForbiddenFile(e.name)) { handle = '禁区未读'; use = '凭证形态'; forbidden.push({path: p, kind: '文件名像凭证，未读'}); }
    else if (EXPORT_PACK.test(e.name)) { handle = '私密，只列'; use = 'AI 对话导出包'; exportPacks.push(p); }
    else if (flags.priv || PRIVATE_NAME.test(e.name) || PRIVATE_NAME.test(basename(dir))) { handle = '私密，只列'; use = '私密'; }
    else if (flags.third || THIRD_PARTY.test(e.name) || THIRD_PARTY.test(basename(dir))) { handle = '第三方，只列'; owner = '他人'; use = '第三方资料'; }
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
for (const r of roots) walk(r.path, r.path, 1, r.label, {third: THIRD_PARTY.test(basename(r.path)), priv: PRIVATE_NAME.test(basename(r.path))});
const elapsedMs = Date.now() - started;

// ---- 课件目录：名字像还不够，里面（3 层内）得真有课件类文件；父目录已算的，Week 1… 子目录不再单列（09-16：13 处里 5 处是代码里叫 canvas 的目录和镜像） ----
const courseCandidates = [...new Set(courseDirs)];
const courseFileCount = new Map();
for (const r of rows) {
  if (!COURSE_EXT.has(extname(r.path).toLowerCase())) continue;
  const low = r.path.toLowerCase();
  for (const d of courseCandidates) { const dl = d.toLowerCase() + sep; if (low.startsWith(dl) && r.path.slice(dl.length).split(sep).length <= 3) courseFileCount.set(d, (courseFileCount.get(d) || 0) + 1); }
}
const courseKept = courseCandidates.filter(d => courseFileCount.get(d)).filter((d, _, all) => !all.some(o => o !== d && courseFileCount.get(o) && d.toLowerCase().startsWith(o.toLowerCase() + sep)));
const courseDropped = courseCandidates.filter(d => !courseKept.includes(d));
for (const r of rows) if (r.use === '课件' && !courseKept.some(d => r.path.toLowerCase().startsWith(d.toLowerCase() + sep))) r.use = repos.some(x => r.path.toLowerCase().startsWith(x.toLowerCase())) ? '代码' : '其他';
// 日历：同一份课表的下载副本（xxx (1).ics）只算一份
const calendarsDedup = [...new Map(calendars.map(p => [basename(p).replace(/ \(\d+\)(?=\.ics$)/i, '').toLowerCase(), p])).values()];

// ---- 与上次比较（DISCOVERY 7） ----
const ctxDir = join(workspace, 'connection', 'context');
mkdirSync(ctxDir, {recursive: true});
let prevList = null;
try {
  const prev = readdirSync(ctxDir).filter(f => /^SCAN-\d{4}-\d{2}-\d{2}-清单\.md$/.test(f) && !f.startsWith(`SCAN-${dateTag}`)).sort().pop();
  if (prev) { prevList = new Map(); const text = readFileSync(join(ctxDir, prev), 'utf8'); for (const line of text.split('\n')) { const m = line.match(/^\| `(.+?)` \| [^|]* \| [^|]* \| ([^|]+) \| [^|]* \| [^|]* \| ([^|]*) \|/); if (m) prevList.set(m[1], {mtime: m[2].trim(), handle: m[3].trim()}); } prevList.name = prev; prevList.rules = (text.match(/^规则版本 (\S+?)。?$/m) || [])[1] || '未标'; }
} catch {}
let changes = null;
// 变化只看内容类文件：聊天软件、私密、禁区这些"只列"的路径天天在动，混进来就看不见用户真正动了什么（09-16：新增 157 里微信占 79）
const LIST_ONLY = (h) => /^(私密|第三方|禁区|只列，不跟随)/.test(h || '');
// 旧路径按现在的规则还在不在范围内：不在的不算"消失"，那是规则变了不是用户删了
const inScopeNow = (p) => { const low = p.toLowerCase(), ws = workspace.toLowerCase(); if (low === ws || low.startsWith(ws + sep)) return false; const root = roots.find(r => low === r.path.toLowerCase() || low.startsWith(r.path.toLowerCase() + sep)); if (!root) return false; const parts = p.slice(root.path.length + 1).split(sep); if (parts.length > 7) return false; return !parts.slice(0, -1).some(c => EXCLUDE_DIR.test(c)); };
if (prevList) {
  const curAll = new Set(rows.map(r => r.path));
  const cur = new Map(rows.filter(r => !LIST_ONLY(r.handle)).map(r => [r.path, isoLocal(r.mtime)]));
  const added = [...cur.keys()].filter(k => !prevList.has(k));
  const modified = [...cur.keys()].filter(k => prevList.has(k) && prevList.get(k).mtime !== cur.get(k));
  // 上次清单里有、这次没有的路径：如果现在处在放了 .dsh-private 标记的目录下，连"消失"也不记，免得泄露路径。
  const underPrivate = (p) => { let d = dirname(p); for (let i = 0; i < 12 && d && d !== dirname(d); i++) { if (existsSync(join(d, '.dsh-private'))) return true; d = dirname(d); } return false; };
  const goneRaw = [...prevList.entries()].filter(([k, v]) => !LIST_ONLY(v.handle) && !curAll.has(k) && !underPrivate(k)).map(([k]) => k);
  const gone = goneRaw.filter(inScopeNow);
  const listOnlyChanged = rows.filter(r => LIST_ONLY(r.handle) && (!prevList.has(r.path) || prevList.get(r.path).mtime !== isoLocal(r.mtime))).length + [...prevList.entries()].filter(([k, v]) => LIST_ONLY(v.handle) && !curAll.has(k)).length;
  changes = {prev: prevList.name, prevRules: prevList.rules, added, modified, gone, outOfScope: goneRaw.length - gone.length, listOnlyChanged};
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
const uniqueCourseDirs = courseKept;
for (const p of uniqueCourseDirs.slice(0, 100)) summary.push(`| 本地课件目录 | \`${cell(p)}\` | \`inferred_from_behavior\` | 课件类文件 ${courseFileCount.get(p)} 个，子目录一并算；课程名、周次、清单；谈话里确认后升级 |`);
{ const n = capNote(uniqueCourseDirs.length, 100, '本地课件目录'); if (n) summary.push(n); }
if (courseDropped.length) summary.push(`| （名字像课件但里面没有课件类文件、或在代码和 AI 工作区里，不算：${courseDropped.length} 处，例如 ${courseDropped.slice(0, 3).map(p => '`' + cell(p) + '`').join('、')}） | | | |`);
for (const p of calendarsDedup.slice(0, 20)) summary.push(`| 日历 | \`${cell(p)}\` | \`inferred_from_behavior\` | 课表、截止；谈话里确认 |`);
for (const p of [...new Set(exportPacks)].slice(0, 20)) summary.push(`| AI 对话导出包 | \`${cell(p)}\` | 私密 | 只列；用户允许后才抽用户自己发的消息 |`);
summary.push('', '## 按目录', '', '| 目录 | 文件 | 大小 | 最近修改 | 主要类型 |', '|---|---|---|---|---|');
for (const [d, s] of [...dirStats.entries()].sort((a, b) => b[1].latest - a[1].latest).slice(0, 80)) summary.push(`| \`${cell(d)}\` | ${s.files} | ${fmtBytes(s.bytes)} | ${isoLocal(new Date(s.latest))} | ${[...s.types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n}`).join('，')} |`);
summary.push('', '## 禁区（只登记存在，未读）', '', '| 路径 | 处理 |', '|---|---|');
for (const f of forbidden.slice(0, 150)) summary.push(`| \`${cell(f.path)}\` | ${f.kind} |`);
if (forbidden.length > 150) summary.push(`| （共 ${forbidden.length} 处，这里只列前 150 处） | |`);
if (!forbidden.length) summary.push('| （无） | |');
// 未覆盖：同一个祖父目录下 3 处以上折成一行（09-16：1339 处几乎全是游戏存档备份超过 6 层）
const collapseUncovered = (list) => { const by = new Map(); for (const u of list) { const base = u.replace(/（[^）]*）$/, ''); const key = dirname(dirname(base)); const a = by.get(key) || []; a.push(u); by.set(key, a); } const out = []; for (const [k, arr] of by) { if (arr.length >= 3) out.push(`\`${cell(k)}\` 下 ${arr.length} 处${(arr[0].match(/（[^）]*）$/) || [''])[0]}`); else out.push(...arr.map(u => `\`${cell(u)}\``)); } return out; };
const uncoveredLines = collapseUncovered(uncovered);
summary.push('', '## 未覆盖', '', uncovered.length ? `${uncovered.length} 处，折成 ${uncoveredLines.length} 行。\n\n` + uncoveredLines.slice(0, 100).map(l => `- ${l}`).join('\n') + (uncoveredLines.length > 100 ? `\n- （共 ${uncoveredLines.length} 行，这里只列前 100 行）` : '') : '（无）', '');
if (changes) summary.push('## 变化（对比 ' + changes.prev + '）', '', `新增 ${changes.added.length}，修改 ${changes.modified.length}，消失 ${changes.gone.length}。只看内容类文件；聊天软件、私密、禁区这些只列的路径另有变化 ${changes.listOnlyChanged} 处，不列。` + (changes.prevRules !== SCAN_RULES_VERSION ? `上次清单的规则版本是 ${changes.prevRules}，这次是 ${SCAN_RULES_VERSION}：按现在的规则不在范围内的 ${changes.outOfScope} 条旧路径不算消失，那是规则变了，不是用户删了。` : (changes.outOfScope ? `另有 ${changes.outOfScope} 条旧路径按现在的规则不在范围内，不算消失。` : '')), '', ...changes.added.slice(0, 30).map(p => `- 新增 \`${cell(p)}\``), ...changes.modified.slice(0, 30).map(p => `- 修改 \`${cell(p)}\``), ...changes.gone.slice(0, 30).map(p => `- 消失 \`${cell(p)}\``), '');
summary.push('## 候选事实', '', '（由 DSH 在第一次见面读候选来源后按 `protocols/DISCOVERY.md` 第 6 节填：候选事实、来源、basis、去向。脚本不做这一步。）', '');
const listing = ['# 全扫清单 · ' + dateTag, '', `${rows.length} 条。列：路径、类型、大小、修改时间、用途猜测、归属猜测、处理。`, '', `规则版本 ${SCAN_RULES_VERSION}。`, '', '| 路径 | 类型 | 大小 | 修改时间 | 用途 | 归属 | 处理 |', '|---|---|---|---|---|---|---|'];
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
  forbidden: forbidden.length, private_dirs: privateDirs, known_entries: known.length, rule_files: ruleFiles.length, course_dirs: uniqueCourseDirs.length, course_dirs_dropped: courseDropped.length,
  calendars: calendarsDedup.length, rules_version: SCAN_RULES_VERSION, export_packs: [...new Set(exportPacks)].length, coverage, manifest_updated: manifestUpdated,
  changes: changes ? {prev: changes.prev, prev_rules: changes.prevRules, added: changes.added.length, modified: changes.modified.length, gone: changes.gone.length, out_of_scope: changes.outOfScope, list_only_changed: changes.listOnlyChanged} : null,
}, null, 2) + '\n');
if (blocked.length) {
  process.stderr.write(`全扫被权限拦住：${blocked.map(b => `${b.what}（${b.error}）`).join('；')}。结果不完整，覆盖状态 blocked。让用户把 Codex 关掉重开一次（安装器已给全盘权限，重开生效）再重扫；不要报"扫完了"。\n`);
  process.exitCode = 2;
}
