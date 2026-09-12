import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const credential = 'synthetic-localhost-cli-test-token';
const limit = 256 * 1024;

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-cli-stdin-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({path: request.url, body});
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({ok: true, result: {task_id: 'fixture-task', received: body}}));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await writeFile(join(root, '.env'), `BRIDGE_API_TOKEN=${credential}\n`, 'utf8');
    await writeFile(join(root, 'bridge.local.json'), JSON.stringify({port: server.address().port, dshInstall: root, runtimeHome: join(root, 'runtime'), workspaceRoots: [join(root, 'work')]}), 'utf8');
    await run({root, requests});
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-bridge-cli-stdin-')));
    await rm(root, {recursive: true, force: true});
  }
}

function invoke(root, command, input, additional = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, command, '--root', root, ...additional], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const stdout = []; const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.stdin.on('error', error => {if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') reject(error);});
    const timeout = setTimeout(() => {child.kill(); reject(new Error('CLI fixture timed out'));}, 10000);
    child.once('close', code => {
      clearTimeout(timeout);
      try {resolve({code, result: JSON.parse(Buffer.concat(stdout).toString('utf8')), stderr: Buffer.concat(stderr).toString('utf8')});}
      catch (error) {reject(error);}
    });
    // Direct bytes preserve Unicode without PowerShell stdin conversion.
    child.stdin.end(input);
  });
}

test('submit and continue preserve Chinese JSON received from UTF-8 stdin', async () => {
  await fixture(async ({root, requests}) => {
    const request = {request_id: '中文请求', goal: '阅读合成学习资料，写出简短说明。', context: '耿越自己的学习任务 📚'};
    const first = await invoke(root, 'submit', Buffer.from(JSON.stringify(request), 'utf8'), ['--request', '-']);
    assert.equal(first.code, 0); assert.deepEqual(first.result.received, request); assert.equal(first.stderr, '');
    const correction = {request_id: '中文修正', goal: '保留来源，并增加一句中文说明。'};
    const second = await invoke(root, 'continue', Buffer.from(JSON.stringify(correction), 'utf8'), ['--task', 'fixture-task', '--request', '-']);
    assert.equal(second.code, 0); assert.deepEqual(second.result.received, correction);
    assert.deepEqual(requests.map(value => value.path), ['/v1/tasks', '/v1/tasks/fixture-task/continue']);
  });
});

test('invalid JSON and invalid UTF-8 are rejected locally with safe error codes', async () => {
  await fixture(async ({root, requests}) => {
    const invalidJson = await invoke(root, 'submit', Buffer.from('{"private":"do-not-echo"'), ['--request', '-']);
    assert.equal(invalidJson.code, 1); assert.equal(invalidJson.result.error.code, 'REQUEST_STDIN_INVALID_JSON');
    assert.ok(!JSON.stringify(invalidJson).includes('do-not-echo'));
    const invalidUtf8 = await invoke(root, 'submit', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), ['--request', '-']);
    assert.equal(invalidUtf8.code, 1); assert.equal(invalidUtf8.result.error.code, 'REQUEST_STDIN_INVALID_UTF8');
    assert.equal(requests.length, 0);
  });
});

test('stdin enforces a byte-based 256 KiB cap before contacting the broker', async () => {
  await fixture(async ({root, requests}) => {
    const accepted = Buffer.from('{"goal":"' + 'a'.repeat(limit - Buffer.byteLength('{"goal":""}')) + '"}', 'utf8');
    assert.equal(accepted.length, limit);
    assert.equal((await invoke(root, 'submit', accepted, ['--request', '-'])).code, 0);
    const oversized = Buffer.from(JSON.stringify({goal: '中'.repeat(Math.ceil(limit / 3))}), 'utf8');
    assert.ok(oversized.length > limit);
    const rejected = await invoke(root, 'continue', oversized, ['--task', 'fixture-task', '--request', '-']);
    assert.equal(rejected.code, 1); assert.equal(rejected.result.error.code, 'REQUEST_STDIN_TOO_LARGE');
    assert.equal(requests.length, 1);
  });
});

test('existing --request file behavior is preserved', async () => {
  await fixture(async ({root, requests}) => {
    const request = {request_id: 'file-request', goal: '从文件读取中文请求。'};
    const path = join(root, 'request.json'); await writeFile(path, JSON.stringify(request), 'utf8');
    const result = await invoke(root, 'submit', undefined, ['--request', path]);
    assert.equal(result.code, 0); assert.deepEqual(requests[0].body, request);
  });
});
