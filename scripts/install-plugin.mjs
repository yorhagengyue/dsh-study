import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { PACKAGE, options, readManifest, snapshot, runNode, updatePatch } from './plugin-profile.mjs';

const opt = options();
if (!Number.isInteger(opt.backendPort) || opt.backendPort < 1024 || opt.backendPort > 65535) throw new Error('Invalid backend port');
if (!existsSync(join(opt.root, '.env'))) throw new Error('Configure ignored project-root .env before installing');
const backup = snapshot(opt, 'install');
const packed = join(opt.root, 'runtime', 'packages');
mkdirSync(packed, {recursive: true});
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!existsSync(npmCli)) throw new Error('Node installation must include npm for local packaging');
const output = runNode(npmCli, ['pack', join(opt.root, 'plugin'), '--pack-destination', packed, '--json', '--ignore-scripts'], opt);
const archive = JSON.parse(output)[0];
const temporaryTarball = join(packed, archive.filename);
// pnpm caches file: dependencies by archive path. Never overwrite an installed path.
const digest = createHash('sha256').update(readFileSync(temporaryTarball)).digest('hex');
const tarball = join(packed, archive.filename.replace(/\.tgz$/, `-${digest.slice(0, 16)}.tgz`));
// Keep npm's original archive too: an older profile may still reference that legacy path
// while the official CLI resolves its currently installed dependencies before updating.
if (!existsSync(tarball)) copyFileSync(temporaryTarball, tarball);
runNode(opt.cli, ['plugin', '--profile', opt.profileName, 'add', tarball, '--ignore-scripts'], opt);
updatePatch(opt, true);
const manifest = readManifest(opt);
if (!manifest.dsh?.profile?.bundles?.includes(PACKAGE)) throw new Error('DSH did not register the package as a profile bundle');
const installedRoot = join(opt.profile, 'node_modules', PACKAGE);
for (const entry of archive.files) {
  const wanted = readFileSync(join(opt.root, 'plugin', entry.path));
  const actual = readFileSync(join(installedRoot, entry.path));
  if (!wanted.equals(actual)) throw new Error(`Installed plugin differs from packaged source: ${entry.path}`);
}
console.log(JSON.stringify({installed: true, package: PACKAGE, profile: opt.profileName, backup, package_sha256: digest, verified_files: archive.files.length, restart_required: true,
  next: 'Restart the existing authorized DSH host without opening a browser; use verify-dsh.mjs for execution evidence.'}, null, 2));
