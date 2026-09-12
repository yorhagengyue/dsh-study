import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeArtifactPath, prepareWorkspace, observeBefore, snapshotArtifacts, readSnapshot } from '../artifacts.mjs';

test('artifact paths reject Windows and POSIX traversal, secrets and repository metadata', () => {
  for (const value of ['../a', 'a/../b', '/tmp/a', 'C:\\a', '\\\\host\\a', '.env', 'a/.env.local', '.git/config', 'a//b', 'a:stream', 'a/./b']) {
    assert.throws(() => normalizeArtifactPath(value), { code: 'invalid_artifact_path' }, value);
  }
  assert.equal(normalizeArtifactPath('output\\report.md'), 'output/report.md');
});

test('workspace validation and immutable bytes distinguish newly created, changed and existing files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  const workspace = await prepareWorkspace(path.join(allowed, 'task'), [allowed]);
  await assert.rejects(prepareWorkspace(path.join(root, 'elsewhere'), [allowed]), { code: 'workspace_not_allowed' });
  await fs.writeFile(path.join(workspace, 'existing.md'), 'unchanged');
  const before = await observeBefore(workspace, ['existing.md', 'new.md']);
  await fs.writeFile(path.join(workspace, 'new.md'), '学习来源：合成示例\n');
  const directory = path.join(root, 'snapshots');
  const artifacts = await snapshotArtifacts({ workspace, deliverables: ['existing.md', 'new.md'], directory, before });
  assert.equal(artifacts[0].changed, false);
  assert.equal(artifacts[0].generation_evidence, 'unchanged_existing');
  assert.equal(artifacts[1].created, true);
  await fs.writeFile(path.join(workspace, 'new.md'), 'later correction');
  const received = await readSnapshot(directory, artifacts[1], 'run-1');
  assert.equal(received.text, '学习来源：合成示例\n');
  assert.equal(Buffer.from(received.content, received.encoding).toString('utf8'), received.text);
  await fs.writeFile(path.join(directory, artifacts[1].snapshot), 'corruption');
  await assert.rejects(readSnapshot(directory, artifacts[1], 'run-1'), { code: 'snapshot_corrupt' });
});

test('partial snapshots retain declared available files and report missing/oversized artifacts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-partial-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'good.md'), 'ok');
  await fs.writeFile(path.join(root, 'large.md'), 'far too large');
  const result = await snapshotArtifacts({ workspace: root, deliverables: ['good.md', 'missing.md', 'large.md'],
    directory: path.join(root, 'snapshots'), maxBytes: 5, partial: true });
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].partial, true);
  assert.deepEqual(result.missing, ['missing.md']);
  assert.equal(result.errors[0].code, 'artifact_too_large');
});

test('symlink artifacts and workspace ancestors cannot escape allowed roots', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  await fs.mkdir(allowed); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.md'), 'external');
  try { await fs.symlink(outside, path.join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Host does not permit symlink creation'); throw error; }
  await assert.rejects(prepareWorkspace(path.join(allowed, 'escape', 'child'), [allowed]), { code: 'workspace_escape' });
  await assert.rejects(observeBefore(allowed, ['escape/secret.md']), { code: 'artifact_escape' });
  await fs.mkdir(path.join(allowed, '.git'));
  await fs.writeFile(path.join(allowed, '.git', 'config'), 'private repository metadata');
  await fs.symlink(path.join(allowed, '.git'), path.join(allowed, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(observeBefore(allowed, ['alias/config']), { code: 'invalid_artifact_path' });
});
