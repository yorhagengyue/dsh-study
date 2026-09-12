import {readFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {writeRecord,readRecord,redactor,hash} from '../connection-plugin/files.mjs';

export function envValues(root) {
  const out={};const path=join(root,'.env');
  if(existsSync(path))for(const line of readFileSync(path,'utf8').split(/\r?\n/)) {const m=line.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/);if(m)out[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');}
  return out;
}
export class Client {
  constructor(config){this.config=config;this.base=config.base_url??'http://127.0.0.1:3090';this.cookie=null;const u=new URL(this.base);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('USE_LOOPBACK_OR_SSH_TUNNEL');}
  async login(){
    const env=envValues(this.config.dsh_root);const token=env.STUDY_LAUNCH_TOKEN??env.DSH_DIALOGUE_LAUNCH_TOKEN;
    if(!token)throw new Error('LAUNCH_TOKEN_MISSING_START_APP');
    const r=await fetch(this.base+'/?token='+encodeURIComponent(token),{redirect:'manual',signal:AbortSignal.timeout(10000)});
    const cookies=r.headers.getSetCookie();if(r.status!==303||!cookies.length)throw new Error('DSH_AUTH_FAILED');
    this.cookie=cookies.map(s=>s.split(';')[0]).join('; ');
  }
  async call(action,data){if(!this.cookie)await this.login();const r=await fetch(this.base+'/study/api/'+action,{method:data===undefined?'GET':'POST',headers:{Cookie:this.cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(55000)});let v;try{v=await r.json();}catch{throw new Error('PLUGIN_NOT_READY_HTTP_'+r.status);}if(!r.ok)throw new Error(v.error??'PLUGIN_HTTP_'+r.status);return v;}
}
export function loadRequest(path) {
  const text=readFileSync(resolve(path),'utf8').replace(/^\uFEFF/,'');
  if(path.endsWith('.json'))return JSON.parse(text); // existing callers may migrate gradually
  if(text.includes('<!-- dsh-state -->'))return readRecord(resolve(path));
  const match=text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if(!match)return {goal:text.trim()};
  const options={};
  for(const line of match[1].split(/\r?\n/)) {
    const pair=line.match(/^([a-z_]+):\s*(.*?)\s*$/);if(!pair)continue;
    if(!['id','title','reasoning_effort','continue_run_id','use_context','wait_seconds'].includes(pair[1]))throw new Error('UNKNOWN_REQUEST_OPTION');
    let value=pair[2];if(value==='false'||value==='true')value=value==='true';else if(pair[1]==='wait_seconds')value=Number(value);else value=value.replace(/^(['"])(.*)\1$/,'$2');
    options[pair[1]]=value;
  }
  return {...options,goal:match[2].trim()};
}
export async function main(args) {
  const callerStarted=Date.now();
  let configPath=join(homedir(),'.codex','skills','dsh-dialogue','connection.local.json');
  if(args[0]==='--config'){configPath=resolve(args[1]);args=args.slice(2);}
  const config=JSON.parse(readFileSync(configPath,'utf8')),client=new Client(config),redact=redactor(config.dsh_root);
  const command=args[0]??'health';let result;
  if(command==='run') {
    const request=loadRequest(args[1]);request.id??='run-'+crypto.randomUUID();
    if(!/^[\w-]{1,100}$/.test(request.id))throw new Error('INVALID_ID');
    const prepared=join(config.workspace,'connection','client-requests',request.id+'.md');
    if(existsSync(prepared)&&hash(JSON.stringify(readRecord(prepared)))!==hash(JSON.stringify(redact(request))))throw new Error('CLIENT_ID_CONFLICT');
    writeRecord(prepared,'准备发送的任务',redact(request));
    process.stderr.write('DSH request ID: '+request.id+'\n');
    result=await client.call('tasks',request);
    const until=Date.now()+Math.min(request.wait_seconds??45,50)*1000;
    while(['preparing','submitting','accepted','running','submission_unknown'].includes(result.status)&&Date.now()<until){await new Promise(r=>setTimeout(r,250));result=await client.call('runs/'+result.id);}
    const received=Date.now();
    const timing={caller_started_ms:callerStarted,caller_received_ms:received,caller_to_received_ms:received-callerStarted,user_to_visible_ms:null};
    writeRecord(prepared.replace(/\.md$/,'.result.md'),'调用方收到的完整结果',redact({timing,result}),'此计时从 CLI 启动开始，包含本次认证与轮询；不是用户消息发送到界面可见的延迟。');
    result={...result,caller_timing:timing};
  } else if(command==='onboard')result=await client.call('onboard',args[1]?loadRequest(args[1]):{});
  else if(command==='poll')result=await client.call('runs/'+encodeURIComponent(args[1]));
  else if(command==='review')result=await client.call('review',loadRequest(args[1]));
  else if(['health','runs','profile','index','sources'].includes(command))result=await client.call(command);
  else throw new Error('UNKNOWN_COMMAND');
  if(result.output!==undefined)process.stdout.write(`# ${result.title}\n\n状态：${result.status}；API → 完整文件：${result.metrics.api_to_output_file_ms??'待完成'} ms；CLI → 收到：${result.caller_timing?.caller_to_received_ms??'未测'} ms。\n\n${result.output}\n\n记录：${join(config.workspace,'connection','runs',result.id)}\n`);
  else process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
