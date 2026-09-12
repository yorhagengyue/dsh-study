import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { setupRuntime } from './setup-runtime.mjs';
import { runtimeEnvironment, PROFILE_NAME } from './runtime-config.mjs';

export class RuntimeError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'RuntimeError'; this.code = code; Object.assign(this, details); }
}

/** A single serialized prompt interval; admission is not execution or completion. */
export class PromptInterval {
  constructor({sessionId, requestId, emit = () => {}, redact = value => String(value)}) {
    this.sessionId = sessionId; this.requestId = requestId; this.emit = emit; this.redact = redact;
    this.startedAt = Date.now(); this.events = []; this.userMessages = new Set(); this.calls = new Map();
    this.promise = new Promise((resolve, reject) => {this.resolve = resolve; this.reject = reject;});
    // A timeout/EOF may settle while the enqueue request is still pending.
    this.promise.catch(() => {});
  }
  fact(kind, fields = {}) {
    const value = {kind, sessionId: this.sessionId, requestId: this.requestId, at: new Date().toISOString(), elapsedMs: Date.now() - this.startedAt, ...fields};
    this.events.push(value); this.emit(value);
  }
  admitted(receipt) {
    if (typeof receipt?.messageId !== 'string') return this.fail('INVALID_RECEIPT', 'DSH did not return a durable message identity');
    this.messageId = receipt.messageId; this.receiptAt = Date.now();
    this.fact('receipt', {messageId: this.messageId}); this.finishIfReady();
  }
  notification(method, params) {
    if (params?.sessionId !== this.sessionId || this.settled) return;
    if (method === 'session.status') {
      if (params.status === 'running') this.idle = false;
      if (params.status === 'idle' && this.turnEnd) {this.idle = true; this.fact('idle'); this.finishIfReady();}
      return;
    }
    if (method !== 'session.event') return;
    const event = params.event ?? {}; const data = event.data ?? {};
    if (event.type === 'turn/start') {this.turn = data.turn; this.idle = false;}
    if (event.type === 'user/message' && typeof data.id === 'string') this.userMessages.add(data.id);
    if (event.type === 'step/start') {
      this.modelStartedAt ??= Date.now(); this.stepCount = (this.stepCount ?? 0) + 1;
      this.fact('model_start', {turn: data.turn, step: data.step});
    }
    if (event.type === 'request/header') {
      this.model = data.header?.config?.model; this.provider = data.header?.config?.provider;
      this.toolNames = data.header?.tools?.map(tool => tool.name) ?? [];
    }
    if (event.type === 'assistant/message') {
      const text = data.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
      // A salvaged stream prefix is not a completed answer. Keep the marker until
      // a later complete assistant message supersedes it, including an empty one.
      this.interruptedAssistant = data.interrupted === true;
      if (this.interruptedAssistant) this.finalResponse = undefined;
      else {
        this.finalResponse = text?.trim() ? this.redact(text) : undefined;
        this.modelRespondedAt ??= Date.now();
        this.fact('model_response', {turn: data.turn, step: data.step, hasUsage: Boolean(data.usage)});
      }
      if (data.usage) this.usage = data.usage;
    }
    if (event.type === 'tool/call') {
      let args = {}; try {args = JSON.parse(data.arguments);} catch {}
      const safe = {};
      for (const key of ['source_id', 'course_id', 'resource_id']) if (typeof args[key] === 'string') safe[key] = this.redact(args[key]);
      this.calls.set(data.callId, data.name);
      this.fact('tool', {phase: 'start', name: data.name, callId: data.callId, ...safe});
    }
    if (event.type === 'tool/result') {
      const content = data.message?.content ?? [];
      const block = content.find(value => value.type === 'tool-result') ?? data.message ?? {};
      const callId = block.tool_use_id ?? block.toolCallId ?? block.callId;
      this.fact('tool', {phase: 'result', name: this.calls.get(callId), callId, isError: Boolean(block.isError ?? data.error), errorCode: data.error?.code});
    }
    if (event.type === 'turn/end') {
      this.turnEnd = data.reason; this.endedAt = Date.now();
      this.fact('turn_end', {turn: data.turn, stopReason: data.reason?.kind, providerFailureCode: data.reason?.error?.code});
      this.finishIfReady();
    }
  }
  finishIfReady() {
    if (this.settled || !this.messageId || !this.turnEnd || !this.idle) return;
    if (!this.userMessages.has(this.messageId)) return this.fail('UNATTRIBUTED_RESULT', 'DSH idle interval did not contain this accepted prompt');
    if (this.turnEnd.kind !== 'completed') return this.fail('MODEL_EXECUTION_FAILED', `DSH ended with ${this.turnEnd.kind ?? 'unknown'}`, {stopReason: this.turnEnd.kind, providerFailureCode: this.turnEnd.error?.code});
    if (this.interruptedAssistant) return this.fail('INCOMPLETE_ASSISTANT_MESSAGE', 'The last assistant message was only an interrupted stream prefix');
    if (!this.modelStartedAt) return this.fail('MODEL_NOT_EXECUTED', 'No model execution was observed for this prompt');
    if (!this.modelRespondedAt) return this.fail('MODEL_RESPONSE_NOT_OBSERVED', 'No complete provider response was observed for this prompt');
    this.settled = true;
    this.resolve({sessionId: this.sessionId, messageId: this.messageId, finalResponse: this.finalResponse ?? '', stopReason: 'completed',
      provider: this.provider, model: this.model, toolNames: this.toolNames, usage: this.usage, events: this.events,
      timingSummary: {receiptMs: this.receiptAt - this.startedAt, modelStartMs: this.modelStartedAt - this.startedAt, modelResponseMs: this.modelRespondedAt - this.startedAt,
        modelExecutionMs: this.endedAt - this.modelStartedAt, totalMs: Date.now() - this.startedAt, modelSteps: this.stepCount}});
  }
  fail(code, message, details = {}) {
    if (this.settled) return;
    this.settled = true; this.reject(new RuntimeError(code, this.redact(message), {...details, events: this.events}));
  }
}

/** One task owns one runtime process and one session; a living process supports serialized corrections. */
export async function createRuntime({projectRoot, workspace, home, dshInstall, sessionId, onEvent = () => {}, config = {}}) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new RuntimeError('INVALID_SESSION', 'sessionId must be a safe unique identifier');
  projectRoot = await realpath(projectRoot); workspace = await realpath(workspace);
  const deployment = await setupRuntime({projectRoot, workspace, home, dshInstall, config});
  const {env, redact} = runtimeEnvironment(projectRoot, deployment.home, config);
  const {JsonRpcLineTransport} = await import(pathToFileURL(deployment.require.resolve('@deepseek-ai/dsh-sdk-protocol')).href);
  const provider = config.provider ?? 'deepseek-official';
  const model = config.model ?? 'deepseek-flash';
  let child; let transport; let interval; let ready; let closing; let exited; let closed = false; let stderr = '';
  const notify = event => { try { onEvent(event); } catch {} };
  const launch = () => {
    child = spawn(process.execPath, [deployment.bin, '--profile', PROFILE_NAME], {cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    exited = new Promise(resolve => {child.once('exit', resolve); child.once('error', resolve);});
    child.stderr.on('data', data => {stderr = (stderr + data.toString('utf8')).slice(-16000);});
    child.once('error', () => {closed = true; interval?.fail('RUNTIME_START_FAILED', 'Could not start the official DSH runtime');});
    child.stdout.once('end', () => {if (!closing) interval?.fail('RUNTIME_DISCONNECTED', 'The SDK transport disconnected before completion');});
    child.once('exit', (code, signal) => {
      closed = true; transport?.close();
      interval?.fail('RUNTIME_EXITED', 'The SDK runtime exited before completion', {exitCode: code, exitSignal: signal});
      notify({kind: 'runtime_exit', sessionId, at: new Date().toISOString(), exitCode: code, exitSignal: signal, requested: Boolean(closing)});
    });
    transport = new JsonRpcLineTransport(child.stdout, child.stdin);
    transport.onNotification((method, params) => interval?.notification(method, params)); transport.start();
  };
  const close = async () => {
    if (closing) return closing;
    interval?.fail('RUNTIME_CLOSED', 'The task runtime was closed; this is not a successful completion');
    closing = (async () => {
      if (!child) {closed = true; return;}
      if (!closed) {
        try {await transport.request('shutdown', {}, AbortSignal.timeout(1500));} catch {}
        await Promise.race([exited, delay(4000, undefined, {ref: false})]);
        if (!closed) {
          child.kill();
          await Promise.race([exited, delay(1500, undefined, {ref: false})]);
          if (!closed) {
            child.kill('SIGKILL');
            await Promise.race([exited, delay(2000, undefined, {ref: false})]);
          }
          if (!closed) throw new RuntimeError('RUNTIME_CLEANUP_FAILED', 'The owned SDK process did not confirm exit after shutdown and termination');
        }
      }
      transport.close(); closed = true;
    })();
    return closing;
  };
  const initialize = async () => {
    if (closed || closing) throw new RuntimeError('SESSION_CLOSED', 'This SDK session cannot resume after runtime shutdown');
    if (ready) return ready;
    launch();
    ready = (async () => {
      try {
        const response = await transport.request('initialize', {cwd: workspace, provider, model,
          reasoningEffort: config.reasoningEffort ?? 'off', maxTokens: config.maxTokens ?? 4096}, AbortSignal.timeout(config.initializeTimeoutMs ?? 30000));
        if (response?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new Error('Unexpected SDK server identity');
        return {provider, model, sessionId, session_id: sessionId, serverInfo: response.serverInfo, versions: deployment.versions,
          capabilities: {sameProcessContinuation: true, restartResume: false, cancellation: 'shutdown-task-runtime', studySources: config.allowedStudySources ?? ['personal-example'], fileTools: ['read', 'write', 'edit']}};
      } catch (error) {
        const details = redact(stderr).slice(-2000);
        await close();
        throw new RuntimeError('RUNTIME_INITIALIZE_FAILED', `DSH initialization failed: ${redact(error.message)}${details ? `\n${details}` : ''}`);
      }
    })();
    return ready;
  };
  const prompt = async (guidance, {signal, requestId} = {}) => {
    if (interval) throw new RuntimeError('SESSION_BUSY', 'A task permits only one active prompt at a time');
    if (typeof guidance !== 'string' || !guidance.trim()) throw new RuntimeError('INVALID_PROMPT', 'Guidance must be nonempty text');
    signal?.throwIfAborted(); await initialize();
    if (interval) throw new RuntimeError('SESSION_BUSY', 'A task permits only one active prompt at a time');
    const current = new PromptInterval({sessionId, requestId, emit: notify, redact}); interval = current;
    const aborted = () => {current.fail('CANCELLED', 'Task execution was cancelled'); void close();};
    signal?.addEventListener('abort', aborted, {once: true});
    const timeout = setTimeout(() => {current.fail('EXECUTION_TIMEOUT', 'Task execution exceeded its configured deadline'); void close();}, config.runTimeoutMs ?? 180000);
    try {
      signal?.throwIfAborted();
      const receipt = await transport.request('session/prompt', {sessionId, contentBlocks: [{type: 'text', text: guidance}]}, AbortSignal.timeout(config.enqueueTimeoutMs ?? 30000));
      current.admitted(receipt);
      return await current.promise;
    } catch (error) {
      current.fail(error.code ?? 'SDK_PROMPT_FAILED', error.message ?? 'DSH prompt failed');
      // Unknown admission after timeout/transport failure must not be retried into this runtime.
      if (!current.messageId && !closing) await close();
      return await current.promise;
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', aborted); if (interval === current) interval = undefined;
    }
  };
  return {initialize, prompt, close, get closed() {return closed || Boolean(closing);}, sessionId};
}
