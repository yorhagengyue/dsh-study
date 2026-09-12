import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import z from '@deepseek-ai/schemastery';
import { StudyError } from './service.mjs';

export const inject = ['study'];
export const Config = z.object({
  projectRoot: z.string().required(),
  python: z.string().default('python'),
  backendPort: z.number().min(1024).max(65535).default(8766),
  autoStart: z.boolean().default(true),
});

function readToken(root) {
  const line = readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).find(line => /^\s*STUDY_API_TOKEN\s*=/.test(line));
  const raw = line?.slice(line.indexOf('=') + 1).trim() ?? '';
  const token = raw.replace(/^(["'])(.*)\1$/, '$2');
  if (!token || /[\r\n]/.test(token)) throw new StudyError('Set STUDY_API_TOKEN in the ignored project-root .env', 'STUDY_TOKEN_MISSING');
  return token;
}

/** Provider: authenticated loopback transport; owns only the Python child it starts. */
export function apply(ctx, config) {
  const projectRoot = realpathSync(config.projectRoot);
  const token = readToken(projectRoot);
  const base = `http://127.0.0.1:${config.backendPort ?? 8766}`;
  const lifecycle = new AbortController();
  let child;
  let starting;

  const stop = () => { lifecycle.abort(); if (child && child.exitCode === null) child.kill(); };
  ctx.effect(() => {
    process.once('exit', stop);
    return () => { process.removeListener('exit', stop); stop(); };
  });

  async function health(signal) {
    try {
      const response = await fetch(`${base}/health`, {signal: AbortSignal.any([signal, AbortSignal.timeout(1500)])});
      if (!response.ok) return false;
      const value = await response.json();
      const canonical = path => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path);
      if (value.service !== 'dsh-study' || !value.project_root || canonical(value.project_root) !== canonical(projectRoot)) {
        throw new StudyError('Backend port belongs to a different project', 'STUDY_BACKEND_MISMATCH');
      }
      // The public health endpoint is not proof that this provider is authorized.
      const auth = await fetch(`${base}/api/call`, {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body: JSON.stringify({operation: 'sources', arguments: {}}), signal,
      });
      if (!auth.ok) throw new StudyError('Backend rejected project authentication', 'STUDY_BACKEND_AUTH');
      return true;
    } catch (error) {
      if (error instanceof StudyError) throw error;
      signal.throwIfAborted();
      return false;
    }
  }

  async function ensure(signal) {
    if (await health(signal)) return;
    if (!config.autoStart && config.autoStart !== undefined) throw new StudyError('Study backend is not running', 'STUDY_BACKEND_OFFLINE');
    if (!starting) {
      starting = (async () => {
        const env = {};
        for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']) {
          if (process.env[key]) env[key] = process.env[key];
        }
        env.PYTHONPATH = projectRoot;
        env.PYTHONIOENCODING = 'utf-8';
        child = spawn(config.python ?? 'python', ['-m', 'dsh_study', 'serve', '--root', projectRoot, '--port', String(config.backendPort ?? 8766), '--parent-pid', String(process.pid)], {
          cwd: projectRoot, env, windowsHide: true, stdio: 'ignore',
        });
        let launchError = false;
        child.once('error', () => { launchError = true; });
        for (let n = 0; n < 80; n++) {
          lifecycle.signal.throwIfAborted();
          if (launchError || child.exitCode !== null) throw new StudyError('Python backend failed to start; run its documented CLI for diagnosis', 'STUDY_BACKEND_START');
          if (await health(lifecycle.signal)) return;
          await delay(200, undefined, {signal: lifecycle.signal});
        }
        throw new StudyError('Python backend startup timed out', 'STUDY_BACKEND_START');
      })().catch(error => {
        if (child && child.exitCode === null) child.kill();
        throw error;
      }).finally(() => { starting = undefined; });
    }
    // Finish owned startup before settling cancellation; do not abandon a child launch.
    await starting;
    signal.throwIfAborted();
  }

  ctx.study.registerProvider({
    id: 'python-local',
    async call(operation, args, callerSignal) {
      const signal = AbortSignal.any([callerSignal, lifecycle.signal]);
      await ensure(signal);
      let response;
      try {
        response = await fetch(`${base}/api/call`, {
          method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
          body: JSON.stringify({operation, arguments: args}), signal,
        });
      } catch {
        signal.throwIfAborted();
        throw new StudyError('Cannot reach the study backend', 'STUDY_BACKEND_OFFLINE');
      }
      const envelope = await response.json().catch(() => null);
      if (!response.ok || !envelope?.ok) {
        // Backend errors have already been sanitized; never include transport headers or raw response bodies.
        throw new StudyError(envelope?.error?.message ?? 'Study backend request failed', envelope?.error?.code ?? 'STUDY_BACKEND_ERROR');
      }
      return envelope.result;
    },
  });
}
