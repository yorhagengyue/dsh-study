// 框架状态：读各视图的 dsh-state 块与槽位内容，算出 MANIFEST.md 的 stage，并回写。
import {readFileSync, existsSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {randomBytes} from 'node:crypto';

const STATE_RE = /<!--\s*dsh-state\s*-->\s*```json\s*\r?\n([\s\S]*?)\r?\n```\s*<!--\s*\/dsh-state\s*-->/;

export const DEFAULT_REQUIRED_SLOTS = [
  {file: 'USER/identity.md', slot: '称呼'},
  {file: 'USER/identity.md', slot: '语言'},
  {file: 'USER/learning.md', slot: '学校与学期'},
];

export function atomicWrite(path, text) {
  mkdirSync(dirname(path), {recursive: true});
  const tmp = path + '.tmp-' + process.pid + '-' + Date.now();
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

export function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').replace(/^﻿/, '') : '';
}

export function readState(path) {
  const m = readText(path).match(STATE_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export function replaceState(text, state) {
  const block = '<!-- dsh-state -->\n```json\n' + JSON.stringify(state) + '\n```\n<!-- /dsh-state -->';
  return STATE_RE.test(text) ? text.replace(STATE_RE, block) : text.trimEnd() + '\n\n' + block + '\n';
}

/** 按二级标题切分 Markdown，返回 [{title, body}]。 */
export function sectionsOf(markdown) {
  const out = [];
  let cur = null;
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^##\s+(.*?)\s*$/);
    if (m) { cur = {title: m[1], lines: []}; out.push(cur); }
    else if (cur) cur.lines.push(line);
  }
  return out.map(s => ({title: s.title, body: s.lines.join('\n').trim()}));
}

/** 槽位是否已填：正文里还有单独一行"（空）"就算空；没有任何内容也算空。 */
export function slotFilled(body) {
  const lines = String(body ?? '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.length) return false;
  return !lines.some(l => l === '（空）' || l === '(空)');
}

export function findSection(markdown, slot) {
  return sectionsOf(markdown).find(s => s.title === slot || s.title.startsWith(slot + '（') || s.title.startsWith(slot + '('));
}

/** 解析 Markdown 表格，返回 {header, rows}，空行（所有单元格为空）跳过。 */
export function parseTables(markdown) {
  const tables = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim().startsWith('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const header = splitRow(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        const cells = splitRow(lines[j]);
        if (cells.some(c => c)) rows.push(cells);
        j++;
      }
      tables.push({header, rows, line: i});
      i = j;
    }
  }
  return tables;
}

function splitRow(row) {
  let t = row.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(c => c.trim());
}

function countStatus(markdown, column, value) {
  let n = 0;
  for (const t of parseTables(markdown)) {
    const idx = t.header.indexOf(column);
    if (idx < 0) continue;
    for (const r of t.rows) if ((r[idx] ?? '') === value) n++;
  }
  return n;
}

function listRuns(workspace, sinceMs) {
  const dir = join(workspace, 'connection', 'runs');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (sinceMs && st.mtimeMs < sinceMs && st.birthtimeMs < sinceMs) continue;
    const input = readText(join(p, 'INPUT.md'));
    const status = readText(join(p, 'STATUS.md'));
    out.push({
      id: name,
      mtimeMs: st.mtimeMs,
      talk: /(^|\n)\s*mode\s*[:=]\s*talk\b/m.test(input),
      completed: /completed/.test(status),
    });
  }
  return out;
}

/**
 * 算框架状态。返回 {stage, ...} 与要回写 MANIFEST 的 manifest 对象。
 * stage 判定见 MANIFEST.md 的表：first_run / filling / complete。
 */
export function computeState({workspace, requiredSlots = DEFAULT_REQUIRED_SLOTS, now = new Date()}) {
  const manifestPath = join(workspace, 'MANIFEST.md');
  const manifest = readState(manifestPath) ?? {};
  // 还没有 created_at（框架第一次落地）时，旧记录一律不计；created_at 由 writeManifest 首次写入。
  const createdAt = manifest.created_at ? Date.parse(manifest.created_at) : now.getTime();
  const files = {};
  const filled = [];
  const empty = [];
  for (const {file, slot} of requiredSlots) {
    files[file] ??= readText(join(workspace, file));
    const sec = findSection(files[file], slot);
    const key = file.replace(/^USER\//, '').replace(/\.md$/, '') + '.' + slot;
    (sec && slotFilled(sec.body) ? filled : empty).push(key);
  }
  const drawer = readText(join(workspace, 'DRAWER.md'));
  const facts = readText(join(workspace, 'USER', 'facts.md'));
  const machine = readState(join(workspace, 'MACHINE.md'));
  const runs = listRuns(workspace, createdAt);
  const talkRuns = runs.filter(r => r.talk);
  const firstMeetingDone = manifest.first_meeting_done === true || talkRuns.some(r => r.completed);
  const machineFilled = !!machine && machine.status && machine.status !== 'empty';
  const healthChecked = !!manifest.health?.checked_at;
  const profileId = manifest.profile_id;
  const userVersion = Number(manifest.user_version ?? 0);

  // first_run 只能由"第一次见面做过"退出：MANIFEST 标记、完成的谈话轮、或任一必填槽已填。
  // 任务轮不算：入口 Agent 不懂框架时派来的任务推不动档位（09-13 实测教训）。
  let stage;
  if (!profileId || (!firstMeetingDone && talkRuns.length === 0 && filled.length === 0)) stage = 'first_run';
  else if (empty.length === 0 && firstMeetingDone && machineFilled && healthChecked) stage = 'complete';
  else stage = 'filling';

  const state = {
    stage,
    profile_id: profileId ?? null,
    user_version: userVersion,
    first_meeting_done: firstMeetingDone,
    required_slots: {filled: filled.length, total: requiredSlots.length, empty},
    filled_slots: filled,
    runs: runs.length,
    talk_runs: talkRuns.length,
    last_talk_at: talkRuns.length ? new Date(Math.max(...talkRuns.map(r => r.mtimeMs))).toISOString() : null,
    drawer_open: countStatus(drawer, '状态', 'open'),
    stale: (facts.match(/"status"\s*:\s*"stale"/g) ?? []).length,
    conflicted: (facts.match(/"conflicted"\s*:\s*true/g) ?? []).length,
    machine_filled: machineFilled,
    health_checked: healthChecked,
    computed_at: now.toISOString(),
  };
  return {state, manifest, manifestPath};
}

/** 把算出的状态回写 MANIFEST.md 的状态块；只有内容变化时才写，返回是否写了。 */
export function writeManifest({workspace, state, manifest, manifestPath, machineId, workspaceLabel, now = new Date()}) {
  const next = {...manifest};
  if (!next.profile_id) next.profile_id = 'profile-' + randomBytes(6).toString('hex');
  if (!next.created_at) next.created_at = now.toISOString();
  next.stage = state.stage;
  next.user_version = state.user_version;
  next.first_meeting_done = state.first_meeting_done;
  next.required_slots = state.required_slots;
  next.runs = state.runs;
  next.last_talk_at = state.last_talk_at;
  next.drawer_open = state.drawer_open;
  next.stale = state.stale;
  next.conflicted = state.conflicted;
  if (machineId && !next.machine_id) next.machine_id = machineId;
  if (workspaceLabel && !next.workspace) next.workspace = workspaceLabel;
  const prevCmp = JSON.stringify({...manifest, updated_at: null});
  const nextCmp = JSON.stringify({...next, updated_at: null});
  if (prevCmp === nextCmp && manifest.updated_at) return {written: false, manifest: next};
  next.updated_at = now.toISOString();
  const text = readText(manifestPath) || '# 实例清单\n';
  atomicWrite(manifestPath, replaceState(text, next));
  return {written: true, manifest: next};
}
