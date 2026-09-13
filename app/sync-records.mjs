// 把学习工作区的记录同步到一个私有 Git 仓（给做系统的人看，用来改进）。
// 用法：node app/sync-records.mjs [--config connection.local.json] [--register-task] [--quiet]
// 凭证只从 <dsh_root>/.env 读：RECORDS_REPO=owner/repo + RECORDS_SSH_KEY=私钥路径（相对 dsh_root）——deploy key 走 SSH；
// 或 RECORDS_REPO + RECORDS_TOKEN=github_pat_…（HTTPS）；或 RECORDS_REMOTE=完整 URL。
// 没配就什么都不做。永远不提交 .env、完整扫描清单、旧 profile 目录和代码目录。
import {existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir, hostname} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const quiet = args.includes('--quiet');
const configPath = resolve(opt('--config') ?? join(homedir(), '.codex', 'skills', 'dsh-dialogue', 'connection.local.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const workspace = resolve(config.workspace);
const out = (o) => { if (!quiet) process.stdout.write(JSON.stringify(o) + '\n'); };

function envValues(root) {
  const o = {}; const p = join(root, '.env');
  if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/); if (m) o[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); }
  return o;
}
const env = envValues(config.dsh_root);
const repoName = env.RECORDS_REPO ? env.RECORDS_REPO.replace(/^\/+|\.git$/g, '') : null;
const sshKey = env.RECORDS_SSH_KEY ? resolve(config.dsh_root, env.RECORDS_SSH_KEY) : null;
let remote = env.RECORDS_REMOTE || null;
let gitEnv = {...process.env, GIT_TERMINAL_PROMPT: '0'};
if (!remote && repoName && sshKey) {
  if (!existsSync(sshKey)) { out({synced: false, reason: 'SSH_KEY_MISSING', key: sshKey}); process.exit(0); }
  remote = `git@github.com:${repoName}.git`;
  const q = (s) => '"' + String(s).replace(/\\/g, '/').replace(/"/g, '\\"') + '"';
  gitEnv.GIT_SSH_COMMAND = `ssh -i ${q(sshKey)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${q(join(config.dsh_root, 'records-known-hosts'))} -o BatchMode=yes`;
} else if (!remote && repoName && env.RECORDS_TOKEN) remote = `https://x-access-token:${env.RECORDS_TOKEN}@github.com/${repoName}.git`;
if (!remote) { out({synced: false, reason: 'RECORDS_NOT_CONFIGURED'}); process.exit(0); }

const redact = (s) => String(s).replace(/x-access-token:[^@\s]+@/g, 'x-access-token:<redacted>@').replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_<redacted>');
function git(params, okCodes = [0]) {
  const r = spawnSync('git', params, {cwd: workspace, encoding: 'utf8', windowsHide: true, env: gitEnv});
  if (r.error) throw new Error('GIT_NOT_AVAILABLE: ' + r.error.message);
  if (!okCodes.includes(r.status)) throw new Error('git ' + params[0] + ' failed: ' + redact((r.stderr || r.stdout || '').trim().slice(-400)));
  return (r.stdout || '').trim();
}

// 记录仓里永远不放的东西
const IGNORE = ['.env', '.env.*', '*.tgz', 'node_modules/', 'profiles/', 'runs/', 'active-profile.json', 'connection/install-backups/', 'connection/app/', 'connection/framework-plugin/', 'connection/archive/', 'connection/context/SCAN-*-清单.md', 'connection/context/_scan-raw.txt', 'connection/context/versions/', '*.lnk', '*.cmd', '*.command'];
mkdirSync(workspace, {recursive: true});
const gi = join(workspace, '.gitignore');
const have = existsSync(gi) ? readFileSync(gi, 'utf8').split(/\r?\n/) : [];
const missing = IGNORE.filter(l => !have.includes(l));
if (missing.length) writeFileSync(gi, (have.join('\n').trimEnd() + '\n' + missing.join('\n') + '\n').replace(/^\n/, ''), 'utf8');

if (!existsSync(join(workspace, '.git'))) { git(['init', '-q']); git(['config', 'user.name', 'dsh-study-records']); git(['config', 'user.email', 'records@dsh-study.local']); }
const remotes = git(['remote']);
if (remotes.split('\n').includes('origin')) git(['remote', 'set-url', 'origin', remote]); else git(['remote', 'add', 'origin', remote]);
// 每台机器一条分支：records/<主机名>-<profile 短 id>
let profile = 'unknown';
try { const m = readFileSync(join(workspace, 'MANIFEST.md'), 'utf8').match(/"profile_id"\s*:\s*"profile-([0-9a-f]+)"/); if (m) profile = m[1].slice(0, 6); } catch {}
const branch = `records/${hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${profile}`;
git(['checkout', '-q', '-B', branch]);
git(['add', '-A']);
// 记录目录里可能有 DSH 自己写的 .gitignore（例如 connection/.gitignore 写了 *）；记录本身必须进仓，逐项强制加入
const forceAdd = ['connection/runs', 'connection/client-requests', 'connection/health', 'connection/RUNS.md', 'connection/INDEX.md', 'connection/HEALTH.md', 'connection/INSTALL.md', 'connection/ENV-SETUP.md', 'connection/OPENING.md', 'connection/AUDIT.md'];
for (const rel of forceAdd) if (existsSync(join(workspace, rel))) git(['add', '-f', rel]);
try { for (const f of readdirSync(join(workspace, 'connection', 'context'))) if (/^SCAN-\d{4}-\d{2}-\d{2}\.md$/.test(f)) git(['add', '-f', join('connection', 'context', f)]); } catch {}
const staged = git(['diff', '--cached', '--name-only']);
let commit = null;
if (staged) { git(['commit', '-q', '-m', `records ${new Date().toISOString()} (${staged.split('\n').length} files)`]); commit = git(['rev-parse', '--short', 'HEAD']); }
let pushed = false, pushError = null;
try { git(['push', '-q', '-u', 'origin', branch]); pushed = true; } catch (e) { pushError = redact(e.message); }

// 定时兜底：Windows 计划任务每 30 分钟跑一次本脚本（按用户注册，不用管理员）
let task = null;
if (args.includes('--register-task') && process.platform === 'win32') {
  const tr = `"${process.execPath}" "${fileURLToPath(import.meta.url)}" --config "${configPath}" --quiet`;
  const r = spawnSync('schtasks', ['/Create', '/F', '/SC', 'MINUTE', '/MO', '30', '/TN', 'DSH-Study Records Sync', '/TR', tr], {encoding: 'utf8', windowsHide: true});
  task = r.status === 0 ? 'registered_every_30_min' : 'register_failed: ' + (r.stderr || r.stdout || '').trim().slice(-200);
}
out({synced: pushed, branch, commit, files_staged: staged ? staged.split('\n').length : 0, push_error: pushError, task});
