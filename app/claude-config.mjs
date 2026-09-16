// 给用户的 Claude Code 开全权限（和 codex-config.mjs 对称）。耿越 2026-09-16 定：装机后入口不弹窗；入口可以是 Codex 或 Claude Code。
// Claude Code 的开关在 ~/.claude/settings.json：permissions.defaultMode = "bypassPermissions"（跳过所有工具审批），
// 加 skipDangerousModePermissionPrompt = true（不弹"确认进入 bypass 模式"的对话框）。别的键、顺序一律不动；改前留 settings.json.before-dsh-study-<日期>.bak。
// 用法：node app/claude-config.mjs [--claude-home <dir>] [--dry-run]
import {readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

export const WANTED = {defaultMode: 'bypassPermissions', skipDangerousModePermissionPrompt: true};
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');

export function patchSettings(obj) {
  const out = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  const changes = [];
  const perms = (out.permissions && typeof out.permissions === 'object' && !Array.isArray(out.permissions)) ? out.permissions : {};
  if (perms.defaultMode !== WANTED.defaultMode) { changes.push(`permissions.defaultMode: ${JSON.stringify(perms.defaultMode ?? null)} -> "${WANTED.defaultMode}"`); perms.defaultMode = WANTED.defaultMode; }
  out.permissions = perms;
  if (out.skipDangerousModePermissionPrompt !== true) { changes.push(`skipDangerousModePermissionPrompt: ${JSON.stringify(out.skipDangerousModePermissionPrompt ?? null)} -> true`); out.skipDangerousModePermissionPrompt = true; }
  return {settings: out, changes};
}

export function applyClaudeConfig({home = claudeHome(), dryRun = false} = {}) {
  const path = join(home, 'settings.json');
  let before = null, parsed = {};
  if (existsSync(path)) {
    before = readFileSync(path, 'utf8');
    try { parsed = JSON.parse(before); } catch (e) { return {path, changed: false, changes: [], backup: null, error: 'SETTINGS_JSON_UNPARSEABLE: ' + e.message}; }
  }
  const {settings, changes} = patchSettings(parsed);
  const changed = changes.length > 0;
  let backup = null;
  if (changed && !dryRun) {
    mkdirSync(home, {recursive: true});
    if (before !== null) {
      const d = new Date(), tag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      backup = join(home, `settings.json.before-dsh-study-${tag}.bak`);
      if (!existsSync(backup)) copyFileSync(path, backup); else backup += ' (already there)';
    }
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
  return {path, changed, changes, backup, ...WANTED};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); let home; let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--claude-home') home = resolve(args[++i]);
    else if (args[i] === '--dry-run') dryRun = true;
    else throw new Error('UNKNOWN_ARG ' + args[i]);
  }
  console.log(JSON.stringify(applyClaudeConfig({home: home ?? claudeHome(), dryRun}), null, 2));
}
