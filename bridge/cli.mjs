#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, readEnv, initializeLocal } from './config.mjs';

const argv = process.argv.slice(2);
const command = argv.shift();
const flags = new Set(['--reuse-dsh-credential', '--force']);
const allowed = new Set(['--root', '--dsh-root', '--python', '--port', '--request', '--task', '--run', '--path', '--out', '--timeout-ms', '--decision', '--notes']);
const values = {};
for (let i = 0; i < argv.length; i++) {
  if (flags.has(argv[i])) values[argv[i]] = true;
  else if (allowed.has(argv[i]) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) values[argv[i]] = argv[++i];
  else throw new Error('Unknown or incomplete option: ' + argv[i]);
}
const root = resolve(values['--root'] ?? fileURLToPath(new URL('..', import.meta.url)));
const print = value => console.log(JSON.stringify(value, null, 2));
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const requestStdinLimit = 256 * 1024;

function stdinError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function requestFromStdin() {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      bytes += buffer.length;
      if (bytes > requestStdinLimit) throw stdinError('REQUEST_STDIN_TOO_LARGE');
      chunks.push(buffer);
    }
  } catch (error) {
    if (error.code === 'REQUEST_STDIN_TOO_LARGE') throw error;
    throw stdinError('REQUEST_STDIN_READ_FAILED');
  }
  let text;
  try {text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, bytes));}
  catch {throw stdinError('REQUEST_STDIN_INVALID_UTF8');}
  try {return JSON.parse(text);}
  catch {throw stdinError('REQUEST_STDIN_INVALID_JSON');}
}

async function main() {
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('DSH bridge: init | setup | start | serve | health | submit | fast | status | wait | result | artifact | continue | cancel | review | stop\nUse --request JSON_FILE for submit/continue/fast, or --request - for UTF-8 JSON on stdin (maximum 256 KiB); --task ID for task operations. No credential arguments.');
    return;
  }
  if (command === 'init') return print(await initializeLocal(root, {dshInstall: values['--dsh-root'], python: values['--python'], port: values['--port'] ? Number(values['--port']) : undefined, reuseDshCredential: Boolean(values['--reuse-dsh-credential'])}));
  const config = await loadConfig(root);
  const env = await readEnv(root);
  if (!env.BRIDGE_API_TOKEN || env.BRIDGE_API_TOKEN.length < 24) throw new Error('BRIDGE_TOKEN_MISSING');
  const base = `http://127.0.0.1:${config.port}`;
  const api = async (path, data, timeout = 10000) => {
    const response = await fetch(base + path, {method: data === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${env.BRIDGE_API_TOKEN}`}, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(timeout)});
    const envelope = await response.json();
    if (!response.ok || envelope.ok === false) {
      const error = new Error(envelope.error?.message ?? 'BRIDGE_REQUEST_FAILED');
      error.code = envelope.error?.code ?? 'BRIDGE_REQUEST_FAILED';
      throw error;
    }
    return envelope.result ?? envelope;
  };
  if (command === 'setup') {
    const {setupRuntime} = await import('./setup-runtime.mjs');
    const workspace = join(config.workspaceRoots[0], 'setup-check');
    await mkdir(workspace, {recursive: true});
    const state = await setupRuntime({projectRoot: root, workspace, home: join(config.runtimeHome, 'setup-check'), dshInstall: config.dshInstall, config});
    return print({prepared: true, profile: state.profile, versions: state.versions});
  }
  if (command === 'serve') {
    const {createBridgeServer} = await import('./server.mjs');
    const instance = await createBridgeServer({projectRoot: root, config, token: env.BRIDGE_API_TOKEN});
    await instance.start();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { instance.close().catch(() => {}).finally(() => process.exit(0)); });
    return;
  }
  if (command === 'start') {
    try { const state = await api('/health'); await api('/v1/tasks'); return print({started: false, health: state}); }
    catch (error) { if (error.code) throw error; }
    const runtime = join(root, 'runtime');
    await mkdir(runtime, {recursive: true});
    const log = openSync(join(runtime, 'bridge-daemon.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--root', root], {cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log]});
    closeSync(log);
    let launchError;
    child.once('error', error => { launchError = error; });
    child.unref();
    for (let n = 0; n < 75; n++) {
      if (launchError) throw new Error('BRIDGE_DAEMON_START_FAILED');
      await delay(200);
      try { const state = await api('/health'); await api('/v1/tasks'); return print({started: true, pid: child.pid, health: state}); } catch {}
    }
    throw new Error('BRIDGE_START_TIMEOUT_CHECK_LOCAL_LOG');
  }
  if (command === 'health') return print(await api('/health'));
  if (command === 'stop') return print(await api('/v1/shutdown', {force: Boolean(values['--force'])}));
  const request = async () => {
    if (!values['--request']) throw new Error('REQUEST_FILE_REQUIRED');
    if (values['--request'] === '-') return requestFromStdin();
    return JSON.parse(await readFile(resolve(values['--request']), 'utf8'));
  };
  if (command === 'submit') return print(await api('/v1/tasks', await request()));
  if (command === 'fast') {
    const envelope = await request();
    const {fast_review: reviewRequest, ...taskRequest} = envelope;
    const startedAt = new Date().toISOString();
    const receipt = await api('/v1/tasks', taskRequest);
    const taskId = receipt.task_id;
    const waitRun = async (runId) => {
      const deadline = Date.now() + Number(values['--timeout-ms'] ?? 50000);
      for (;;) {
        const state = await api('/v1/tasks/' + encodeURIComponent(taskId));
        const run = state.runs.find(item => item.run_id === runId);
        if (!run) throw new Error('RUN_NOT_FOUND');
        if (terminal.has(run.status)) return {state, run};
        if (Date.now() >= deadline) throw new Error('FAST_WAIT_TIMEOUT');
        await delay(100);
      }
    };
    const fetchRun = async runId => {
      const result = await api('/v1/tasks/' + encodeURIComponent(taskId) + '/result?run_id=' + encodeURIComponent(runId));
      const artifacts = {};
      for (const item of result.artifacts ?? []) artifacts[item.path] = await api('/v1/tasks/' + encodeURIComponent(taskId) + '/artifact?run_id=' + encodeURIComponent(runId) + '&path=' + encodeURIComponent(item.path));
      return {result, artifacts};
    };
    const runs = [];
    let current = await waitRun(receipt.run_id); runs.push(await fetchRun(current.run.run_id));
    if (reviewRequest) {
      const reviewPayload = {...reviewRequest, goal: reviewRequest.goal ?? reviewRequest.guidance}; delete reviewPayload.guidance;
      const reviewReceipt = await api('/v1/tasks/' + encodeURIComponent(taskId) + '/continue', reviewPayload);
      current = await waitRun(reviewReceipt.run_id); runs.push(await fetchRun(current.run.run_id));
    }
    return print({mode: 'fast', started_at: startedAt, finished_at: new Date().toISOString(), task_id: taskId, session_id: current.state.session_id, runs});
  }
  if (command === 'status' && !values['--task']) return print(await api('/v1/tasks'));
  if (!values['--task']) throw new Error('TASK_ID_REQUIRED');
  const taskPath = '/v1/tasks/' + encodeURIComponent(values['--task']);
  if (command === 'status') return print(await api(taskPath));
  if (command === 'continue') return print(await api(taskPath + '/continue', await request()));
  if (command === 'cancel') return print(await api(taskPath + '/cancel', {}));
  if (command === 'review') return print(await api(taskPath + '/review', {run_id: values['--run'], decision: values['--decision'], notes: values['--notes'] ?? ''}));
  if (command === 'wait') {
    const timeout = Number(values['--timeout-ms'] ?? 10000);
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 50000) throw new Error('WAIT_TIMEOUT_MUST_BE_0_TO_50000');
    const deadline = Date.now() + timeout;
    for (;;) {
      const state = await api(taskPath);
      const run = values['--run'] ? state.runs.find(run => run.run_id === values['--run']) : state.runs.at(-1);
      if (!run) throw new Error('RUN_NOT_FOUND');
      if (terminal.has(run.status) || Date.now() >= deadline) return print({done: terminal.has(run.status), task_id: state.task_id, session_id: state.session_id, session_closed: state.session_closed, run});
      await delay(Math.min(500, Math.max(1, deadline - Date.now())));
    }
  }
  const query = new URLSearchParams();
  if (values['--run']) query.set('run_id', values['--run']);
  if (command === 'result') return print(await api(taskPath + '/result?' + query));
  if (command === 'artifact') {
    if (!values['--path']) throw new Error('ARTIFACT_PATH_REQUIRED');
    query.set('path', values['--path']);
    const value = await api(taskPath + '/artifact?' + query);
    if (!values['--out']) return print(value);
    const output = resolve(values['--out']);
    await mkdir(dirname(output), {recursive: true});
    await writeFile(output, Buffer.from(value.content, 'base64'), {flag: 'wx'});
    return print({saved: output, size: value.size, sha256: value.sha256, run_id: value.run_id});
  }
  throw new Error('UNKNOWN_COMMAND');
}

main().catch(error => {
  // Report adapter-owned safe errors only. Never serialize config, environment or HTTP headers.
  print({ok: false, error: {code: error.code ?? 'BRIDGE_CLI_ERROR', message: /^[A-Z0-9_]+$/.test(error.message) || error.code ? error.message : 'Bridge command failed; check configuration and local service state.'}});
  process.exitCode = 1;
});
