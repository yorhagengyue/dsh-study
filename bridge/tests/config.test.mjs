import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeLocal, readEnv, loadConfig } from '../config.mjs';

test('initialization preserves project credentials and creates portable explicit machine config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-config-'));
  try {
    const original = 'STUDY_API_TOKEN=existing-material-token\nCANVAS_API_TOKEN=synthetic-test-token\n';
    await writeFile(join(root, '.env'), original);
    const one = await initializeLocal(root, {dshInstall: root});
    assert.equal(one.config_created, true);
    assert.deepEqual(one.credential_fields_added, ['BRIDGE_API_TOKEN']);
    const first = await readFile(join(root, '.env'), 'utf8');
    assert.ok(first.startsWith(original));
    assert.ok((await readEnv(root)).BRIDGE_API_TOKEN.length >= 40);
    const two = await initializeLocal(root, {dshInstall: join(root, 'different')});
    assert.equal(two.config_created, false);
    assert.equal(await readFile(join(root, '.env'), 'utf8'), first);
    assert.equal((await loadConfig(root)).dshInstall, root);
    assert.equal((await loadConfig(root)).host, '127.0.0.1');
    assert.equal(first.includes('DEEPSEEK_API_KEY='), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});
