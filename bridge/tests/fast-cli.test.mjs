import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function fixture(options, action) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fast-test-'));
  const calls = [];
  let runId = 'run-1';
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({url: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null});
    let result;
    if (req.url === '/v1/tasks') result = {task_id: 'task-1', run_id: runId};
    else if (req.url.endsWith('/continue')) {
      if (options.continueError) {res.writeHead(400); res.end(JSON.stringify({ok: false, error: {code: 'SELF_CHECK_REJECTED'}})); return;}
      runId = 'run-2'; result = {task_id: 'task-1', run_id: runId};
    } else if (req.url.includes('/result?')) result = {run_id: runId, artifacts: [{path: 'result.md'}], final_response: 'visible response'};
    else if (req.url.includes('/artifact?')) result = {content: Buffer.from('actual artifact').toString('base64')};
    else result = {task_id: 'task-1', session_id: 'session-1', runs: [{run_id: runId, status: options.status ?? 'completed'}]};
    res.end(JSON.stringify({ok: true, result}));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await writeFile(join(root, '.env'), 'BRIDGE_API_TOKEN=synthetic-fast-cli-test-token\n');
    await writeFile(join(root, 'bridge.local.json'), JSON.stringify({port: server.address().port, dshInstall: root, runtimeHome: root, workspaceRoots: [root]}));
    const invoke = (request, timeout = '50000') => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'fast', '--root', root, '--request', '-', '--timeout-ms', timeout], {windowsHide: true});
      let output = ''; child.stdout.on('data', chunk => {output += chunk;});
      child.once('error', reject); child.stdin.on('error', () => {});
      child.once('close', code => {try {resolve({code, output: JSON.parse(output)});} catch (error) {reject(error);}});
      child.stdin.end(JSON.stringify(request));
    });
    await action({invoke, calls});
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-fast-test-')));
    await rm(root, {recursive: true, force: true});
  }
}

test('fast rejects non-finite and out-of-range timeout before submitting', async () => {
  await fixture({}, async ({invoke, calls}) => {
    for (const timeout of ['NaN', 'Infinity', '-1', '50001']) {
      const result = await invoke({goal: 'read source'}, timeout);
      assert.equal(result.code, 1); assert.equal(result.output.error.message, 'WAIT_TIMEOUT_MUST_BE_0_TO_50000');
    }
    assert.equal(calls.length, 0);
  });
});

test('zero timeout preserves submitted receipt and last state for later retrieval', async () => {
  await fixture({status: 'running'}, async ({invoke, calls}) => {
    const {code, output} = await invoke({goal: 'read source'}, '0');
    assert.equal(code, 1); assert.equal(output.error.code, 'FAST_WAIT_TIMEOUT');
    assert.equal(output.receipt.run_id, 'run-1'); assert.equal(output.last_state.runs[0].status, 'running');
    assert.equal(output.caller_review, 'pending'); assert.equal(calls.length, 2);
  });
});

test('failed initial run preserves actual result and never self-checks or accepts', async () => {
  await fixture({status: 'failed'}, async ({invoke, calls}) => {
    const {code, output} = await invoke({goal: 'read source', fast_review: {goal: 'check output'}});
    assert.equal(code, 1); assert.equal(output.error.code, 'FAST_RUN_NOT_COMPLETED');
    assert.equal(output.runs[0].result.final_response, 'visible response');
    assert.equal(Buffer.from(output.runs[0].artifacts['result.md'].content, 'base64').toString(), 'actual artifact');
    assert.ok(!calls.some(call => /continue|review/.test(call.url)));
  });
});

test('optional self-check rejection retains original result and receipt', async () => {
  await fixture({continueError: true}, async ({invoke}) => {
    const {code, output} = await invoke({goal: 'read source', fast_review: {goal: 'check output'}});
    assert.equal(code, 1); assert.equal(output.error.code, 'SELF_CHECK_REJECTED');
    assert.equal(output.receipt.run_id, 'run-1'); assert.equal(output.runs.length, 1);
    assert.equal(output.self_check.kind, 'same_session_model_self_check');
  });
});

test('completed self-check is explicitly labelled and leaves caller review pending', async () => {
  await fixture({}, async ({invoke, calls}) => {
    const {code, output} = await invoke({goal: 'read source', fast_review: {goal: 'check output'}});
    assert.equal(code, 0); assert.equal(output.runs.length, 2);
    assert.equal(output.self_check.status, 'completed'); assert.equal(output.caller_review, 'pending');
    assert.ok(!calls.some(call => call.url.endsWith('/review')));
    assert.equal('fast_review' in calls[0].body, false);
  });
});

test('ambiguous guidance alias is rejected before submission', async () => {
  await fixture({}, async ({invoke, calls}) => {
    const {code} = await invoke({goal: 'read source', fast_review: {guidance: 'check'}});
    assert.equal(code, 1); assert.equal(calls.length, 0);
  });
});
