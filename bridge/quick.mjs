// Two caller decisions only: source+goal, then an independently reasoned verdict.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {resolve,join,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {remoteInvocation,shellQuote} from './ssh-cli.mjs';
import {runEvidence} from './evidence-cycle.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>readFile(p,'utf8').then(JSON.parse);
const write=(p,x)=>writeFile(p,JSON.stringify(x,null,2),{flag:'wx'});

export function validateQuickInput(input) {
 if(typeof input?.source_text!=='string'||!input.source_text.trim()||Buffer.byteLength(input.source_text)>128*1024)throw Error('QUICK_SOURCE_REQUIRED_MAX_128K');
 if(typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>16000)throw Error('QUICK_GOAL_REQUIRED');
 if('decision' in input || 'verdict' in input)throw Error('QUICK_VERDICT_MUST_FOLLOW_ACTUAL_REVIEW');
 return input;
}

// Runs on the configured host. Unique directories cannot overwrite previous work.
async function remoteStage(project,id) {
 const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
 const chunks=[];for await(const b of process.stdin)chunks.push(b);
 const bytes=Buffer.concat(chunks);if(!bytes.length||bytes.length>128*1024)throw Error('QUICK_SOURCE_SIZE');
 const cfg=JSON.parse(await fs.readFile(path.join(project,'bridge.local.json'),'utf8'));
 const base=await fs.realpath(cfg.workspaceRoots[0]);
 const workspace=path.join(base,id);await fs.mkdir(workspace);
 await fs.writeFile(path.join(workspace,'source.md'),bytes,{flag:'wx',mode:0o600});
 const actual=await fs.readFile(path.join(workspace,'source.md'));
 return {workspace,sha256:crypto.createHash('sha256').update(actual).digest('hex'),size:actual.length};
}

export function validateStaged(staged,bytes) {
 if(staged?.error||!posix.isAbsolute(staged?.workspace??'')||staged.sha256!==sha(bytes)||staged.size!==bytes.length)throw Error('QUICK_SOURCE_STAGE_FAILED');
 return staged;
}

export async function stageSource(target,id,source,spawnImpl=spawn) {
 if(!/^quick-[a-f0-9-]{36}$/.test(id))throw Error('QUICK_ID_INVALID');
 const args=remoteInvocation(target,'health',{});
 const project=posix.dirname(posix.dirname(target.cli));
 const script=`(${remoteStage.toString()})(${JSON.stringify(project)},${JSON.stringify(id)}).then(x=>console.log(JSON.stringify(x))).catch(()=>console.log(JSON.stringify({error:'QUICK_SOURCE_STAGE_FAILED'})));`;
 args[args.length-1]=[target.node,'-e',script].map(shellQuote).join(' ');
 const bytes=Buffer.from(source);
 return new Promise((done,reject)=>{
  const p=spawnImpl('ssh',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let wire='';
  const timer=setTimeout(()=>{p.kill();reject(Error('QUICK_STAGE_TIMEOUT'));},15000);
  p.stdout.on('data',b=>{wire+=b;if(Buffer.byteLength(wire)>65536){p.kill();reject(Error('QUICK_STAGE_RESPONSE_TOO_LARGE'));}});
  p.stderr.on('data',()=>{});p.stdin.on('error',()=>{});
  p.once('error',()=>{clearTimeout(timer);reject(Error('QUICK_STAGE_TRANSPORT_FAILED'));});
  p.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('QUICK_SOURCE_STAGE_FAILED'));try{done(validateStaged(JSON.parse(wire),bytes));}catch{reject(Error('QUICK_SOURCE_STAGE_FAILED'));}});
  p.stdin.end(bytes);
 });
}

export async function quick(command,arg,verdictFile) {
 if(command==='start') {
  const received=new Date().toISOString();
  const input=validateQuickInput(await read(resolve(arg)));
  const id='quick-'+randomUUID(),dir=join(resolve(input.output_root??join(root,'runtime','quick')),id);
  await mkdir(dir,{recursive:true});
  await write(join(dir,'quick-start.json'),{started_at:received,input,id});
  try {
   const config=await read(join(root,'bridge.ssh.local.json'));const target=input.target??'mac-mini';
   const staged=await stageSource(config.targets[target],id,input.source_text);
   await write(join(dir,'staging.json'),staged);
   const bundle={target,source_text:input.source_text,request:{request_id:id,workspace:staged.workspace,goal:input.goal,context:'source.md is already present in the workspace; it is the sole source.',constraints:['Read only source.md; do not query other sources or study tools. Do not invent facts.'],acceptance:['Facts, calculations and explanatory prose agree with source.md. Keep the source reference.'],deliverables:['report.md']}};
   await write(join(dir,'bundle.json'),bundle);
   await runEvidence('dispatch',dir,join(dir,'bundle.json'),()=>{});
   const review=await read(join(dir,'review-input.json'));
   // Full response is on disk; avoid repeating the prompt and model's own summary.
   console.log(JSON.stringify({evidence_dir:dir,source:review.source,report:review.artifacts['report.md']?.text,run_id:review.run_id,status:'pending_review',execution_status:review.status}));
  }catch(error){await write(join(dir,'quick-failure.json'),{at:new Date().toISOString(),error:error.message});console.log(JSON.stringify({evidence_dir:dir,status:'failed',error:error.message}));process.exitCode=1;}
 } else if(command==='review') {
  const dir=resolve(arg),verdict=await read(resolve(verdictFile));
  const review=await read(join(dir,'review-input.json'));
  // Supplying a decision is mandatory, and only possible after actual caller inspection.
  if(!verdict.decision||!verdict.reasoning||!verdict.reviewer)throw Error('EXPLICIT_REVIEW_REQUIRED');
  if(verdict.run_id&&verdict.run_id!==review.run_id)throw Error('REVIEW_RUN_MISMATCH');
  const filled={...verdict,run_id:review.run_id};
  const inputPath=join(dir,'quick-verdict-input.json');await write(inputPath,filled);
  await runEvidence('review',dir,inputPath,()=>{});
  const started=await read(join(dir,'quick-start.json'));
  const ended=new Date().toISOString();
  const timing={started_at:started.started_at,finished_at:ended,elapsed_ms:Date.parse(ended)-Date.parse(started.started_at),scope:'quick command entry before source preparation through persisted actual review; excludes caller pre-command and post-return latency'};
  await write(join(dir,'quick-timing.json'),timing);
  console.log(JSON.stringify({status:verdict.decision,elapsed_ms:timing.elapsed_ms,artifact:join(dir,'artifact-0.bin'),review:join(dir,'review-response.json')}));
 } else throw Error('USE_QUICK_START_INPUT_OR_REVIEW_DIR_VERDICT');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await quick(...process.argv.slice(2));
