import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installation, PROFILE_NAME, profilePatches } from './runtime-config.mjs';

/** Application-owned profile: official bundle composition + shared installation resolution. */
export async function setupRuntime({projectRoot, workspace, home, dshInstall, config = {}}) {
  projectRoot = resolve(projectRoot); workspace = resolve(workspace); home = resolve(home);
  const installed = installation(dshInstall);
  const {initProfile} = await import(pathToFileURL(installed.require.resolve('@deepseek-ai/dsh-app-boot')).href);
  const profile = join(home, 'profiles', PROFILE_NAME);
  const marker = join(home, 'study-bridge-owner.json');
  await mkdir(home, {recursive: true});
  const ownership = {projectRoot, workspace, version: 1};
  try {
    const old = JSON.parse(await readFile(marker, 'utf8'));
    if (JSON.stringify(old) !== JSON.stringify(ownership)) throw new Error('Runtime home belongs to another workspace');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await readdir(home)).length) throw new Error('Refusing an existing non-bridge DSH home');
    await writeFile(marker, JSON.stringify(ownership) + '\n', {flag: 'wx'});
  }
  initProfile(profile, ['@deepseek-ai/dsh-sdk-minimal', '@yorhagengyue/dsh-study'], 'startup');
  const pluginTarget = join(profile, 'node_modules', '@yorhagengyue', 'dsh-study');
  await mkdir(pluginTarget, {recursive: true});
  // Copy only distributable code; never node_modules, cache, learner data, .env or Git.
  for (const name of await readdir(join(projectRoot, 'plugin'))) {
    if (name === 'package.json' || name === 'cordis.patch.yml' || /\.(mjs|d\.ts)$/.test(name)) {
      await copyFile(join(projectRoot, 'plugin', name), join(pluginTarget, name));
    }
  }
  const fsTarget = join(profile, 'node_modules', '@yorhagengyue', 'dsh-bridge-fs');
  await mkdir(fsTarget, {recursive: true});
  await writeFile(join(fsTarget, 'package.json'), JSON.stringify({name: '@yorhagengyue/dsh-bridge-fs', version: '0.1.0', private: true, type: 'module', main: 'index.mjs'}) + '\n');
  await copyFile(join(dirname(fileURLToPath(import.meta.url)), 'workspace-fs.mjs'), join(fsTarget, 'index.mjs'));
  const policyTarget = join(profile, 'node_modules', '@yorhagengyue', 'dsh-bridge-policy');
  await mkdir(policyTarget, {recursive: true});
  await writeFile(join(policyTarget, 'package.json'), JSON.stringify({name: '@yorhagengyue/dsh-bridge-policy', version: '0.1.0', private: true, type: 'module', main: 'index.mjs'}) + '\n');
  await copyFile(join(dirname(fileURLToPath(import.meta.url)), 'runtime-policy.mjs'), join(policyTarget, 'index.mjs'));
  // JSON is a YAML subset, avoiding platform-specific path escaping.
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(profilePatches({...config, projectRoot, workspace}), null, 2) + '\n');
  return {...installed, home, profile};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node bridge/setup-runtime.mjs <non-secret-config.json>');
  const result = await setupRuntime(JSON.parse(await readFile(file, 'utf8')));
  process.stdout.write(JSON.stringify({profile: result.profile, versions: result.versions}) + '\n');
}
