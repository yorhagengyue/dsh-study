import {readFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

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
export async function main(args) {
  let configPath=join(homedir(),'.codex','skills','dsh-dialogue','connection.local.json');
  if(args[0]==='--config'){configPath=resolve(args[1]);args=args.slice(2);}
  const config=JSON.parse(readFileSync(configPath,'utf8')),client=new Client(config);
  const command=args[0]??'health';let result;
  if(command==='run'||command==='onboard') {
    const request=args[1]?JSON.parse(readFileSync(resolve(args[1]),'utf8').replace(/^\uFEFF/,'')):{};
    request.id??='run-'+crypto.randomUUID();
    // Persist exact prepared request before network submission so transport failures are recoverable by ID.
    const {write,redactor}=await import('../connection-plugin/files.mjs');
    const prepared=join(config.workspace,'connection','client-requests',request.id+'.json');
    if(!/^[\w-]{1,100}$/.test(request.id))throw new Error('INVALID_ID');
    if(existsSync(prepared)&&readFileSync(prepared,'utf8')!==JSON.stringify(request,null,2))throw new Error('CLIENT_ID_CONFLICT');
    write(prepared,redactor(config.dsh_root)(request));
    const callerStarted=Date.now();process.stderr.write('DSH request ID: '+request.id+'\n');
    result=await client.call(command==='run'?'tasks':'onboard',request);
    const until=Date.now()+Math.min(request.wait_seconds??45,50)*1000;
    while(['preparing','submitting','accepted','running'].includes(result.status)&&Date.now()<until){await new Promise(r=>setTimeout(r,250));result=await client.call('runs/'+result.id);}
    write(prepared.replace(/\.json$/,'.result.json'),redactor(config.dsh_root)({caller_started_ms:callerStarted,caller_received_ms:Date.now(),result}));
  } else if(command==='poll')result=await client.call('runs/'+encodeURIComponent(args[1]));
  else if(command==='review')result=await client.call('review',JSON.parse(readFileSync(args[1],'utf8')));
  else if(['health','runs','profile','sources'].includes(command))result=await client.call(command);
  else throw new Error('UNKNOWN_COMMAND');
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
