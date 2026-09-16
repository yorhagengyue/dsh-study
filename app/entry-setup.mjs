// 装机时把入口 skill 装给每一个可能当主 agent 的工具（Codex：~/.codex/skills；Claude Code：~/.claude/skills），
// 并在各自的用户级规则文件（~/.codex/AGENTS.md、~/.claude/CLAUDE.md）里放一段带标记的入口指引，让任何新会话都知道这台机器装了学习系统。
// 耿越 2026-09-16 定：任何人下载安装后，Claude 和 Codex 同时适配。两份 skill 内容一样，各自带一份 connection.local.json 和 app/，脚本按自己所在位置找配置。
// 用法（给 install.mjs 调，也可单跑）：node app/entry-setup.mjs --root <安装包根> --workspace <工作区> --config-json '<json>'
import {readFileSync, writeFileSync, existsSync, mkdirSync, cpSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

export const SKILLS = ['dsh-dialogue', 'dsh-scan', 'dsh-context-onboarding', 'dsh-understand'];
export const TOOLS = [
  {id: 'codex', skillsDir: join(homedir(), '.codex', 'skills'), rulesFile: join(homedir(), '.codex', 'AGENTS.md'), label: 'Codex'},
  {id: 'claude', skillsDir: join(homedir(), '.claude', 'skills'), rulesFile: join(homedir(), '.claude', 'CLAUDE.md'), label: 'Claude Code'},
];
const BEGIN = '<!-- dsh-study:begin -->', END = '<!-- dsh-study:end -->';

export function pointerBlock({skillsDir, workspace, label}) {
  return [BEGIN,
    '## 学习系统（DSH-Study）',
    `这台机器装了学习系统，你（${label}）是它的入口，也就是主 agent；执行端是本机的 DSH。用户谈学习、课程、资料，或要你理解他的时候：先读 \`${join(skillsDir, 'dsh-dialogue', 'SKILL.md')}\`（每条消息怎么走、怎么派工给 DSH、怎么验收）、\`${join(skillsDir, 'dsh-scan', 'SKILL.md')}\`（全扫这台电脑，从头到尾：跑、读、反思、反馈）和 \`${join(skillsDir, 'dsh-understand', 'SKILL.md')}\`（第二步：理解人）。工作区在 \`${workspace}\`，规则在它的 \`FRAMEWORK.md\` 和 \`protocols/\`。`,
    '起 DSH 服务和打开它的浏览器界面是用户装机时预授权的固定动作，不用再问；除此之外不动用户的窗口。',
    END].join('\n');
}

export function ensurePointer(file, block) {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const b = block.replace(/\n/g, nl);
  const i = text.indexOf(BEGIN), j = text.indexOf(END);
  let next;
  if (i >= 0 && j > i) next = text.slice(0, i) + b + text.slice(j + END.length);
  else next = (text.trimEnd() ? text.trimEnd() + nl + nl : '') + b + nl;
  if (next === text) return {file, changed: false};
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, next, 'utf8');
  return {file, changed: true, created: !existsSync(file) ? true : text === ''};
}

/** 把安装包里的四个 skill 装到 tools 里每一个的 skillsDir；dsh-dialogue 附带 connection.local.json、app/、connection-plugin/。返回每个工具装到哪。 */
export function installSkills({root, config, tools = TOOLS, backupDir = null}) {
  const done = [];
  for (const tool of tools) {
    const out = {tool: tool.id, skillsDir: tool.skillsDir, skills: []};
    for (const name of SKILLS) {
      const src = join(root, 'skills', name); if (!existsSync(src)) continue;
      const dest = join(tool.skillsDir, name);
      if (backupDir && existsSync(dest)) cpSync(dest, join(backupDir, tool.id, name), {recursive: true});
      mkdirSync(tool.skillsDir, {recursive: true});
      cpSync(src, dest, {recursive: true});
      if (name === 'dsh-dialogue') {
        writeFileSync(join(dest, 'connection.local.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
        cpSync(join(root, 'app'), join(dest, 'app'), {recursive: true});
        cpSync(join(root, 'connection-plugin'), join(dest, 'connection-plugin'), {recursive: true});
      }
      if (name === 'dsh-scan') { // 全扫 skill 自带配置和扫描脚本，单独打开也能跑
        writeFileSync(join(dest, 'connection.local.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
        mkdirSync(join(dest, 'app'), {recursive: true});
        cpSync(join(root, 'app', 'scan.mjs'), join(dest, 'app', 'scan.mjs'));
      }
      out.skills.push(name);
    }
    done.push(out);
  }
  return done;
}

export function installPointers({workspace, tools = TOOLS}) {
  return tools.map(tool => ({tool: tool.id, ...ensurePointer(tool.rulesFile, pointerBlock({skillsDir: tool.skillsDir, workspace, label: tool.label}))}));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = n => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
  const root = resolve(at('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const workspace = resolve(at('--workspace'));
  const config = at('--config-json') ? JSON.parse(at('--config-json')) : JSON.parse(readFileSync(at('--config'), 'utf8'));
  console.log(JSON.stringify({skills: installSkills({root, config}), pointers: installPointers({workspace})}, null, 2));
}
