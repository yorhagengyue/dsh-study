// 第二步·理解人 的机器活（protocols/UNDERSTANDING.md 第 2 节的程序实现）：
// 把用户自己说过的话从这台机器上所有 AI 对话存储里抽出来，按时间排成原话时间线，切成给读者的分段。
// 只抽用户角色的文本；去掉注入的指令、工具回显、子代理会话里 AI 写的"用户"消息；凭证形态的串打码；去重。
// 用法：node app/history.mjs [--config <connection.local.json>] [--out <dir>] [--since YYYY-MM-DD] [--include <dir>]... [--chunk-chars 70000] [--cap 3000]
// 产物（默认 <workspace>/UNDERSTANDING/raw/，永不回传）：SOURCES.md、timeline.jsonl、chunks/NN-<起>_to_<止>.md、stats.json
// 退出码：0 正常；2 = 一个来源都读不到（全部看不见），结果不算数。
import {readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync} from 'node:fs';
import {join, resolve, basename, dirname} from 'node:path';
import {homedir, platform} from 'node:os';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const multi = (name) => args.flatMap((a, i) => a === name && args[i + 1] ? [args[i + 1]] : []);
const HOME = homedir();
const configPath = resolve(opt('--config', join(HOME, '.codex', 'skills', 'dsh-dialogue', 'connection.local.json')));
let workspace = null;
try { workspace = resolve(JSON.parse(readFileSync(configPath, 'utf8')).workspace); } catch {}
const OUT = resolve(opt('--out', workspace ? join(workspace, 'UNDERSTANDING', 'raw') : join(HOME, 'UNDERSTANDING-raw')));
const SINCE = opt('--since', null);
const CHUNK = Number(opt('--chunk-chars', 70000));
const CAP = Number(opt('--cap', 3000));
const INCLUDE = multi('--include');
mkdirSync(join(OUT, 'chunks'), {recursive: true});
mkdirSync(join(OUT, 'notes'), {recursive: true});

const INJECTED_PREFIX = ['<', '# AGENTS.md', '# AGENTS', 'Instructions from', '[Request interrupted', 'Caveat:', 'This session is being continued', 'You are Claude', 'You are Codex', 'Read PROMPT.md in the current directory'];
const INJECTED_ANY = ['<system-reminder>', '<command-name>', '<local-command-stdout>', '<task-notification>', '<environment_context>', '<recommended_plugins>', '<user_instructions>', '<permissions instructions>', '<turn_aborted>', '<ide_opened_file>', '<ci-monitor-event>'];
const MACHINE_PREFIX = ['Recent actions:', 'owner 指令：继续任务'];
const REDACT = [
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer [REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]'],
  [/(api[_-]?key|token|secret|password)\s*[=:]\s*['"]?[A-Za-z0-9._-]{16,}/gi, '$1=[REDACTED]'],
];
const clean = (text) => {
  if (typeof text !== 'string') return '';
  let t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t) return '';
  if (INJECTED_PREFIX.some(p => t.startsWith(p))) return '';
  if (MACHINE_PREFIX.some(p => t.startsWith(p))) return '';
  const head = t.slice(0, 200);
  if (INJECTED_ANY.some(k => head.includes(k))) return '';
  for (const [rx, rep] of REDACT) t = t.replace(rx, rep);
  return t;
};
const iso = (v) => {
  if (v == null) return '';
  if (typeof v === 'number') return new Date(v > 1e11 ? v : v * 1000).toISOString().slice(0, 19);
  return String(v).slice(0, 19).replace('Z', '');
};
const errCode = (e) => (e && e.code) ? String(e.code) : String(e && e.message ? e.message : e).slice(0, 60);
const listSafe = (dir) => { try { return readdirSync(dir, {withFileTypes: true}); } catch (e) { throw e; } };
const walkFiles = (dir, pred, depth = 0, maxDepth = 6, out = []) => {
  let ents; try { ents = readdirSync(dir, {withFileTypes: true}); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth && e.name !== 'node_modules' && e.name !== 'subagents') walkFiles(p, pred, depth + 1, maxDepth, out); }
    else if (pred(e.name)) out.push(p);
  }
  return out;
};

const rows = [];
const sources = []; // {name, status: 'read'|'absent'|'blocked', files, msgs, note}
const stats = {};
const add = (r) => { if (SINCE && r.ts && r.ts.slice(0, 10) < SINCE) return; rows.push(r); };

// ---------------- Codex ----------------
{
  const titles = {};
  const statePath = join(HOME, '.codex', 'state_5.sqlite');
  if (existsSync(statePath)) {
    try {
      const {DatabaseSync} = await import('node:sqlite');
      const db = new DatabaseSync(statePath, {readOnly: true});
      for (const r of db.prepare('select id, title, cwd from threads').all()) titles[r.id] = {title: r.title || '', cwd: r.cwd || ''};
      db.close();
    } catch (e) { sources.push({name: 'Codex 线程标题（state_5.sqlite）', status: 'blocked', files: 0, msgs: 0, note: errCode(e)}); }
  }
  const dirs = [[join(HOME, '.codex', 'sessions'), true], [join(HOME, '.codex', 'archived_sessions'), false]];
  let files = 0, msgs = 0, skippedSub = 0, seen = new Set(), anyDir = false;
  for (const [dir, recursive] of dirs) {
    if (!existsSync(dir)) continue;
    anyDir = true;
    let list;
    try { list = recursive ? walkFiles(dir, n => /^rollout-.*\.jsonl$/.test(n)) : readdirSync(dir).filter(n => /^rollout-.*\.jsonl$/.test(n)).map(n => join(dir, n)); }
    catch (e) { sources.push({name: `Codex 会话目录 ${dir}`, status: 'blocked', files: 0, msgs: 0, note: errCode(e)}); continue; }
    for (const f of list.sort()) {
      const base = basename(f); if (seen.has(base)) continue; seen.add(base);
      let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
      let sessId = null, cwd = '', isSub = false, last = null; const got = [];
      for (const line of text.split('\n')) {
        if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
        const t = o.type, p = (o.payload && typeof o.payload === 'object') ? o.payload : {};
        if (t === 'session_meta') { sessId = p.id || o.id; cwd = p.cwd || ''; if (p.source && typeof p.source === 'object') isSub = true; }
        // Main conversations that spawned children also carry inter_agent_communication_metadata; only session_meta.source (an object) marks a spawned session. Found by Codex on the owner's Mac, 2026-09-16.
        else if (t === 'response_item' && p.type === 'message' && p.role === 'user') {
          for (const c of p.content || []) if (c && (c.type === 'input_text' || c.type === 'text')) { const x = clean(c.text); if (x && x !== last) { got.push([o.timestamp, x]); last = x; } }
        } else if (t === 'event_msg' && p.type === 'user_message') { const x = clean(p.message); if (x && x !== last) { got.push([o.timestamp, x]); last = x; } }
      }
      if (isSub) { skippedSub++; continue; }
      const meta = titles[sessId] || {};
      const project = meta.title || basename(cwd || meta.cwd || '') || '?';
      for (const [ts, x] of got) add({ts: iso(ts), source: 'codex', project, session: String(sessId || base).slice(0, 36), text: x});
      files++; msgs += got.length;
    }
  }
  sources.push({name: 'Codex 会话（sessions + archived_sessions）', status: anyDir ? 'read' : 'absent', files, msgs, note: anyDir ? `子代理会话跳过 ${skippedSub} 个` : '目录不存在'});
}

// ---------------- Claude Code ----------------
{
  const root = join(HOME, '.claude', 'projects');
  if (!existsSync(root)) sources.push({name: 'Claude Code 会话', status: 'absent', files: 0, msgs: 0, note: '目录不存在'});
  else {
    let files = 0, msgs = 0, blocked = null;
    let projs = []; try { projs = readdirSync(root); } catch (e) { blocked = errCode(e); }
    for (const proj of projs.sort()) {
      const pdir = join(root, proj); let list = [];
      try { if (!statSync(pdir).isDirectory()) continue; list = readdirSync(pdir).filter(n => n.endsWith('.jsonl')).map(n => join(pdir, n)); } catch { continue; }
      for (const f of list.sort()) {
        let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
        let n = 0, last = null;
        for (const line of text.split('\n')) {
          if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.type !== 'user' || o.isSidechain || o.isMeta) continue;
          if (o.userType && o.userType !== 'external') continue;
          const c = o.message && o.message.content;
          const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text || '') : [];
          const x = clean(parts.join('\n')); if (!x || x === last) continue; last = x;
          add({ts: iso(o.timestamp), source: 'claude', project: proj, session: basename(f).slice(0, 8), text: x}); n++;
        }
        if (n) { files++; msgs += n; }
      }
    }
    sources.push({name: 'Claude Code 会话（~/.claude/projects）', status: blocked ? 'blocked' : 'read', files, msgs, note: blocked || ''});
  }
}

// ---------------- 本系统自己的轮次 ----------------
if (workspace) {
  const runs = join(workspace, 'connection', 'runs');
  if (!existsSync(runs)) sources.push({name: '本系统轮次（connection/runs）', status: 'absent', files: 0, msgs: 0, note: ''});
  else {
    let files = 0, msgs = 0;
    for (const d of readdirSync(runs).sort()) {
      const input = join(runs, d, 'INPUT.md'); if (!existsSync(input)) continue;
      let text; try { text = readFileSync(input, 'utf8'); } catch { continue; }
      const m = text.match(/^## 用户原话\s*\n([\s\S]*?)(?=\n## |\n<!-- dsh-state -->|$)/m);
      const x = m ? clean(m[1]) : '';
      let ts = ''; try { const st = readFileSync(join(runs, d, 'STATUS.md'), 'utf8'); const r = st.match(/"received_ms"\s*:\s*(\d+)/); ts = r ? iso(Number(r[1])) : ''; } catch {}
      if (!ts) { try { ts = iso(statSync(input).mtimeMs); } catch {} }
      if (x) { add({ts, source: 'study', project: 'connection/runs', session: d.slice(0, 40), text: x}); msgs++; }
      files++;
    }
    sources.push({name: '本系统轮次（connection/runs/*/INPUT.md 用户原话）', status: 'read', files, msgs, note: ''});
  }
}

// ---------------- ChatGPT 导出包 ----------------
{
  const dl = join(HOME, 'Downloads');
  let found = [];
  try { found = walkFiles(dl, n => n === 'conversations.json', 0, 3); } catch (e) { sources.push({name: 'ChatGPT 导出包', status: 'blocked', files: 0, msgs: 0, note: errCode(e)}); }
  if (!found.length) sources.push({name: 'ChatGPT 导出包（~/Downloads/**/conversations.json）', status: 'absent', files: 0, msgs: 0, note: '没找到导出文件；用户可从 ChatGPT 设置导出后放进下载目录'});
  let msgs = 0;
  for (const f of found) {
    try {
      const convs = JSON.parse(readFileSync(f, 'utf8'));
      for (const conv of Array.isArray(convs) ? convs : []) {
        const nodes = Object.values(conv.mapping || {});
        for (const node of nodes) {
          const mmsg = node && node.message; if (!mmsg || !mmsg.author || mmsg.author.role !== 'user') continue;
          const parts = (mmsg.content && Array.isArray(mmsg.content.parts)) ? mmsg.content.parts.filter(p => typeof p === 'string') : [];
          const x = clean(parts.join('\n')); if (!x) continue;
          add({ts: iso(mmsg.create_time || conv.create_time), source: 'chatgpt', project: conv.title || '?', session: String(conv.id || '').slice(0, 36), text: x}); msgs++;
        }
      }
    } catch (e) { sources.push({name: `ChatGPT 导出包 ${f}`, status: 'blocked', files: 1, msgs: 0, note: errCode(e)}); }
  }
  if (found.length) sources.push({name: 'ChatGPT 导出包', status: 'read', files: found.length, msgs, note: found.join('；')});
}

// ---------------- 用户点名的目录 ----------------
for (const dir of INCLUDE) {
  const d = resolve(dir);
  if (!existsSync(d)) { sources.push({name: `点名目录 ${d}`, status: 'absent', files: 0, msgs: 0, note: '不存在'}); continue; }
  let files = 0;
  for (const f of walkFiles(d, n => n.endsWith('.md') || n.endsWith('.txt'))) {
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const x = clean(text); if (!x) continue;
    const m = basename(f).match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);
    let ts = m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00` : ''; if (!ts) { try { ts = iso(statSync(f).mtimeMs); } catch {} }
    add({ts, source: 'notes', project: basename(d), session: basename(f).slice(0, 40), text: x}); files++;
  }
  sources.push({name: `点名目录 ${d}`, status: 'read', files, msgs: files, note: '整篇作一条'});
}

// ---------------- 去重、排序、分段、落盘 ----------------
rows.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
const seenKey = new Set(); const kept = []; let dup = 0;
for (const r of rows) { const k = (r.ts || '').slice(0, 16) + '|' + r.text.slice(0, 200); if (seenKey.has(k)) { dup++; continue; } seenKey.add(k); kept.push(r); }
writeFileSync(join(OUT, 'timeline.jsonl'), kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
const fmt = (r) => { let t = r.text; if (t.length > CAP) t = t.slice(0, CAP) + `\n[…后面 ${(t.length - CAP).toLocaleString()} 字剪掉了，看起来是整段粘贴进来的材料；只需知道他当时把这样的东西交给了 AI]`; return `## [${(r.ts || '????').slice(0, 16).replace('T', ' ')} | ${r.source} | ${String(r.project).slice(0, 40)}]\n${t}\n\n`; };
const chunks = []; let cur = [], curLen = 0;
for (const r of kept) { const s = fmt(r); if (cur.length && curLen + s.length > CHUNK) { chunks.push(cur); cur = []; curLen = 0; } cur.push([r, s]); curLen += s.length; }
if (cur.length) chunks.push(cur);
const manifest = [];
chunks.forEach((ch, i) => {
  const a = (ch[0][0].ts || '').slice(0, 10) || 'unknown', b = (ch[ch.length - 1][0].ts || '').slice(0, 10) || 'unknown';
  const name = `${String(i + 1).padStart(2, '0')}-${a}_to_${b}.md`;
  const head = `# 用户原话 · 第 ${i + 1} 段 · ${a} → ${b}（${ch.length} 条）\n\n只有用户自己说的话，按时间顺序；AI 的回复和工具输出都不在这里。时间戳是记录里的原值（多为 UTC）。\n\n`;
  writeFileSync(join(OUT, 'chunks', name), head + ch.map(x => x[1]).join(''), 'utf8');
  manifest.push({file: `chunks/${name}`, from: a, to: b, msgs: ch.length, notes: `notes/${String(i + 1).padStart(2, '0')}.md`});
});
const byMonth = {};
for (const r of kept) { const m = (r.ts || '').slice(0, 7) || 'unknown'; byMonth[m] ??= {msgs: 0, chars: 0}; byMonth[m].msgs++; byMonth[m].chars += r.text.length; }
const totalChars = kept.reduce((n, r) => n + r.text.length, 0);
const bySource = {}; for (const r of kept) bySource[r.source] = (bySource[r.source] || 0) + 1;
Object.assign(stats, {generated_at: new Date().toISOString(), since: SINCE, total_msgs: kept.length, total_chars: totalChars, dup_dropped: dup, by_source: bySource, by_month: byMonth, chunks: manifest, sources});
writeFileSync(join(OUT, 'stats.json'), JSON.stringify(stats, null, 1), 'utf8');
const blocked = sources.filter(s => s.status === 'blocked');
const readOk = sources.filter(s => s.status === 'read' && s.msgs > 0);
const lines = [`# 语料来源 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '', `由 \`history.mjs\` 生成。只列来源和数量，不复制原话。原话时间线在 \`timeline.jsonl\`，读者分段在 \`chunks/\`。**这个目录永不回传。**`, '', '| 来源 | 状态 | 文件 | 用户原话条数 | 备注 |', '|---|---|---|---|---|'];
for (const s of sources) lines.push(`| ${s.name} | ${s.status === 'read' ? '已读' : s.status === 'absent' ? '不存在' : '**看不见**'} | ${s.files} | ${s.msgs} | ${(s.note || '').replace(/\|/g, '/')} |`);
lines.push('', `合计 ${kept.length} 条、${totalChars.toLocaleString()} 字（去重丢弃 ${dup} 条）；按月：${Object.entries(byMonth).map(([m, v]) => `${m} ${v.msgs} 条`).join('，')}。`, '');
if (blocked.length) lines.push('> **⚠ 有来源看不见（没权限或读不了）。** 上面标"看不见"的行要照实告诉用户，不能当作不存在；主 agent 的沙箱没放开全盘时会这样，重开 Codex 后再抽一次。', '');
if (kept.length < 200) lines.push(`> **冷启动：原话只有 ${kept.length} 条（不足 200），不合理解稿。** 按 \`protocols/CONVERSATION.md\` 先谈，本系统自己的轮次会成为新的语料。`, '');
lines.push('## 分段', '', ...manifest.map(m => `- \`${m.file}\`：${m.from} → ${m.to}，${m.msgs} 条 → 笔记 \`${m.notes}\``), '');
writeFileSync(join(OUT, 'SOURCES.md'), lines.join('\n'), 'utf8');
process.stdout.write(JSON.stringify({out: OUT, sources: join(OUT, 'SOURCES.md'), msgs: kept.length, chars: totalChars, chunks: manifest.length, blocked: blocked.length, cold_start: kept.length < 200, by_source: bySource}, null, 2) + '\n');
if (!readOk.length) { process.stderr.write('一个来源都没读到；看 SOURCES.md 的"看不见"。\n'); process.exitCode = 2; }
