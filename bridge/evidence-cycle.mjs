// Two-step caller review: dispatch presents real content; verdict is supplied separately.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {runRemote, remoteInvocation, shellQuote} from './ssh-cli.mjs';
import {captureSession} from './session-evidence.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
export function validateBundle(bundle) {
  if(bundle.request?.task_id)throw Error('TASK_ID_MUST_BE_AT_BUNDLE_TOP_LEVEL');
  if(!bundle.source_text)throw Error('SOURCE_REQUIRED');
}
export async function persistVerdict(directory, input, verdict) {
  // A caller may naturally place its already-written verdict in the evidence dir.
  // Preserve that exact file; never overwrite it or fail merely for its presence.
  if(resolve(input)!==join(resolve(directory),'verdict.json'))
    await writeFile(join(directory,'verdict.json'),JSON.stringify(verdict,null,2),{flag:'wx'});
}

export async function runEvidence(command, directory, input, emit = console.log) {
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = resolve(directory ?? '.');
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const save = (p, v) => writeFile(join(dir, p), JSON.stringify(v, null, 2), {flag:'wx'});
const config = await read(join(root, 'bridge.ssh.local.json'));
const call = (target, command, values, body) => runRemote({target:config.targets[target], command, values, input:body});
// Read exactly the declared source on the execution host before any model dispatch.
async function verifySource(bundle) {
  const target=config.targets[bundle.target];
  const args=remoteInvocation(target,'health',{});
  const code="try {const fs=require('node:fs');process.stdout.write(JSON.stringify({base64:fs.readFileSync(process.argv[1]).toString('base64')}));}catch{process.stdout.write(JSON.stringify({error:'SOURCE_MISSING_OR_UNREADABLE'}));}";
  args[args.length-1]=[target.node,'-e',code,bundle.request.workspace+'/source.md'].map(shellQuote).join(' ');
  const wire=await new Promise((done,reject)=>{
    const p=spawn('ssh',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});const chunks=[];let size=0;
    const timer=setTimeout(()=>{p.kill();reject(Error('SOURCE_READ_TIMEOUT'));},10000);
    p.stdout.on('data',b=>{size+=b.length;if(size>262144){p.kill();reject(Error('SOURCE_TOO_LARGE'));}else chunks.push(b);});
    p.stderr.on('data',()=>{});p.on('error',reject);p.on('close',c=>{clearTimeout(timer);c?reject(Error('SOURCE_MISSING_OR_UNREADABLE')):done(Buffer.concat(chunks));});
  });
  const envelope=JSON.parse(wire.toString('utf8'));
  if(envelope.error||typeof envelope.base64!=='string')throw Error('SOURCE_MISSING_OR_UNREADABLE');
  const bytes=Buffer.from(envelope.base64,'base64');
  if(hash(bytes)!==hash(Buffer.from(bundle.source_text)))throw Error('REMOTE_SOURCE_MISMATCH');
  return {sha256:hash(bytes),size:bytes.length,verified_at:new Date().toISOString()};
}

if (command === 'dispatch') {
  const bundle = await read(resolve(input));
  validateBundle(bundle);
  await mkdir(dir, {recursive:true});
  const started = new Date().toISOString();
  await save('dispatch.json', {started_at:started, bundle});
  try {await save('source-verification.json',await verifySource(bundle));}
  catch(error){await save('preflight-failure.json',{error:error.message,at:new Date().toISOString()});throw error;}
  let response;
  if(bundle.task_id) {
    const receipt=await call(bundle.target,'continue',{'--task':bundle.task_id,'--request':'-'},Buffer.from(JSON.stringify(bundle.request)));
    await save('continue-receipt.json',receipt);
    if(!receipt.run_id)throw Error('CONTINUE_REJECTED');
    const waited=await call(bundle.target,'wait',{'--task':bundle.task_id,'--run':receipt.run_id,'--timeout-ms':'50000'});
    await save('wait-response.json',waited);
    if(!waited.done)throw Error('CONTINUE_WAIT_TIMEOUT');
    const result=await call(bundle.target,'result',{'--task':bundle.task_id,'--run':receipt.run_id});
    const artifacts={};for(const a of result.artifacts??[])artifacts[a.path]=await call(bundle.target,'artifact',{'--task':bundle.task_id,'--run':receipt.run_id,'--path':a.path});
    response={task_id:bundle.task_id,session_id:waited.session_id,runs:[{result,artifacts}]};
  } else response = await call(bundle.target, 'fast', {'--request':'-'}, Buffer.from(JSON.stringify(bundle.request)));
  await save('fast-response.json', response);
  if(response.ok===false)throw Error('FAST_INCOMPLETE_SEE_SAVED_RESPONSE');
  if (!response.runs?.length) throw Error('FAST_RESULT_MISSING_SEE_SAVED_RESPONSE');
  const last = response.runs.at(-1);
  const log=await captureSession(config.targets[bundle.target],response.task_id,response.session_id);
  await writeFile(join(dir,'session-evidence.jsonl'),log.jsonl,{flag:'wx'});
  await writeFile(join(dir,'session-evidence.md'),log.text,{flag:'wx'});
  const artifacts = {};
  for (const [name, artifact] of Object.entries(last.artifacts)) {
    const bytes = Buffer.from(artifact.content, 'base64');
    if (bytes.length !== artifact.size || hash(bytes) !== artifact.sha256) throw Error('ARTIFACT_INTEGRITY_FAILED');
    await writeFile(join(dir,`artifact-${Object.keys(artifacts).length}.bin`),bytes,{flag:'wx'});
    artifacts[name] = {sha256:artifact.sha256, size:artifact.size, text:bytes.toString('utf8')};
  }
  const reviewInput = {request:bundle.request, source:bundle.source_text, artifacts, task_id:response.task_id, run_id:last.result.run_id, status:last.result.status, final_response:last.result.final_response};
  await save('review-input.json', reviewInput);
  emit(JSON.stringify(reviewInput));
} else if (command === 'review') {
  const verdict = await read(resolve(input));
  const state = await read(join(dir, 'dispatch.json'));
  const reviewInput = await read(join(dir, 'review-input.json'));
  if (!['accepted','changes_requested'].includes(verdict.decision) || !verdict.reviewer || !verdict.reasoning || verdict.run_id !== reviewInput.run_id) throw Error('EXPLICIT_REVIEW_REQUIRED');
  if (verdict.decision === 'accepted' && reviewInput.status !== 'completed') throw Error('RUN_NOT_COMPLETED');
  await persistVerdict(dir,input,verdict);
  const response = await call(state.bundle.target, 'review', {'--task':reviewInput.task_id,'--run':reviewInput.run_id,'--decision':verdict.decision,'--notes':`${verdict.reviewer}: ${verdict.reasoning}`});
  await save('review-response.json', response);
  if (response.review?.status !== verdict.decision) throw Error('REVIEW_NOT_PERSISTED');
  const finished = new Date().toISOString();
  await save('timing.json', {started_at:state.started_at,finished_at:finished,elapsed_ms:Date.parse(finished)-Date.parse(state.started_at),decision:response.review.status,scope:'dispatch through actual caller review and persisted review response; source staging excluded'});
  emit(JSON.stringify({elapsed_ms:Date.parse(finished)-Date.parse(state.started_at),review:response.review}));
} else throw Error('USE_DISPATCH_OR_REVIEW');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await runEvidence(...process.argv.slice(2));
