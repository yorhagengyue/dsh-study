// 开场渲染：FRAMEWORK.md 填四个变量 + 状态 + 已填槽位 + 机器 + 工程 + 文件位置，按模板拼成一份 Markdown。
import {join} from 'node:path';
import {readText, sectionsOf, slotFilled, parseTables} from './state.mjs';

export const VARIABLE_KEYS = {userName: '用户称呼', machine: '机器', workspace: '工作区', role: '当前角色'};

const STAGE_TEXT = {
  first_run: '这是第一次。按宪法开头三件事：① 读最新全扫（位置见上）；② **把三个必填槽从 SCAN 的候选来源填上**（规则文件里写明的直接写，推出来的进抽屉，读过还没有的才标"未知"）；③ 摆坐标。用户带任务来就在同一轮接着做，整轮只问一个问题。做完把 MANIFEST 的 first_meeting_done 改 true、user_version 加一，否则下一轮还是第一次。你不扫电脑。',
  filling: '不是第一次，但还没填完。空着的必填槽先查 SCAN 候选来源和已有记录能不能填，能填就填（带出处）；不能填的从空着的槽接着谈，已经明确的不重问；接任务时真没有的槽在结果里标"未知"，不猜。',
  complete: '框架完整。按本轮 `INPUT.md` 正常走；涉及过期或冲突的记录先问再用。',
};

function stripDraftNote(text) {
  return text.replace(/^(#[^\n]*\n\n)> 草案[^\n]*\n(?:>[^\n]*\n)*\n?/, '$1');
}

function fillVariables(text, variables) {
  let out = text;
  for (const [key, name] of Object.entries(VARIABLE_KEYS)) {
    out = out.split('{{' + name + '}}').join(variables[key] ?? '');
  }
  return out;
}

function filledSections(markdown, {skipTables = false} = {}) {
  return sectionsOf(markdown)
    .filter(s => slotFilled(s.body))
    .map(s => {
      let body = s.body;
      if (skipTables) body = body.split(/\r?\n/).filter(l => !l.trim().startsWith('|')).join('\n').trim();
      return body ? `### ${s.title}\n\n${body}` : '';
    })
    .filter(Boolean);
}

function nonEmptyTables(markdown) {
  const out = [];
  for (const t of parseTables(markdown)) {
    if (!t.rows.length) continue;
    const head = '| ' + t.header.join(' | ') + ' |\n|' + t.header.map(() => '---').join('|') + '|';
    out.push(head + '\n' + t.rows.map(r => '| ' + r.join(' | ') + ' |').join('\n'));
  }
  return out;
}

export function renderStateText(state) {
  const lines = [
    `- \`stage\` = **${state.stage}**（profile ${state.profile_id ?? '未建'}；user_version ${state.user_version}；本框架下的轮次 ${state.runs}，其中谈话 ${state.talk_runs}）`,
    `- 必填槽位：已填 ${state.required_slots.filled} / ${state.required_slots.total}${state.required_slots.empty.length ? '，空着：' + state.required_slots.empty.join('、') : ''}`,
    `- 全扫：${state.scan ? `做过，最新 ${state.scan.at ?? '时间不明'}（${state.scan.age_days ?? '?'} 天前），${state.scan.files ?? '?'} 个文件，禁区 ${state.scan.forbidden ?? '?'} 处，候选来源 ${state.scan.candidate_sources} 条；文件 \`${state.scan.file}\`，填槽先读它的"候选来源"一节` : '**没做过**。扫描是入口的活（scan.mjs），你不扫；把"入口还没扫"写进回复，用已有记录继续'}`,
    `- 第一次见面：${state.first_meeting_done ? '已完成' : '未完成'}；机器信息：${state.machine_filled ? '已填' : '未填'}；健康检查：${state.health_checked ? '有结果' : '没做过'}`,
    `- 抽屉 open ${state.drawer_open} 条；stale ${state.stale} 条；conflicted ${state.conflicted} 条${state.last_talk_at ? '；上次谈话 ' + state.last_talk_at : ''}`,
    '',
    STAGE_TEXT[state.stage] ?? '',
  ];
  return lines.join('\n');
}

export function renderUserText(workspace) {
  const parts = [];
  const identity = readText(join(workspace, 'USER', 'identity.md'));
  const style = readText(join(workspace, 'USER', 'style.md'));
  const learning = readText(join(workspace, 'USER', 'learning.md'));
  parts.push(...filledSections(identity));
  const learnSec = filledSections(learning, {skipTables: true});
  parts.push(...learnSec);
  parts.push(...nonEmptyTables(learning));
  parts.push(...nonEmptyTables(style));
  return parts.length ? parts.join('\n\n') : '（还没有已填的槽位。）';
}

export function renderMachineText(workspace) {
  const machine = readText(join(workspace, 'MACHINE.md'));
  const parts = filledSections(machine, {skipTables: true}).filter(p => !p.startsWith('### 最近健康'));
  parts.push(...nonEmptyTables(machine));
  return parts.length ? parts.join('\n\n') : '（空，待发现器填。）';
}

export function renderProjectText(workspace) {
  const project = readText(join(workspace, 'PROJECT.md'));
  const secs = sectionsOf(project);
  const stage = secs.find(s => s.title.startsWith('产品阶段'));
  const parts = [];
  if (stage) parts.push(stage.body);
  const decisions = parseTables(project).find(t => t.header.includes('决定'));
  if (decisions && decisions.rows.length) {
    const last = decisions.rows.slice(-3);
    parts.push('最近的决定：\n' + last.map(r => `- ${r[1]}（理由：${r[2]}；适用：${r[3]}）`).join('\n'));
  }
  return parts.join('\n\n');
}

export function renderIndexText(workspace, scan = null) {
  const w = workspace;
  return [
    `- 最新全扫：${scan ? join(w, scan.file) : '（还没有；入口跑 scan.mjs 后出现在 connection/context/）'}`,
    `- 宪法：${join(w, 'FRAMEWORK.md')}`,
    `- 协议：${join(w, 'protocols')}（CONTRACT、DISCOVERY、CONVERSATION、HEALTH、ROUND、ACCEPTANCE）`,
    `- 实例清单：${join(w, 'MANIFEST.md')}`,
    `- 槽位：${join(w, 'USER')}（identity、learning、style、sources、facts）；${join(w, 'MACHINE.md')}`,
    `- 生长层：${join(w, 'PROJECT.md')}、${join(w, 'DRAWER.md')}、${join(w, 'MEMORY.md')}、${join(w, 'connection', 'AUDIT.md')}`,
    `- 资料目录：${join(w, 'connection', 'context', 'INDEX.md')}（工具 study_context_index / study_context_read）`,
    `- 每轮记录：${join(w, 'connection', 'runs')}`,
  ].join('\n');
}

const OMIT_ORDER = ['project', 'machine', 'user', 'index'];

/**
 * 渲染开场。返回 {text, bytes, omitted, sections}。
 * template 里可用：{{framework}} {{state}} {{user}} {{machine}} {{project}} {{index}}
 * {{rendered_at}} {{stage}} {{framework_version}} {{workspace_path}} 以及四个变量 {{用户称呼}} 等。
 */
export function renderOpening({workspace, variables, template, state, maxBytes = 60000, frameworkVersion = '', now = new Date()}) {
  let framework = readText(join(workspace, 'FRAMEWORK.md'));
  framework = fillVariables(stripDraftNote(framework), variables);
  const sections = {
    framework,
    state: renderStateText(state),
    user: renderUserText(workspace),
    machine: renderMachineText(workspace),
    project: renderProjectText(workspace),
    index: renderIndexText(workspace, state.scan),
  };
  const omitted = [];
  const build = () => {
    let out = template;
    const values = {
      ...sections,
      rendered_at: now.toISOString(),
      stage: state.stage,
      framework_version: frameworkVersion,
      workspace_path: workspace,
    };
    for (const [k, v] of Object.entries(values)) out = out.split('{{' + k + '}}').join(v);
    out = fillVariables(out, variables);
    return out;
  };
  let text = build();
  for (const key of OMIT_ORDER) {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) break;
    sections[key] = `（超出注入预算 ${maxBytes} 字节，此节省略；原文见工作区文件。）`;
    omitted.push(key);
    text = build();
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const notice = '\n\n（开场超出预算，已截断。）\n';
    const room = Math.max(0, maxBytes - Buffer.byteLength(notice, 'utf8'));
    text = Buffer.from(text, 'utf8').subarray(0, room).toString('utf8').replace(/�+$/, '') + notice;
    omitted.push('truncated');
  }
  return {text, bytes: Buffer.byteLength(text, 'utf8'), omitted, sections: Object.keys(sections)};
}
