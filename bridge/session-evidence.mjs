import {spawn} from 'node:child_process';
import {posix} from 'node:path';
import {remoteInvocation, shellQuote} from './ssh-cli.mjs';

// Executed on the target: raw session contents and project secrets never leave it.
async function collect(root, taskId, sessionId) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const config = JSON.parse(await fs.readFile(path.join(root, 'bridge.local.json'), 'utf8'));
  const {readEnv} = await import(require('node:url').pathToFileURL(path.join(root, 'bridge/config.mjs')));
  const env = await readEnv(root);
  const secrets = Object.values(env).filter(value => typeof value === 'string' && value.length >= 8);
  const sessions = path.join(config.runtimeHome, taskId, 'sessions');
  const candidates = [];
  for (const entry of await fs.readdir(sessions, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(sessions, entry.name, sessionId, 'session.v3.jsonl');
    try {if ((await fs.lstat(candidate)).isFile()) candidates.push(candidate);} catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  if (candidates.length === 0) throw new Error('SESSION_EVIDENCE_NOT_READY');
  if (candidates.length !== 1) throw new Error('SESSION_EVIDENCE_NOT_UNIQUE');
  const raw = await fs.readFile(candidates[0], 'utf8');
  // Runtime completion can precede the final JSONL append. Never silently drop
  // an incomplete line or return an earlier turn as the complete current log.
  const tail = JSON.parse(raw.trim().split('\n').at(-1));
  if (tail.type !== 'turn/end') throw new Error('SESSION_EVIDENCE_NOT_READY');
  return {task_id: taskId, session_id: sessionId, ...sanitizeSession(raw, secrets)};
}

async function collectReady(root, taskId, sessionId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {return await collect(root, taskId, sessionId);}
    catch (error) {
      const retry = error instanceof SyntaxError || error.code === 'ENOENT' || error.message === 'SESSION_EVIDENCE_NOT_READY';
      if (!retry || attempt === 19) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

export function validateSessionEvidence(value, taskId, sessionId) {
  if (!value || value.error || value.task_id !== taskId || value.session_id !== sessionId || !Number.isInteger(value.event_count) || value.event_count < 1 || typeof value.jsonl !== 'string' || typeof value.text !== 'string') throw new Error('SESSION_EVIDENCE_INVALID_RESPONSE');
  if (!value.jsonl.trim() || !value.text.trim() || value.jsonl.trim().split('\n').length !== value.event_count) throw new Error('SESSION_EVIDENCE_INVALID_RESPONSE');
  for (const line of value.jsonl.trim().split('\n')) JSON.parse(line);
  return value;
}

export function sanitizeSession(raw, secrets = []) {
  const redact = text => {
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
  };
  const safe = value => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(safe);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(reasoning|thinking|systemPrompt|systemPromptUpdate|stream)$/i.test(key)).map(([key, val]) => [key, /token|secret|password|authorization|api.?key/i.test(key) ? '[REDACTED]' : safe(val)]));
    return value;
  };
  const blocks = content => (content ?? []).flatMap(block => {
    if (block.type === 'text') return [{type: 'text', text: redact(block.text ?? '')}];
    if (block.type === 'tool-call') return [safe({type: block.type, id: block.id, name: block.name, arguments: block.arguments})];
    if (block.type === 'tool-result') return [{type: block.type, toolCallId: block.toolCallId, isError: block.isError, content: blocks(block.content)}];
    return [];
  });
  const events = [];
  for (const line of raw.trim().split('\n')) {
    const event = JSON.parse(line), data = event.data ?? {};
    const output = {type: event.type, seq: event.seq, time: event.time};
    if (event.type === 'user/message') output.content = blocks(data.content);
    else if (event.type === 'assistant/message') {
      output.content = blocks(data.message?.content);
      output.model = safe({provider: data.message?.source?.provider, model: data.message?.source?.model});
    } else if (event.type === 'tool/call') output.call = safe({callId: data.callId, name: data.name, arguments: data.arguments});
    else if (event.type === 'tool/result') output.content = blocks(data.message?.content);
    else continue;
    events.push(output);
  }
  const jsonl = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  const text = events.map(event => `## ${event.seq} ${event.type} ${event.time}\n\n${JSON.stringify(event, null, 2)}`).join('\n\n') + '\n';
  return {event_count: events.length, jsonl, text};
}

export async function captureSession(target, taskId, sessionId) {
  for (const id of [taskId, sessionId]) if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('SESSION_EVIDENCE_INVALID_ID');
  const args = remoteInvocation(target, 'health', {});
  args[args.length - 1] = shellQuote(target.node) + ' -';
  const root = posix.dirname(posix.dirname(target.cli));
  const script = `${sanitizeSession.toString()}; ${collect.toString()}; (${collectReady.toString()})(${JSON.stringify(root)},${JSON.stringify(taskId)},${JSON.stringify(sessionId)}).then(x=>console.log(JSON.stringify(x))).catch(e=>{const code=e instanceof SyntaxError?'SESSION_EVIDENCE_INCOMPLETE_JSONL': /^SESSION_EVIDENCE_[A-Z_]+$/.test(e.message)?e.message:'SESSION_EVIDENCE_READ_FAILED'; console.log(JSON.stringify({error:code}));process.exitCode=1;});`;
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => {child.kill(); reject(new Error('SESSION_EVIDENCE_TIMEOUT'));}, 15000);
    child.stdout.on('data', chunk => {bytes += chunk.length; if (bytes > 24*1024*1024) child.kill(); else chunks.push(chunk);});
    child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
    child.once('error', () => {clearTimeout(timer); reject(new Error('SESSION_EVIDENCE_TRANSPORT_FAILED'));});
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('SESSION_EVIDENCE_FAILED'));
      try {resolve(validateSessionEvidence(JSON.parse(Buffer.concat(chunks).toString('utf8')), taskId, sessionId));} catch {reject(new Error('SESSION_EVIDENCE_INVALID_RESPONSE'));}
    });
    child.stdin.end(script);
  });
}
