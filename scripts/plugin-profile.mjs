import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const PACKAGE = '@yorhagengyue/dsh-study';
export const ROWS = ['dsh-study-service', 'dsh-study-provider', 'dsh-study-tools'];
export function options(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/install-plugin.mjs|uninstall-plugin.mjs [--root PATH] [--dsh-root PATH] [--dsh-home PATH] [--profile web] [--python PATH] [--backend-port 8766]');
    process.exit(0);
  }
  const names = new Set(['--root', '--dsh-root', '--dsh-home', '--profile', '--python', '--backend-port']);
  for (let i = 0; i < argv.length; i += 2) {
    if (!names.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid or incomplete option: ${argv[i]}`);
  }
  const at = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const root = resolve(at('--root') ?? fileURLToPath(new URL('..', import.meta.url)));
  const dshRoot = resolve(at('--dsh-root') ?? join(process.env.USERPROFILE ?? '', 'dsh'));
  const dshHome = resolve(at('--dsh-home') ?? join(dshRoot, 'home'));
  const profileName = at('--profile') ?? 'web';
  if (!/^[\w-]+$/.test(profileName)) throw new Error('Invalid profile name');
  const profile = join(dshHome, 'profiles', profileName);
  const cli = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(cli) || !existsSync(join(profile, 'package.json'))) throw new Error('Existing official DSH installation/profile required');
  const require = createRequire(join(dshRoot, 'package.json'));
  const yaml = require('js-yaml');
  return {root, dshRoot, dshHome, profileName, profile, cli, yaml,
    python: at('--python') ?? 'python', backendPort: Number(at('--backend-port') ?? 8766),
    env: {...process.env, DSH_HOME: dshHome}};
}
export function readManifest(opt) { return JSON.parse(readFileSync(join(opt.profile, 'package.json'), 'utf8')); }
export function snapshot(opt, action) {
  const backup = join(opt.root, 'runtime', 'profile-backups', `${Date.now()}-${action}`);
  mkdirSync(backup, {recursive: true});
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
    const path = join(opt.profile, name);
    if (existsSync(path)) copyFileSync(path, join(backup, name));
  }
  return backup;
}
export function runNode(entry, args, opt, cwd = opt.root) {
  const result = spawnSync(process.execPath, [entry, ...args], {cwd, env: opt.env, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  if (result.error || result.status !== 0) {
    // npm/DSH may include transport URLs in error output. Keep raw output only in ignored local runtime.
    const log = join(opt.root, 'runtime', 'plugin-command.log');
    mkdirSync(dirname(log), {recursive: true});
    const safe = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]').replace(/([?&](?:token|access_token|key)=)[^\s&]+/gi, '$1[REDACTED]');
    writeFileSync(log, safe, 'utf8');
    throw new Error(`Plugin command failed (exit ${result.status ?? 'spawn error'}); inspect ignored runtime/plugin-command.log`);
  }
  return result.stdout;
}
export function updatePatch(opt, install) {
  const path = join(opt.profile, 'cordis.patch.yml');
  // Explicit schema supports DSH's !!js nodes, preserving existing expressions as inert tagged values.
  class JsExpression { constructor(value) { this.value = value; } }
  const jsTag = new opt.yaml.Type('tag:yaml.org,2002:js', {kind: 'scalar', instanceOf: JsExpression,
    construct: value => new JsExpression(value), represent: value => value.value});
  const schema = opt.yaml.DEFAULT_SCHEMA.extend([jsTag]);
  const patch = opt.yaml.load(readFileSync(path, 'utf8'), {schema}) ?? [];
  if (!Array.isArray(patch)) throw new Error('Expected an array of DSH patch rows');
  const kept = patch.filter(row => !ROWS.includes(row?.id));
  if (install) {
    kept.push({id: 'dsh-study-provider', config: {projectRoot: opt.root, python: opt.python, backendPort: opt.backendPort, autoStart: true}});
    kept.push({id: 'dsh-study-tools', config: {projectRoot: opt.root}});
  }
  writeFileSync(path, '# Profile overrides; dsh-study owns only rows prefixed dsh-study-.\n' + opt.yaml.dump(kept, {schema, noRefs: true, lineWidth: 120}), 'utf8');
}
