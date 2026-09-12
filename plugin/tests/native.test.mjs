import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import StudyService, {StudyError} from '../service.mjs';
import * as provider from '../provider.mjs';
import * as consumer from '../tools.mjs';
import { runPendingProbe } from '../verify-probe.mjs';

test('official native pipeline validates, renders, cancels and disposes input tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-study-native-'));
  const ctx = new Context();
  const received = [];
  try {
    await ctx.plugin(SystemPrompt, {includeHarnessIdentity: false});
    await ctx.plugin(ToolRuntime, {mode: 'native'});
    await ctx.plugin(StudyService);
    await ctx.plugin(Object.assign(ctx => ctx.study.registerProvider({id: 'fixture', async call(operation, args, signal) {
      signal.throwIfAborted(); received.push(operation);
      if (args.resource_id === 'missing') throw new StudyError('Resource unavailable', 'unavailable');
      return {operation, args, text: 'Synthetic lesson'};
    }}), {inject: ['study']}));
    const tools = ctx.plugin(consumer, {projectRoot: root});
    await tools;
    const events = [];
    ctx.on('tools/result', (exec, result) => events.push({name: exec.name, error: result.isError}));
    assert.equal(ctx.tools.schemas().filter(tool => tool.name.startsWith('study_')).length, 7);
    const valid = {callId: 'test-1', name: 'study_read', arguments: {source_id: 'local', course_id: 'personal', resource_id: 'note'}, signal: new AbortController().signal};
    const result = await ctx.tools.execute(valid);
    assert.equal(result.isError, false);
    assert.equal(result.value.text, 'Synthetic lesson');
    assert.equal(JSON.parse(result.content[0].text).text, 'Synthetic lesson');
    const invalid = await ctx.tools.execute({...valid, callId: 'test-2', arguments: {source_id: 'local'}});
    assert.equal(invalid.isError, true);
    const cancelled = await ctx.tools.execute({...valid, callId: 'test-3', signal: AbortSignal.abort()});
    assert.equal(cancelled.isError, true);
    assert.deepEqual(received, ['read']);
    assert.equal(events.length, 3);
    const unavailable = await ctx.tools.execute({...valid, callId: 'test-4', arguments: {...valid.arguments, resource_id: 'missing'}});
    assert.equal(unavailable.isError, true);
    assert.equal(unavailable.error.info.code, 'unavailable');
    await tools.dispose();
    assert.equal(ctx.tools.schemas().filter(tool => tool.name.startsWith('study_')).length, 0);
  } finally {
    await ctx.fiber.dispose();
    // mkdtemp returned an absolute, unique test-owned child of the system temp root.
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-study-native-')));
    await rm(root, {recursive: true, force: true});
  }
});

test('provider authenticates the actual HTTP exchange and rejects another project on its port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-study-provider-'));
  await writeFile(join(root, '.env'), 'STUDY_API_TOKEN=synthetic-test-token\n', 'utf8');
  let mismatch = false;
  let authenticated = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({service: 'dsh-study', project_root: mismatch ? tmpdir() : root}));
    assert.equal(req.headers.authorization, 'Bearer synthetic-test-token');
    authenticated++;
    let body = ''; for await (const part of req) body += part;
    const {operation} = JSON.parse(body);
    res.end(JSON.stringify({ok: true, result: {operation, sources: [{id: 'fixture'}]}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ctx = new Context();
  try {
    await ctx.plugin(StudyService);
    await ctx.plugin(provider, {projectRoot: root, backendPort: server.address().port, autoStart: false});
    const value = await ctx.study.call('sources', {}, new AbortController().signal);
    assert.equal(value.sources[0].id, 'fixture');
    assert.equal(authenticated, 2);
    mismatch = true;
    await assert.rejects(ctx.study.call('sources', {}, new AbortController().signal), {code: 'STUDY_BACKEND_MISMATCH'});
  } finally {
    await ctx.fiber.dispose();
    await new Promise(resolve => server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-study-provider-')));
    await rm(root, {recursive: true, force: true});
  }
});

test('opt-in live-host probe exercises local input jobs through all seven tools and never refreshes Canvas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-study-probe-'));
  const ctx = new Context();
  const mutations = [];
  try {
    await ctx.plugin(SystemPrompt, {includeHarnessIdentity: false});
    await ctx.plugin(ToolRuntime, {mode: 'native'});
    await ctx.plugin(StudyService);
    await ctx.plugin(Object.assign(ctx => ctx.study.registerProvider({id: 'fixture', async call(operation, args) {
      if (operation === 'sources') return {sources: [{source_id: 'personal', type: 'local'}, {source_id: 'canvas', type: 'canvas'}]};
      if (operation === 'import_local' || operation === 'refresh') {
        mutations.push({operation, source_id: args.source_id});
        assert.equal(args.source_id, 'personal');
        return {job_id: `test-${operation}`, status: 'running'};
      }
      if (operation === 'status') return {job_id: args.job_id, status: 'completed'};
      if (operation === 'courses') return {courses: [{course_id: 'example'}]};
      if (operation === 'catalog') return {resources: [{resource_id: 'note', status: 'ready'}]};
      if (operation === 'read') return {text: 'Synthetic 12 apples', text_available: true};
      throw new Error('Unexpected operation');
    }}), {inject: ['study']}));
    // Keep the consumer's automatic check separate; this test explicitly invokes the same probe function.
    await ctx.plugin(consumer, {projectRoot: join(root, 'no-automatic-request')});
    await mkdir(join(root, 'runtime'));
    const request = {id: 'local-input-test', created_at: new Date().toISOString(), exercise_local_import: true,
      sources: [{source_id: 'personal', sentinel: '12'}, {source_id: 'canvas'}, {source_id: 'personal'}]};
    await writeFile(join(root, 'runtime', 'verify-request.json'), JSON.stringify(request), 'utf8');
    await runPendingProbe(ctx, root, new AbortController().signal);
    const report = JSON.parse(await readFile(join(root, 'runtime', 'verify-result.json'), 'utf8'));
    assert.equal(report.ok, true);
    assert.deepEqual(mutations, [{operation: 'import_local', source_id: 'personal'}, {operation: 'refresh', source_id: 'personal'}]);
    assert.equal(report.local_exercises.length, 2);
    assert.equal(new Set(report.events.map(event => event.name)).size, 7);
    assert.ok(report.local_exercises.every(job => job.status === 'completed'));
    // A second default request must leave local and Canvas sources read-only.
    request.id = 'read-only-test';
    delete request.exercise_local_import;
    await writeFile(join(root, 'runtime', 'verify-request.json'), JSON.stringify(request), 'utf8');
    await runPendingProbe(ctx, root, new AbortController().signal);
    assert.equal(mutations.length, 2);
    const defaultReport = JSON.parse(await readFile(join(root, 'runtime', 'verify-result.json'), 'utf8'));
    assert.equal(defaultReport.ok, true);
    assert.equal(defaultReport.local_exercises.length, 0);
  } finally {
    await ctx.fiber.dispose();
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-study-probe-')));
    await rm(root, {recursive: true, force: true});
  }
});
