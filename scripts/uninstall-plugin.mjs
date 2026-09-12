import { PACKAGE, options, readManifest, snapshot, runNode, updatePatch } from './plugin-profile.mjs';

const opt = options();
const backup = snapshot(opt, 'uninstall');
if (readManifest(opt).dependencies?.[PACKAGE]) runNode(opt.cli, ['plugin', '--profile', opt.profileName, 'remove', PACKAGE, '--ignore-scripts'], opt);
updatePatch(opt, false);
const manifest = readManifest(opt);
if (manifest.dependencies?.[PACKAGE] || manifest.dsh?.profile?.bundles?.includes(PACKAGE)) throw new Error('DSH package remains registered');
console.log(JSON.stringify({uninstalled: true, package: PACKAGE, profile: opt.profileName, backup,
  restart_required: true, retained: ['project files', 'ignored local materials/state/.env'],
  next: 'Restart the same DSH host to unload tools. Provider disposal closes only its owned Python child.'}, null, 2));
