// 给用户的 Codex 开全盘权限。耿越 2026-09-16 定：全扫不弹窗，装机时直接给 Codex 全盘读权限。
// 这版 Codex 在 Windows 上没有"只读全盘"的档（disk-full-read-access 不生效，见 research/07 §10），
// 能用的开关只有 sandbox_mode = "danger-full-access"（读写全开），"写成什么"靠宪法第 6、7 节约束。
// 改动只对重开后的 Codex 会话生效；README 让用户装完把 Codex 关掉重开一次。
// 用法：node app/codex-config.mjs [--codex-home <dir>] [--trust <path>]... [--dry-run]
// 做法：只改 config.toml 顶层的 sandbox_mode / approval_policy 两个键（别的键、注释、表一律不动）；
//       [projects.'<path>'] 缺 trust_level 就补成 "trusted"（少一次"信任这个文件夹吗"）；改前留 config.toml.before-dsh-study-<日期>.bak。
import {readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

export const WANTED = {sandbox_mode: 'danger-full-access', approval_policy: 'never'};
export const codexHome = () => process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex');
const win = process.platform === 'win32';
const stripTrail = (p) => p.replace(/[\\/]+$/, '');
// Codex 在 Windows 上把项目路径写成小写反斜杠形式（例如 [projects.'c:\users\name']），照它的样子写，比较时也按这个规则。
const projectKey = (p) => win ? stripTrail(resolve(p).replace(/\//g, '\\')).toLowerCase() : stripTrail(resolve(p));
const samePath = (a, b) => win ? stripTrail(a.replace(/\//g, '\\')).toLowerCase() === stripTrail(b.replace(/\//g, '\\')).toLowerCase() : stripTrail(a) === stripTrail(b);

export function patchConfigText(text, trust = []) {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // 尾部换行最后统一补
  const isTable = (l) => /^\s*\[/.test(l);
  const changes = [];
  let firstTable = lines.findIndex(isTable); if (firstTable < 0) firstTable = lines.length;
  for (const [key, value] of Object.entries(WANTED)) {
    const wanted = `${key} = "${value}"`;
    const re = new RegExp(`^\\s*${key}\\s*=`);
    let idx = -1; for (let i = 0; i < firstTable; i++) if (re.test(lines[i])) { idx = i; break; }
    if (idx >= 0) { if (lines[idx].trim() !== wanted) { changes.push(`${key}: ${lines[idx].trim()} -> ${wanted}`); lines[idx] = wanted; } }
    else { lines.splice(firstTable, 0, wanted); firstTable++; changes.push(`${key}: (absent) -> ${wanted}`); }
  }
  const headerRe = /^\s*\[projects\.(['"])(.+)\1\]\s*$/;
  for (const p of trust) {
    if (!p) continue;
    const key = projectKey(p);
    let start = -1;
    for (let i = 0; i < lines.length; i++) { const m = lines[i].match(headerRe); if (m && samePath(m[2], key)) { start = i; break; } }
    if (start < 0) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push(`[projects.'${key}']`, 'trust_level = "trusted"');
      changes.push(`projects['${key}']: (absent) -> trusted`);
      continue;
    }
    let end = lines.length; for (let i = start + 1; i < lines.length; i++) if (isTable(lines[i])) { end = i; break; }
    let found = -1; for (let i = start + 1; i < end; i++) if (/^\s*trust_level\s*=/.test(lines[i])) { found = i; break; }
    if (found < 0) { lines.splice(start + 1, 0, 'trust_level = "trusted"'); changes.push(`projects['${key}'].trust_level: (absent) -> trusted`); }
    else if (!/"trusted"/.test(lines[found])) { changes.push(`projects['${key}'].trust_level: ${lines[found].trim()} -> trusted`); lines[found] = 'trust_level = "trusted"'; }
  }
  return {text: lines.join(nl) + nl, changes};
}

export function applyCodexConfig({home = codexHome(), trust = [], dryRun = false} = {}) {
  const path = join(home, 'config.toml');
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const {text, changes} = patchConfigText(before, trust);
  const changed = changes.length > 0 && text !== before;
  let backup = null;
  if (changed && !dryRun) {
    mkdirSync(home, {recursive: true});
    if (before !== '') {
      const d = new Date(), tag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      backup = join(home, `config.toml.before-dsh-study-${tag}.bak`);
      if (!existsSync(backup)) copyFileSync(path, backup); else backup += ' (already there)';
    }
    writeFileSync(path, text, 'utf8');
  }
  return {path, changed, changes, backup, ...WANTED};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const trust = []; let home; let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trust') trust.push(args[++i]);
    else if (args[i] === '--codex-home') home = resolve(args[++i]);
    else if (args[i] === '--dry-run') dryRun = true;
    else throw new Error('UNKNOWN_ARG ' + args[i]);
  }
  console.log(JSON.stringify(applyCodexConfig({home: home ?? codexHome(), trust, dryRun}), null, 2));
}
