import {readFile,writeFile,mkdir,rename,realpath} from 'node:fs/promises';
import {resolve,join,basename,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {quick} from '../quick.mjs';
import {runEvidence} from '../evidence-cycle.mjs';

const read=p=>readFile(p,'utf8').then(JSON.parse);
const write=(p,x)=>writeFile(p,JSON.stringify(x,null,2),{flag:'wx'});
export class DshAdapter {
 constructor({outputRoot,target='mac-mini',quickImpl=quick,evidenceImpl=runEvidence}) {
  this.root=resolve(outputRoot);this.target=target;this.quick=quickImpl;this.evidence=evidenceImpl;this.busy=new Set();
 }
 async state(handle) {
  if(!/^quick-[a-f0-9-]{36}$/.test(handle))throw Error('INVALID_HANDLE');
  const folder=await realpath(join(this.root,handle));const root=await realpath(this.root);
  const rel=relative(root,folder);if(rel.startsWith('..')||isAbsolute(rel))throw Error('HANDLE_OUTSIDE_OUTPUT_ROOT');
  const state=await read(join(folder,'mcp-state.json'));
  const active=await realpath(state.active),activeRel=relative(folder,active);
  if(activeRel.startsWith('..')||isAbsolute(activeRel))throw Error('REVISION_OUTSIDE_HANDLE');
  return {...state,folder,active};
 }
 async setState(folder,state){const p=join(folder,`state-${randomUUID()}.tmp`);await write(p,state);await rename(p,join(folder,'mcp-state.json'));}
 async exclusive(handle,fn){if(this.busy.has(handle))throw Error('HANDLE_BUSY');this.busy.add(handle);try{return await fn();}finally{this.busy.delete(handle);}}
 async start({source_text,goal}) {
  await mkdir(join(this.root,'requests'),{recursive:true});
  const input=join(this.root,'requests',`${randomUUID()}.json`);await write(input,{source_text,goal,target:this.target,output_root:this.root});
  let result;await this.quick('start',input,undefined,x=>{result=JSON.parse(x);});
  if(result?.status!=='pending_review')throw Error('START_FAILED_EVIDENCE_RETAINED');
  const handle=basename(result.evidence_dir);
  await write(join(result.evidence_dir,'mcp-state.json'),{active:result.evidence_dir,revision:0});
  return {...result,handle};
 }
 async review({handle,decision,reviewer,reasoning}) {
  return this.exclusive(handle,async()=>{
   const state=await this.state(handle);
   const input=join(state.active,`mcp-verdict-${randomUUID()}.json`);await write(input,{decision,reviewer,reasoning});
   let result;await this.quick('review',state.active,input,x=>{result=JSON.parse(x);});
   if(!result?.status)throw Error('REVIEW_FAILED');
   return {...result,handle};
  });
 }
 async continue({handle,goal}) {
  return this.exclusive(handle,async()=>{
   const state=await this.state(handle);
   const lastReview=await read(join(state.active,'review-response.json'));
   if(lastReview.review?.status!=='changes_requested')throw Error('REQUIRES_CHANGES_REQUESTED');
   const old=await read(join(state.active,'bundle.json'));
   const last=await read(join(state.active,'review-input.json'));
   const next=join(state.folder,`correction-${state.revision+1}-${randomUUID()}`);await mkdir(next);
   const bundle={...old,task_id:last.task_id,request:{...old.request,request_id:`mcp-${randomUUID()}`,goal}};
   await write(join(next,'bundle.json'),bundle);
   await write(join(next,'quick-start.json'),await read(join(state.folder,'quick-start.json')));
   // Move the active revision before dispatch so failures cannot replay a correction silently.
   await this.setState(state.folder,{active:next,revision:state.revision+1});
   let result;await this.evidence('dispatch',next,join(next,'bundle.json'),x=>{result=JSON.parse(x);});
   return {handle,evidence_dir:next,source:result.source,report:result.artifacts['report.md']?.text,run_id:result.run_id,status:'pending_review',execution_status:result.status};
  });
 }
}
