import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridgeServer } from '../server.mjs';
import { TaskStore } from '../store.mjs';

const token = 'test-only-bridge-authentication-token-1234';
async function fixture(t, behavior = async ({ workspace, count }) => {
  await fs.writeFile(path.join(workspace, 'report.md'), `Synthetic source. Revision ${count}.`);
}, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-broker-'));
  const allowed = path.join(root, 'workspaces');
  const calls = []; const instances = [];
  const factory = async args => {
    const sessionId = args.sessionId; let count = 0; let closed = false;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    const instance = { sessionId, async initialize() { return { sessionId, provider: 'test', model: 'fake' }; },
      async prompt(prompt, { signal, requestId }) {
        count++; calls.push({ sessionId, count, requestId, prompt });
        args.onEvent({ kind: 'receipt', messageId: requestId, sessionId });
        args.onEvent({ kind: 'model_start', sessionId });
        const output = await behavior({ ...args, count, signal, sessionId });
        args.onEvent({ kind: 'model_response', sessionId });
        return { sessionId, messageId: requestId, finalResponse: 'Ready for caller review.', stopReason: 'completed', ...output };
      }, async close() { closed = true; }, get closed() { return closed; } };
    instances.push(instance); return instance;
  };
  const config = { port: 0, workspaceRoots: [allowed], runtimeHome: path.join(root, 'homes'), runTimeoutMs: 3000, ...overrides };
  const broker = await createBridgeServer({ projectRoot: root, config, token, createRuntime: factory });
  const address = await broker.start();
  const url = `http://127.0.0.1:${address.port}`;
  const api = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const taskInput = (extra = {}) => ({ request_id: randomUUID(), goal: 'Read the synthetic material and write a brief report.',
    workspace: path.join(allowed, randomUUID()), deliverables: ['report.md'], ...extra });
  const finished = async id => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await api(`/v1/tasks/${id}`);
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(response.result.status) && !response.result.active_run_id) return response.result;
      await delay(10);
    }
    throw new Error('Test execution did not finish');
  };
  t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, allowed, broker, api, taskInput, finished, calls, instances, factory, config };
}

test('authenticated durable submit survives no client connection, deduplicates, and exposes real artifact bytes pending review', async t => {
  const f = await fixture(t, async ({ workspace }) => { await delay(40); await fs.writeFile(path.join(workspace, 'report.md'), 'Source: synthetic-material.md\nVerified content.'); });
  assert.equal((await f.api('/v1/tasks', 'GET', undefined, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.api('/health', 'GET', undefined, { origin: 'http://untrusted.example' })).status, 403);
  const input = f.taskInput();
  const [first, duplicate] = await Promise.all([f.api('/v1/tasks', 'POST', input), f.api('/v1/tasks', 'POST', input)]);
  assert.equal(first.status, 202); assert.equal(duplicate.status, 202);
  assert.equal(first.result.task_id, duplicate.result.task_id);
  assert.equal((await f.api('/v1/tasks', 'POST', { ...input, goal: 'Different goal' })).status, 409);
  // POST has ended; no HTTP request is held open while the background executor works.
  await delay(70);
  const task = await f.finished(first.result.task_id);
  assert.equal(task.status, 'completed'); assert.equal(f.calls.length, 1);
  assert.equal(task.runs[0].review.status, 'pending');
  assert.ok(task.runs[0].facts.acceptedAt); assert.ok(task.runs[0].facts.receiptAt);
  assert.ok(task.runs[0].facts.modelStartedAt); assert.ok(task.runs[0].facts.artifactObservedAt);
  assert.ok(task.runs[0].facts.modelRespondedAt);
  const artifact = await f.api(`/v1/tasks/${task.task_id}/artifact?path=report.md`);
  assert.match(artifact.result.text, /Source: synthetic-material.md/);
  assert.equal(artifact.result.size, Buffer.from(artifact.result.content, 'base64').length);
  assert.equal((await f.api(`/v1/tasks/${task.task_id}/artifact?path=.env`)).status, 400);
  assert.equal((await f.api(`/v1/tasks/${task.task_id}/artifact?path=undeclared.md`)).status, 404);
});

test('correction preserves task/session identity and old snapshot, while caller review is explicit and per run', async t => {
  const f = await fixture(t);
  const accepted = await f.api('/v1/tasks', 'POST', f.taskInput());
  const task = await f.finished(accepted.result.task_id);
  const firstRun = task.runs[0].run_id;
  const correction = { request_id: randomUUID(), goal: 'Add one clear source sentence.' };
  const second = await f.api(`/v1/tasks/${task.task_id}/continue`, 'POST', correction);
  assert.equal(second.status, 202);
  const updated = await f.finished(task.task_id);
  assert.equal(updated.runs.length, 2);
  assert.equal(updated.session_id, task.session_id);
  assert.equal(f.instances.length, 1);
  assert.equal(f.calls[0].sessionId, f.calls[1].sessionId);
  const original = await f.api(`/v1/tasks/${task.task_id}/artifact?path=report.md&run_id=${firstRun}`);
  const revised = await f.api(`/v1/tasks/${task.task_id}/artifact?path=report.md`);
  assert.match(original.result.text, /Revision 1/); assert.match(revised.result.text, /Revision 2/);
  assert.notEqual(original.result.sha256, revised.result.sha256);
  assert.equal((await f.api(`/v1/tasks/${task.task_id}/continue`, 'POST', correction)).result.duplicate, true);
  assert.equal(f.calls.length, 2);
  const review = await f.api(`/v1/tasks/${task.task_id}/review`, 'POST', { run_id: second.result.run_id, decision: 'accepted', notes: 'Checked source and actual bytes.' });
  assert.equal(review.result.review.status, 'accepted');
  const finalTask = (await f.api(`/v1/tasks/${task.task_id}`)).result;
  assert.equal(finalTask.runs[0].review.status, 'pending');
});

test('simultaneous tasks use different runtimes; active correction and overlapping workspace are rejected', async t => {
  const f = await fixture(t, async ({ workspace }) => { await delay(60); await fs.writeFile(path.join(workspace, 'report.md'), 'Done'); }, { maxConcurrent: 2 });
  const input = f.taskInput();
  const a = await f.api('/v1/tasks', 'POST', input);
  const b = await f.api('/v1/tasks', 'POST', f.taskInput());
  assert.equal((await f.api('/v1/tasks', 'POST', { ...input, request_id: randomUUID() })).status, 409);
  assert.equal((await f.api(`/v1/tasks/${a.result.task_id}/continue`, 'POST', { request_id: randomUUID(), goal: 'Change while active' })).status, 409);
  const [aDone, bDone] = await Promise.all([f.finished(a.result.task_id), f.finished(b.result.task_id)]);
  assert.notEqual(aDone.session_id, bDone.session_id);
  assert.equal(f.calls.length, 2);
});

test('missing artifacts and unsuccessful official stop reason remain failed, with available partial files retained', async t => {
  const f = await fixture(t, async ({ workspace }) => { await fs.writeFile(path.join(workspace, 'report.md'), 'Partial output'); });
  const accepted = await f.api('/v1/tasks', 'POST', f.taskInput({ deliverables: ['report.md', 'missing.md'] }));
  const task = await f.finished(accepted.result.task_id);
  assert.equal(task.status, 'failed'); assert.equal(task.runs[0].error.code, 'artifact_missing');
  assert.deepEqual(task.runs[0].missing_artifacts, ['missing.md']);
  assert.equal(task.runs[0].artifacts[0].partial, true);
  assert.equal((await f.api(`/v1/tasks/${task.task_id}/artifact?path=report.md`)).result.text, 'Partial output');
  assert.equal((await f.api(`/v1/tasks/${task.task_id}/review`, 'POST', { run_id: task.runs[0].run_id, decision: 'accepted', notes: '' })).status, 409);
  const g = await fixture(t, async ({ workspace }) => { await fs.writeFile(path.join(workspace, 'report.md'), 'Incomplete turn'); return { stopReason: 'error' }; });
  const admitted = await g.api('/v1/tasks', 'POST', g.taskInput());
  const failed = await g.finished(admitted.result.task_id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.runs[0].error.code, 'execution_not_completed');
  assert.equal(failed.runs[0].artifacts[0].partial, true);
});

test('cancel closes only its runtime, captures partial bytes and cannot be continued as the same session', async t => {
  const f = await fixture(t, async ({ workspace, signal }) => {
    await fs.writeFile(path.join(workspace, 'report.md'), 'Partly generated');
    await delay(1000, undefined, { signal });
  });
  const accepted = await f.api('/v1/tasks', 'POST', f.taskInput());
  while (!f.calls.length) await delay(5);
  await delay(10);
  const cancelled = await f.api(`/v1/tasks/${accepted.result.task_id}/cancel`, 'POST', {});
  assert.equal(cancelled.status, 200);
  await delay(20);
  const task = await f.finished(accepted.result.task_id);
  assert.equal(task.status, 'cancelled'); assert.equal(task.session_closed, true); assert.equal(f.instances[0].closed, true);
  assert.equal(task.runs[0].artifacts[0].partial, true);
  assert.equal((await f.api(`/v1/tasks/${task.task_id}/continue`, 'POST', { request_id: randomUUID(), goal: 'Continue' })).status, 409);
});

test('timeout and broker restart are interrupted/failed, never replayed or accepted as completed', async t => {
  const f = await fixture(t, async ({ signal }) => { await delay(1000, undefined, { signal }); }, { runTimeoutMs: 30 });
  const accepted = await f.api('/v1/tasks', 'POST', f.taskInput());
  const task = await f.finished(accepted.result.task_id);
  assert.equal(task.status, 'failed'); assert.equal(task.runs[0].error.code, 'execution_timeout');
  const directory = path.join(f.root, 'restart-state');
  const store = new TaskStore(directory);
  store.state.tasks.example = { task_id: 'example', session_closed: false, active_run_id: 'run', runs: [{ run_id: 'run', status: 'running', facts: {} }] };
  store.save();
  const recovered = new TaskStore(directory).get('example');
  assert.equal(recovered.runs[0].status, 'interrupted');
  assert.equal(recovered.runs[0].error.code, 'broker_restarted');
  assert.equal(recovered.session_closed, true);
});

test('restart keeps completed artifacts readable but refuses same-session continuation; shutdown rejects active work', async t => {
  const f = await fixture(t);
  const accepted = await f.api('/v1/tasks', 'POST', f.taskInput());
  const task = await f.finished(accepted.result.task_id);
  await f.broker.close();
  const restarted = await createBridgeServer({ projectRoot: f.root, config: f.config, token, createRuntime: f.factory });
  const address = await restarted.start();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/tasks/${task.task_id}/continue`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: randomUUID(), goal: 'Try to resume after process restart' }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'session_closed');
  assert.equal(restarted.store.get(task.task_id).runs[0].status, 'completed');
  await restarted.close();
  const g = await fixture(t, async ({ signal }) => { await delay(1000, undefined, { signal }); });
  await g.api('/v1/tasks', 'POST', g.taskInput());
  assert.equal((await g.api('/v1/shutdown', 'POST', {})).status, 409);
});

test('a live session retains workspace ownership until explicitly closed', async t => {
  const f = await fixture(t);
  const input = f.taskInput();
  const admitted = await f.api('/v1/tasks', 'POST', input);
  const task = await f.finished(admitted.result.task_id);
  assert.equal(task.status, 'completed');
  assert.equal((await f.api('/v1/tasks', 'POST', { ...input, request_id: randomUUID() })).status, 409);
  const closed = await f.api(`/v1/tasks/${task.task_id}/cancel`, 'POST', {});
  assert.equal(closed.result.runtime_process_exited, true);
  assert.ok(closed.result.runtime_closed_at);
  const next = await f.api('/v1/tasks', 'POST', { ...input, request_id: randomUUID() });
  assert.equal(next.status, 202);
  const nextTask = await f.finished(next.result.task_id);
  assert.equal(nextTask.runs[0].artifacts[0].changed, false);
  assert.equal(nextTask.runs[0].artifacts[0].generation_evidence, 'unchanged_existing');
});

test('a second broker cannot mark the live owners tasks interrupted before its listen fails', async t => {
  const f = await fixture(t, async ({ workspace }) => { await delay(80); await fs.writeFile(path.join(workspace, 'report.md'), 'Done'); });
  const admitted = await f.api('/v1/tasks', 'POST', f.taskInput());
  await assert.rejects(createBridgeServer({ projectRoot: f.root, config: f.config, token, createRuntime: f.factory }), /already owned/);
  const done = await f.finished(admitted.result.task_id);
  assert.equal(done.status, 'completed');
});

test('cancel remains cancelling until process exit and partial capture finish', async t => {
  const f = await fixture(t, async ({ workspace, signal }) => {
    await fs.writeFile(path.join(workspace, 'report.md'), 'partial');
    await delay(1000, undefined, { signal });
  });
  const admitted = await f.api('/v1/tasks', 'POST', f.taskInput());
  while (!f.calls.length) await delay(5);
  const originalClose = f.instances[0].close;
  f.instances[0].close = async () => { await delay(80); await originalClose(); };
  const cancellation = f.api(`/v1/tasks/${admitted.result.task_id}/cancel`, 'POST', {});
  await delay(15);
  const during = (await f.api(`/v1/tasks/${admitted.result.task_id}`)).result;
  assert.equal(during.status, 'cancelling');
  assert.equal(during.runtime_process_exited, false);
  assert.equal(during.runs[0].facts.finishedAt, null);
  assert.equal((await f.api(`/v1/tasks/${during.task_id}/result`)).status, 409);
  const after = (await cancellation).result;
  assert.equal(after.status, 'cancelled');
  assert.equal(after.runtime_process_exited, true);
  assert.ok(after.runs[0].facts.finishedAt);
  assert.equal(after.runs[0].artifacts[0].partial, true);
});

test('runtime failures retain only allowlisted diagnostic codes and stop reasons, never raw secret messages', async t => {
  const secret = 'sensitive-private-diagnostic-not-for-api';
  const f = await fixture(t, async ({ onEvent }) => {
    onEvent({ kind: 'turn_end', stopReason: 'error', providerFailureCode: 'REQUEST_EXTENSION' });
    onEvent({ kind: 'turn_end', providerFailureCode: secret });
    throw Object.assign(new Error(`Upstream request rejected with ${secret}`), {
      name: 'RuntimeError', code: 'MODEL_EXECUTION_FAILED', stopReason: 'error', providerFailureCode: 'REQUEST_EXTENSION', details: { credential: secret },
    });
  });
  const admitted = await f.api('/v1/tasks', 'POST', f.taskInput());
  const task = await f.finished(admitted.result.task_id);
  assert.equal(task.status, 'failed');
  assert.equal(task.runs[0].error.code, 'MODEL_EXECUTION_FAILED');
  assert.equal(task.runs[0].error.stopReason, 'error');
  assert.equal(task.runs[0].error.providerFailureCode, 'REQUEST_EXTENSION');
  assert.equal(task.runs[0].events.find(event => event.kind === 'turn_end').providerFailureCode, 'REQUEST_EXTENSION');
  assert.ok(task.runs[0].facts.modelStartedAt);
  assert.equal(task.runs[0].facts.modelRespondedAt, null);
  assert.ok(!JSON.stringify(task).includes(secret));
  assert.ok(!(await fs.readFile(path.join(f.root, 'runtime', 'bridge', 'tasks.json'), 'utf8')).includes(secret));
  const g = await fixture(t, async () => { throw Object.assign(new Error(secret), { name: 'RuntimeError', code: secret, stopReason: secret, providerFailureCode: secret }); });
  const unknown = await g.api('/v1/tasks', 'POST', g.taskInput());
  const unknownTask = await g.finished(unknown.result.task_id);
  assert.equal(unknownTask.runs[0].error.code, 'runtime_error');
  assert.equal(unknownTask.runs[0].error.stopReason, undefined);
  assert.ok(!JSON.stringify(unknownTask).includes(secret));
});
