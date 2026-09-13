import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, cpSync, writeFileSync, readFileSync, mkdirSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir, homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {computeState, writeManifest, readState, replaceState, slotFilled, sectionsOf, parseTables} from '../state.mjs';
import {renderOpening} from '../render.mjs';
import {FrameworkEngine} from '../engine.mjs';
import {openCommand, isLoopbackUrl, redactToken} from '../open.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = process.env.DSH_STUDY_WORKSPACE || join(homedir(), 'Desktop', 'DSH-Study');
const PKG_FILES = ['FRAMEWORK.md', 'MANIFEST.md', 'PROJECT.md', 'DRAWER.md', 'MEMORY.md', 'MACHINE.md', 'README.md', 'USER/identity.md', 'USER/learning.md', 'USER/style.md', 'USER/sources.md', 'USER/facts.md'];

function freshWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'dsh-fw-'));
  for (const f of PKG_FILES) {
    const src = join(SOURCE, f);
    if (!existsSync(src)) continue;
    mkdirSync(dirname(join(ws, f)), {recursive: true});
    cpSync(src, join(ws, f));
  }
  mkdirSync(join(ws, 'connection', 'runs'), {recursive: true});
  mkdirSync(join(ws, 'connection', 'templates'), {recursive: true});
  cpSync(join(here, '..', 'templates', 'opening.md'), join(ws, 'connection', 'templates', 'opening.md'));
  // 桌面上的 MANIFEST 可能已被插件填过；测试从装机态开始。
  const mp = join(ws, 'MANIFEST.md');
  const st = readState(mp) ?? {};
  Object.assign(st, {stage: 'first_run', profile_id: null, user_version: 0, machine_id: null, workspace: null, first_meeting_done: false, runs: 0, last_talk_at: null, created_at: null, updated_at: null, health: {service: 'not_verified', context: 'unavailable', framework: 'empty', conversation: null, checked_at: null}});
  writeFileSync(mp, replaceState(readFileSync(mp, 'utf8'), st), 'utf8');
  return ws;
}

function fillSlot(ws, file, slot, content) {
  const p = join(ws, file);
  const text = readFileSync(p, 'utf8');
  const re = new RegExp('(##\\s+' + slot + '[^\\n]*\\n)([\\s\\S]*?)(?=\\n##\\s|$)');
  assert.match(text, re, `slot ${slot} in ${file}`);
  writeFileSync(p, text.replace(re, (_m, head, body) => head + body.replace('（空）', content)), 'utf8');
}

test('helpers: slotFilled / sectionsOf / parseTables', () => {
  assert.equal(slotFilled('说明文字\n\n（空）'), false);
  assert.equal(slotFilled(''), false);
  assert.equal(slotFilled('说明\n\n耿越'), true);
  const secs = sectionsOf('# t\n\n## 称呼（必填）\n\n（空）\n\n## 语言\n\nzh');
  assert.equal(secs.length, 2);
  const t = parseTables('| id | 状态 |\n|---|---|\n| | |\n| p-1 | open |\n');
  assert.equal(t[0].rows.length, 1);
});

test('first_run on a fresh workspace; manifest gets profile and created_at', () => {
  const ws = freshWorkspace();
  const {state, manifest, manifestPath} = computeState({workspace: ws});
  assert.equal(state.stage, 'first_run');
  assert.equal(state.required_slots.filled, 0);
  assert.equal(state.required_slots.empty.length, 3);
  const w = writeManifest({workspace: ws, state, manifest, manifestPath, machineId: 'test'});
  assert.equal(w.written, true);
  const after = readState(manifestPath);
  assert.match(after.profile_id, /^profile-[0-9a-f]{12}$/);
  assert.ok(after.created_at);
  assert.equal(after.stage, 'first_run');
  // 第二次无变化不写
  const again = computeState({workspace: ws});
  const w2 = writeManifest({workspace: ws, state: again.state, manifest: again.manifest, manifestPath, machineId: 'test'});
  assert.equal(w2.written, false);
});

test('filling after a talk run; complete when required slots, meeting, machine, health are all set', () => {
  const ws = freshWorkspace();
  let s = computeState({workspace: ws});
  writeManifest({workspace: ws, state: s.state, manifest: s.manifest, manifestPath: s.manifestPath});
  // 一轮谈话（框架时代的 run：INPUT 含 mode = talk，STATUS completed）
  const run = join(ws, 'connection', 'runs', 'talk-1');
  mkdirSync(run, {recursive: true});
  writeFileSync(join(run, 'INPUT.md'), '---\nmode: talk\n---\n用户原话', 'utf8');
  writeFileSync(join(run, 'STATUS.md'), 'completed', 'utf8');
  s = computeState({workspace: ws});
  assert.equal(s.state.stage, 'filling');
  assert.equal(s.state.first_meeting_done, true);
  assert.equal(s.state.runs, 1);
  fillSlot(ws, 'USER/identity.md', '称呼', '小明');
  fillSlot(ws, 'USER/identity.md', '语言', '简体中文');
  fillSlot(ws, 'USER/learning.md', '学校与学期', '某大学，2026 秋季学期');
  s = computeState({workspace: ws});
  assert.equal(s.state.required_slots.filled, 3);
  assert.equal(s.state.stage, 'filling', 'machine and health still missing');
  // 机器与健康
  const mp = join(ws, 'MACHINE.md');
  writeFileSync(mp, readFileSync(mp, 'utf8').replace('"status": "empty"', '"status": "filled"'), 'utf8');
  const st = readState(s.manifestPath);
  st.health = {...st.health, checked_at: new Date().toISOString()};
  writeManifest({workspace: ws, state: s.state, manifest: st, manifestPath: s.manifestPath});
  s = computeState({workspace: ws});
  assert.equal(s.state.stage, 'complete');
});

test('render fills variables, keeps constitution, strips draft note, respects budget', () => {
  const ws = freshWorkspace();
  const {state} = computeState({workspace: ws});
  const template = readFileSync(join(ws, 'connection', 'templates', 'opening.md'), 'utf8');
  const vars = {userName: '小明', machine: 'TestOS', workspace: ws, role: 'DSH（执行 Agent）'};
  const r = renderOpening({workspace: ws, variables: vars, template, state, maxBytes: 60000, frameworkVersion: '0.2'});
  assert.ok(r.text.includes('开始之前：先查状态'));
  assert.ok(r.text.includes('用户**是 `小明`'), 'variable filled');
  assert.ok(r.text.includes('工作区 `' + ws + '`'), 'workspace variable filled');
  assert.ok(!r.text.includes('{{'), 'no leftover placeholders');
  assert.ok(!r.text.includes('> 草案'), 'draft note stripped');
  assert.ok(r.text.includes('`stage` = **first_run**'));
  assert.deepEqual(r.omitted, []);
  const small = renderOpening({workspace: ws, variables: vars, template, state, maxBytes: 14000, frameworkVersion: '0.2'});
  assert.ok(small.bytes <= 14000);
  assert.ok(small.omitted.length > 0);
  assert.ok(small.text.includes('开始之前：先查状态'), 'constitution never omitted first');
});

test('engine.deliver writes targets, OPENING copy and manifest; idempotent second run', () => {
  const ws = freshWorkspace();
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const engine = new FrameworkEngine({workspace: ws, dshHome: home, userName: '小明', targets: ['dshHome', 'workspace'], watch: false});
  const d1 = engine.deliver();
  assert.equal(d1.stage, 'first_run');
  assert.ok(existsSync(join(home, 'AGENTS.md')));
  assert.ok(existsSync(join(ws, 'AGENTS.md')));
  assert.ok(existsSync(join(ws, 'connection', 'OPENING.md')));
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), readFileSync(join(ws, 'connection', 'OPENING.md'), 'utf8'));
  const d2 = engine.deliver();
  assert.equal(d2.targets.every(t => t.written === false), true, 'no rewrite when unchanged');
  const h = engine.health();
  assert.equal(h.stage, 'first_run');
  assert.equal(h.last_error, null);
});

test('task runs do not leave first_run; a completed talk run or a filled required slot does', () => {
  const ws = freshWorkspace();
  let s = computeState({workspace: ws});
  writeManifest({workspace: ws, state: s.state, manifest: s.manifest, manifestPath: s.manifestPath});
  // v0.3 引擎写的任务轮：INPUT 没有 mode 前言
  const run = join(ws, 'connection', 'runs', 'task-1');
  mkdirSync(run, {recursive: true});
  writeFileSync(join(run, 'INPUT.md'), '# 完整输入\n\n## 用户指令\n\n讲一个概念', 'utf8');
  writeFileSync(join(run, 'STATUS.md'), 'completed', 'utf8');
  s = computeState({workspace: ws});
  assert.equal(s.state.stage, 'first_run', 'a task run must not advance the stage');
  assert.equal(s.state.runs, 1);
  fillSlot(ws, 'USER/identity.md', '称呼', '小明');
  s = computeState({workspace: ws});
  assert.equal(s.state.stage, 'filling', 'a filled required slot means the meeting happened');
});

test('open helpers: platform command, loopback-only, token redaction', () => {
  assert.deepEqual(openCommand('win32', 'http://127.0.0.1:3090/'), ['rundll32.exe', ['url.dll,FileProtocolHandler', 'http://127.0.0.1:3090/']]);
  assert.equal(openCommand('darwin', 'http://127.0.0.1:3090/')[0], 'open');
  assert.equal(isLoopbackUrl('http://127.0.0.1:3090/?token=abc-123'), true);
  assert.equal(isLoopbackUrl('http://example.com/'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1:3090/?token=a b'), false);
  assert.equal(redactToken('http://127.0.0.1:3090/?token=secret&x=1'), 'http://127.0.0.1:3090/?token=<redacted>&x=1');
});
