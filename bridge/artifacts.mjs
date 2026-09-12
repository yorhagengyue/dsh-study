import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class BridgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function normalizeArtifactPath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\0')) {
    throw new BridgeError('invalid_artifact_path', 'Deliverables must be short relative file paths.');
  }
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) || normalized.includes(':') ||
      parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /^\.env(?:\.|$)/i.test(part))) {
    throw new BridgeError('invalid_artifact_path', 'Absolute, traversal, .git and .env paths are forbidden.');
  }
  return normalized;
}

/** Validate existing ancestors before mkdir: a symlink cannot redirect creation outside the allow root. */
export async function prepareWorkspace(value, allowedRoots) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !Array.isArray(allowedRoots) || !allowedRoots.length) {
    throw new BridgeError('invalid_workspace', 'An absolute workspace under an allowed workspace root is required.');
  }
  const candidate = path.resolve(value);
  const allowed = allowedRoots.map(root => path.resolve(root)).find(root => isWithin(root, candidate));
  if (!allowed) throw new BridgeError('workspace_not_allowed', 'Workspace is outside the configured workspace roots.');
  await fs.mkdir(allowed, { recursive: true, mode: 0o700 });
  const rootReal = await fs.realpath(allowed);
  let ancestor = candidate;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!isWithin(rootReal, real)) throw new BridgeError('workspace_escape', 'Workspace resolves outside its allowed root.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
  const real = await fs.realpath(candidate);
  if (!isWithin(rootReal, real)) throw new BridgeError('workspace_escape', 'Workspace resolves outside its allowed root.');
  return real;
}

async function readSafe(workspace, relative, maxBytes) {
  const filename = path.resolve(workspace, normalizeArtifactPath(relative));
  const workspaceReal = await fs.realpath(workspace);
  let real;
  try { real = await fs.realpath(filename); } catch (error) {
    if (error.code === 'ENOENT') throw new BridgeError('artifact_missing', `Declared artifact is missing: ${relative}`, 422);
    throw error;
  }
  if (!isWithin(workspaceReal, real)) throw new BridgeError('artifact_escape', 'Artifact resolves outside the workspace.', 422);
  // A harmless-looking alias must not expose a forbidden .env or .git target.
  normalizeArtifactPath(path.relative(workspaceReal, real));
  const handle = await fs.open(real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new BridgeError('artifact_not_file', 'Deliverable is not a regular file.', 422);
    if (stat.size > maxBytes) throw new BridgeError('artifact_too_large', `Artifact exceeds ${maxBytes} bytes.`, 422);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new BridgeError('artifact_too_large', `Artifact exceeds ${maxBytes} bytes.`, 422);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

export async function observeBefore(workspace, deliverables, maxBytes = 16 * 1024 * 1024) {
  const result = {};
  for (const relative of deliverables) {
    try { result[relative] = (await readSafe(workspace, relative, maxBytes)).sha256; }
    catch (error) {
      if (error.code !== 'artifact_missing') throw error;
      result[relative] = null;
    }
  }
  return result;
}

export async function snapshotArtifacts({ workspace, deliverables, directory, before = {}, maxBytes = 16 * 1024 * 1024, partial = false }) {
  const artifacts = [];
  const missing = [];
  const errors = [];
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (let index = 0; index < deliverables.length; index++) {
    const relative = normalizeArtifactPath(deliverables[index]);
    let data;
    try { data = await readSafe(workspace, relative, maxBytes); } catch (error) {
      if (!partial) throw error;
      if (error.code === 'artifact_missing') missing.push(relative);
      else errors.push({ path: relative, code: error instanceof BridgeError ? error.code : 'artifact_read_failed' });
      continue;
    }
    const { bytes, sha256 } = data;
    const snapshot = `${index}.bin`;
    await fs.writeFile(path.join(directory, snapshot), bytes, { mode: 0o600, flag: 'wx' });
    artifacts.push({ path: relative, size: bytes.length, sha256, snapshot, observed_at: new Date().toISOString(),
      changed: before[relative] !== undefined && before[relative] !== sha256, created: before[relative] === null,
      generation_evidence: before[relative] === null ? 'created_during_run' : before[relative] === sha256 ? 'unchanged_existing' :
        before[relative] === undefined ? 'baseline_unavailable' : 'changed_during_run', partial });
  }
  return partial ? { artifacts, missing, errors } : artifacts;
}

export async function readSnapshot(directory, artifact, runId) {
  const bytes = await fs.readFile(path.join(directory, artifact.snapshot));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== artifact.sha256) throw new BridgeError('snapshot_corrupt', 'Artifact snapshot failed its integrity check.', 500);
  const result = { path: artifact.path, run_id: runId, size: bytes.length, sha256, encoding: 'base64', content: bytes.toString('base64') };
  try { result.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Binary remains readable as bytes. */ }
  return result;
}
