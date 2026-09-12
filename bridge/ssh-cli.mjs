#!/usr/bin/env node
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve, dirname, posix} from 'node:path';
import {fileURLToPath} from 'node:url';

const commands = new Set(['health', 'submit', 'status', 'wait', 'result', 'artifact', 'continue', 'cancel', 'review']);
const valueFlags = new Set(['--target', '--request', '--task', '--run', '--path', '--out', '--timeout-ms', '--decision', '--notes']);
const fail = code => Object.assign(new Error(code), {code});
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";

export function remoteInvocation(target, command, values) {
  if (!commands.has(command)) throw fail('REMOTE_COMMAND_UNSUPPORTED');
  if (!target || typeof target.host !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(target.host)) throw fail('REMOTE_HOST_INVALID');
  for (const key of ['node', 'cli']) if (typeof target[key] !== 'string' || !posix.isAbsolute(target[key]) || /[\0\r\n]/.test(target[key])) throw fail('REMOTE_PATH_INVALID');
  const port = target.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('REMOTE_PORT_INVALID');
  const cliArgs = [target.node, target.cli, command];
  for (const [name, value] of Object.entries(values)) {
    if (!valueFlags.has(name)) throw fail('REMOTE_FLAG_INVALID');
    if (['--target', '--out'].includes(name)) continue;
    if (name === '--request') cliArgs.push(name, '-');
    else cliArgs.push(name, value);
  }
  const sshArgs = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-p', String(port)];
  if (target.identityFile) {
    if (typeof target.identityFile !== 'string' || /[\0\r\n]/.test(target.identityFile)) throw fail('REMOTE_IDENTITY_PATH_INVALID');
    sshArgs.push('-i', resolve(target.identityFile));
  }
  return [...sshArgs, '--', target.host, cliArgs.map(shellQuote).join(' ')];
}

/** SSH carries request/result bytes; model and bridge credentials stay in the remote project .env. */
export async function runRemote({target, command, values, input, spawnImpl = spawn, timeoutMs = 60000}) {
  const args = remoteInvocation(target, command, values);
  return new Promise((done, reject) => {
    const child = spawnImpl('ssh', args, {windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']});
    const chunks = []; let size = 0; let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {child.kill(); reject(error);} else done(result);
    };
    const timer = setTimeout(() => finish(fail('SSH_COMMAND_TIMEOUT')), timeoutMs);
    child.once('error', () => finish(fail('SSH_START_FAILED')));
    child.stdin.on('error', () => {}); // Connection failure is reported by exit/error, never by echoing input.
    child.stderr.on('data', () => {}); // Never print arbitrary transport/config diagnostics or credential prompts.
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 24 * 1024 * 1024) finish(fail('SSH_RESPONSE_TOO_LARGE'));
      else chunks.push(chunk);
    });
    child.once('close', code => {
      if (settled) return;
      let result;
      try {result = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {return finish(fail('SSH_TRANSPORT_FAILED'));}
      if (!result || typeof result !== 'object') return finish(fail('REMOTE_RESPONSE_INVALID'));
      if (code !== 0 && result.ok !== false) return finish(fail('SSH_TRANSPORT_FAILED'));
      finish(null, result);
    });
    child.stdin.end(input);
  });
}

export async function saveRemoteArtifact(result, output) {
  if (result.encoding !== 'base64' || typeof result.content !== 'string' || !Number.isSafeInteger(result.size)) throw fail('REMOTE_ARTIFACT_INVALID');
  const bytes = Buffer.from(result.content, 'base64');
  if (bytes.length !== result.size || createHash('sha256').update(bytes).digest('hex') !== result.sha256) throw fail('REMOTE_ARTIFACT_HASH_MISMATCH');
  const destination = resolve(output);
  await mkdir(dirname(destination), {recursive: true});
  await writeFile(destination, bytes, {flag: 'wx', mode: 0o600});
  return {saved: destination, size: bytes.length, sha256: result.sha256, run_id: result.run_id};
}

async function main() {
  const args = process.argv.slice(2), command = args.shift();
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('Remote DSH bridge: COMMAND --target NAME [--request LOCAL_JSON] [--task ID] [--run ID] [--path RELATIVE_FILE] [--out LOCAL_FILE]\nConfigure bridge.ssh.local.json with an already authorized SSH host, absolute remote Node and bridge CLI paths.');
    return;
  }
  const values = {};
  for (let i=0;i<args.length;i++) {
    if (!valueFlags.has(args[i]) || args[i+1] === undefined || args[i+1].startsWith('--')) throw fail('REMOTE_FLAG_INVALID');
    values[args[i]] = args[++i];
  }
  if (!values['--target']) throw fail('REMOTE_TARGET_REQUIRED');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const config = JSON.parse(await readFile(resolve(root, 'bridge.ssh.local.json'), 'utf8'));
  let input;
  if (['submit', 'continue'].includes(command)) {
    if (!values['--request']) throw fail('REQUEST_FILE_REQUIRED');
    input = await readFile(resolve(values['--request']));
    if (input.length > 256*1024) throw fail('REQUEST_TOO_LARGE');
    JSON.parse(input.toString('utf8'));
  }
  const result = await runRemote({target: config.targets?.[values['--target']], command, values, input});
  if (result.ok === false) {console.log(JSON.stringify(result,null,2)); process.exitCode=1; return;}
  console.log(JSON.stringify(command === 'artifact' && values['--out'] ? await saveRemoteArtifact(result, values['--out']) : result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.log(JSON.stringify({ok:false,error:{code:error.code?.startsWith('REMOTE_') || error.code?.startsWith('SSH_') || error.code?.startsWith('REQUEST_') ? error.code : 'REMOTE_COMMAND_FAILED',message:'Check the configured SSH connection and remote bridge state; accepted tasks are never automatically replayed.'}},null,2));
  process.exitCode=1;
});
