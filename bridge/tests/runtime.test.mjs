import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime, PromptInterval } from '../runtime.mjs';
import { profilePatches, runtimeEnvironment, PROFILE_NAME } from '../runtime-config.mjs';
import { setupRuntime } from '../setup-runtime.mjs';

const notify = (interval, type, data, sessionId = 'task') => interval.notification('session.event', {sessionId, event: {type, data}});
function complete(interval, messageId = 'accepted', reason = 'completed') {
  notify(interval, 'turn/start', {turn: 0});
  notify(interval, 'user/message', {id: messageId});
  notify(interval, 'step/start', {turn: 0, step: 0});
  notify(interval, 'assistant/message', {message: {content: [{type: 'text', text: 'Produced a document.'}]}});
  notify(interval, 'turn/end', {turn: 0, reason: {kind: reason}});
  interval.notification('session.status', {sessionId: 'task', status: 'idle'});
}

test('receipt alone is not completion; wrong-session events cannot complete a task', async () => {
  const interval = new PromptInterval({sessionId: 'task'});
  interval.admitted({messageId: 'accepted'});
  assert.equal(interval.settled, undefined);
  notify(interval, 'turn/end', {reason: {kind: 'completed'}}, 'other');
  interval.notification('session.status', {sessionId: 'other', status: 'idle'});
  assert.equal(interval.settled, undefined);
  complete(interval);
  const result = await interval.promise;
  assert.equal(result.stopReason, 'completed'); assert.equal(result.messageId, 'accepted');
  assert.equal(result.finalResponse, 'Produced a document.');
  assert.ok(result.events.some(event => event.kind === 'model_response'));
});

test('notifications preceding the enqueue receipt still require matching accepted message identity', async () => {
  const interval = new PromptInterval({sessionId: 'task'}); complete(interval);
  assert.equal(interval.settled, undefined); interval.admitted({messageId: 'accepted'});
  assert.equal((await interval.promise).stopReason, 'completed');
  const mismatch = new PromptInterval({sessionId: 'task'}); complete(mismatch, 'unrelated'); mismatch.admitted({messageId: 'accepted'});
  await assert.rejects(mismatch.promise, {code: 'UNATTRIBUTED_RESULT'});
});

test('failed, interrupted, max-token, cancelled and disconnected intervals cannot report success', async () => {
  for (const reason of ['error', 'aborted', 'interrupted', 'max-tokens', 'blocked']) {
    const interval = new PromptInterval({sessionId: 'task'}); interval.admitted({messageId: 'accepted'}); complete(interval, 'accepted', reason);
    await assert.rejects(interval.promise, {code: 'MODEL_EXECUTION_FAILED', stopReason: reason});
  }
  const disconnected = new PromptInterval({sessionId: 'task'}); disconnected.admitted({messageId: 'accepted'});
  disconnected.fail('RUNTIME_DISCONNECTED', 'Disconnected'); complete(disconnected);
  await assert.rejects(disconnected.promise, {code: 'RUNTIME_DISCONNECTED'});
});

test('runtime refuses non-string session identifiers before touching deployment state', async () => {
  for (const sessionId of [null, undefined, 7, true, {}, ['task'], '', '../task']) {
    await assert.rejects(createRuntime({sessionId}), {code: 'INVALID_SESSION'});
  }
});

test('failed turns expose stable provider failure codes without raw provider messages', async () => {
  const interval = new PromptInterval({sessionId: 'task'}); interval.admitted({messageId: 'accepted'});
  notify(interval, 'user/message', {id: 'accepted'});
  notify(interval, 'turn/end', {turn: 0, reason: {kind: 'error', error: {code: 'REQUEST_EXTENSION', message: 'private raw diagnostic'}}});
  interval.notification('session.status', {sessionId: 'task', status: 'idle'});
  await assert.rejects(interval.promise, {code: 'MODEL_EXECUTION_FAILED', providerFailureCode: 'REQUEST_EXTENSION'});
  assert.equal(interval.events.find(event => event.kind === 'turn_end').providerFailureCode, 'REQUEST_EXTENSION');
  assert.ok(!JSON.stringify(interval.events).includes('private raw diagnostic'));
});

test('an interrupted assistant prefix cannot become success through a completed turn marker', async () => {
  const interval = new PromptInterval({sessionId: 'task'});
  interval.admitted({messageId: 'accepted'});
  notify(interval, 'user/message', {id: 'accepted'});
  notify(interval, 'step/start', {turn: 0, step: 0});
  notify(interval, 'assistant/message', {interrupted: true, message: {content: [{type: 'text', text: 'Partial answer'}]}});
  notify(interval, 'turn/end', {turn: 0, reason: {kind: 'completed'}});
  interval.notification('session.status', {sessionId: 'task', status: 'idle'});
  await assert.rejects(interval.promise, {code: 'INCOMPLETE_ASSISTANT_MESSAGE'});
  assert.equal(interval.finalResponse, undefined);
  assert.equal(interval.events.filter(event => event.kind === 'model_response').length, 0);
});

test('a later complete assistant message supersedes an interrupted prefix', async () => {
  const interval = new PromptInterval({sessionId: 'task'});
  interval.admitted({messageId: 'accepted'});
  notify(interval, 'user/message', {id: 'accepted'});
  notify(interval, 'step/start', {turn: 0, step: 0});
  notify(interval, 'assistant/message', {interrupted: true, message: {content: [{type: 'text', text: 'Partial answer'}]}});
  notify(interval, 'assistant/message', {message: {content: [{type: 'text', text: 'Complete replacement'}]}});
  notify(interval, 'turn/end', {turn: 0, reason: {kind: 'completed'}});
  interval.notification('session.status', {sessionId: 'task', status: 'idle'});
  assert.equal((await interval.promise).finalResponse, 'Complete replacement');
});

test('metadata preserves actual tool-call correlation without retaining private tool content', async () => {
  const interval = new PromptInterval({sessionId: 'task'});
  notify(interval, 'tool/call', {name: 'study_read', callId: 'c1', arguments: JSON.stringify({source_id: 'personal-example', resource_id: 'note'})});
  notify(interval, 'tool/result', {message: {content: [{type: 'tool-result', toolCallId: 'c1', content: [{type: 'text', text: 'private source body'}]}]}});
  assert.equal(interval.events[1].name, 'study_read'); assert.equal(interval.events[1].callId, 'c1');
  assert.equal(interval.events[1].isError, false); assert.ok(!JSON.stringify(interval.events).includes('private source body'));
});

test('profile disables shells, has no global instructions, gates sources, and reuses the existing input backend', () => {
  const patches = profilePatches({projectRoot: '/project', workspace: '/task'});
  assert.equal(patches.find(row => row.id === 'persistent-pwsh').disabled, true);
  assert.equal(patches.find(row => row.id === 'dsh-study-provider').config.autoStart, false);
  assert.ok(!JSON.stringify(patches).includes('agent-instructions'));
  const policy = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'bridge-runtime-policy');
  assert.deepEqual(policy.config.allowedStudySources, ['personal-example']);
});

test('child environment reads only the root .env credential and redacts it from diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-env-'));
  try {
    await writeFile(join(root, '.env'), 'DEEPSEEK_API_KEY=synthetic-project-credential\nSTUDY_API_TOKEN=synthetic-study-token\n');
    const {env, redact} = runtimeEnvironment(root, join(root, 'home'), {}, {PATH: '/bin', DEEPSEEK_API_KEY: 'inherited-credential', OTHER_API_KEY: 'inherited-other', NODE_OPTIONS: '--inspect'});
    assert.equal(env.DEEPSEEK_API_KEY, 'synthetic-project-credential'); assert.equal(env.OTHER_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.STUDY_API_TOKEN, undefined); assert.equal(redact('synthetic-study-token'), '[REDACTED]');
  } finally {assert.ok(root.startsWith(join(tmpdir(), 'dsh-bridge-env-'))); await rm(root, {recursive: true, force: true});}
});

test('official registry applies workspace read/write and source gates', {skip: !process.env.DSH_TEST_INSTALL}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-policy-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  let ctx;
  try {
    const deployment = await setupRuntime({projectRoot, workspace, home: join(root, 'home'), dshInstall: process.env.DSH_TEST_INSTALL});
    const mod = name => import(pathToFileURL(deployment.require.resolve(name)).href);
    const boot = await mod('@deepseek-ai/dsh-app-boot');
    await boot.healProfilesModuleFallback({installAnchor: deployment.anchor, profile: boot.loadProfile('dsh', PROFILE_NAME, deployment.anchor, deployment.home), home: deployment.home});
    const {Context} = await mod('@deepseek-ai/cordis'); const {default: SystemPrompt} = await mod('@deepseek-ai/dsh-system-prompt');
    const {default: Tools, defineTool} = await mod('@deepseek-ai/dsh-tools');
    const {default: WorkspaceFs} = await import(pathToFileURL(join(deployment.profile, 'node_modules/@yorhagengyue/dsh-bridge-fs/index.mjs')).href);
    const policy = await import(pathToFileURL(join(deployment.profile, 'node_modules/@yorhagengyue/dsh-bridge-policy/index.mjs')).href);
    const fileTools = await mod('@deepseek-ai/dsh-tool-fs'); ctx = new Context();
    await ctx.plugin(SystemPrompt, {includeHarnessIdentity: false}); await ctx.plugin(Tools, {mode: 'native'});
    await ctx.plugin(WorkspaceFs, {cwd: workspace}); await ctx.plugin(fileTools); await ctx.plugin(policy, {allowedStudySources: ['personal-example']});
    let touched = 0;
    ctx.tools.register(defineTool({name: 'study_read', description: 'Fixture source gate', parameters: {source_id: {type: 'string', required: true}}, output: {schema: {type: 'json'}, render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}]}, execute: () => {touched++; return {ok: true};}}));
    let id = 0; const call = (name, args) => ctx.tools.execute({callId: `test-${++id}`, name, arguments: args, signal: new AbortController().signal});
    assert.equal((await call('study_read', {source_id: 'canvas'})).isError, true); assert.equal(touched, 0);
    assert.equal((await call('study_read', {source_id: 'personal-example'})).isError, false); assert.equal(touched, 1);
    const written = await call('write', {file_path: 'deliverable.md', content: 'Synthetic artifact'});
    assert.equal(written.isError, false, JSON.stringify(written));
    assert.equal(await readFile(join(workspace, 'deliverable.md'), 'utf8'), 'Synthetic artifact');
    assert.equal((await call('read', {file_path: 'deliverable.md'})).isError, false);
    await writeFile(join(root, 'outside.md'), 'outside sentinel');
    assert.equal((await call('read', {file_path: join(root, 'outside.md')})).isError, true);
    assert.equal((await call('write', {file_path: '../outside.md', content: 'escaped'})).isError, true);
    await writeFile(join(workspace, '.env'), 'fixture credential');
    assert.equal((await call('read', {file_path: '.env'})).isError, true);
    assert.equal((await call('write', {file_path: '.ENV', content: 'cannot replace credential'})).isError, true);
    // Directory symlinks are junctions on Windows; both platforms exercise canonical escape denial.
    await symlink(root, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await call('read', {file_path: 'escape/outside.md'})).isError, true);
    assert.equal(await readFile(join(root, 'outside.md'), 'utf8'), 'outside sentinel');
  } finally {
    await ctx?.fiber.dispose(); assert.ok(root.startsWith(join(tmpdir(), 'dsh-bridge-policy-'))); await rm(root, {recursive: true, force: true});
  }
});

test('full official Loader profile prepares DeepSeek request extensions without a model call', {skip: !process.env.DSH_TEST_INSTALL}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-extensions-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  let ctx;
  try {
    const deployment = await setupRuntime({projectRoot, workspace, home: join(root, 'home'), dshInstall: process.env.DSH_TEST_INSTALL});
    const boot = await import(pathToFileURL(deployment.require.resolve('@deepseek-ai/dsh-app-boot')).href);
    const profile = boot.loadProfile('dsh', PROFILE_NAME, deployment.anchor, deployment.home);
    await boot.healProfilesModuleFallback({installAnchor: deployment.anchor, profile, home: deployment.home});
    const rootConfig = join(deployment.profile, 'cordis.yml'); await writeFile(rootConfig, '[]\n');
    const patches = [...profile.layers.flatMap(layer => layer.patches), ...profile.patches,
      {id: 'sdk-app-startup', disabled: true}, {id: 'sdk-jsonrpc-server', disabled: true},
      {id: 'sessions', config: {root: join(root, 'sessions'), compression: 'none'}}];
    ctx = await boot.boot('dsh', rootConfig, patches);
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({body: {model: 'deepseek-flash', messages: []}, signal: new AbortController().signal});
    const packages = prepared.fields.dsh_plugin_packages.packages;
    for (const name of ['@yorhagengyue/dsh-bridge-fs', '@yorhagengyue/dsh-bridge-policy', '@yorhagengyue/dsh-study']) {
      assert.ok(packages.some(pkg => pkg.name === name && pkg.version === '0.1.0'), `Missing valid request inventory identity: ${name}`);
    }
    assert.equal(prepared.fields.dsh_session_log, undefined);
    assert.ok(ctx.tools.schemas().some(tool => tool.name === 'study_read'));
  } finally {
    await ctx?.fiber.dispose(); assert.ok(root.startsWith(join(tmpdir(), 'dsh-bridge-extensions-'))); await rm(root, {recursive: true, force: true});
  }
});
