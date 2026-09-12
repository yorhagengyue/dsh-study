import {readFileSync,existsSync,appendFileSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {Client,envValues} from './connection-client.mjs';
import {write,redactor} from '../connection-plugin/files.mjs';

const args=process.argv.slice(2),idx=args.indexOf('--config');
const configPath=resolve(idx<0?join(dirname(fileURLToPath(import.meta.url)),'..','app.local.json'):args[idx+1]);
const config=JSON.parse(readFileSync(configPath,'utf8')),dir=join(config.dsh_root,'runtime','study-app');mkdirSync(dir,{recursive:true});
const port=new URL(config.base_url).port;
function openApp(url) {
  if(process.platform==='win32') {
    const child=spawn('powershell.exe',['-NoProfile','-Command','Start-Process -FilePath $env:DSH_STUDY_OPEN_URL'],{windowsHide:true,stdio:'ignore',env:{...process.env,DSH_STUDY_OPEN_URL:url}});child.unref();
  }else {const child=spawn('open',[url],{stdio:'ignore',detached:true});child.unref();}
}
if(args.includes('--serve')) {
  const env=envValues(config.dsh_root);
  if(!env.DEEPSEEK_API_KEY)throw new Error('DEEPSEEK_API_KEY_REQUIRED_IN_PROJECT_ENV');
  const baseEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>! /^(?:DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|NODE_OPTIONS|NODE_PATH)/i.test(k)));
  Object.assign(baseEnv,{DEEPSEEK_API_KEY:env.DEEPSEEK_API_KEY,DSH_HOME:config.dsh_home});
  const child=spawn(config.node,[join(config.dsh_root,'node_modules','@deepseek-ai','dsh','lib','bin.js'),'web','--host','127.0.0.1','--port',port,'--no-open'],{cwd:config.dsh_root,env:baseEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
  write(join(dir,'process.json'),{supervisor_pid:process.pid,dsh_pid:child.pid,config:configPath,started_ms:Date.now()});
  const redact=redactor(config.dsh_root);
  function consume(stream){let pending='';stream.setEncoding('utf8');stream.on('data',chunk=>{pending+=chunk;const lines=pending.split('\n');pending=lines.pop();for(const line of lines){const m=line.match(/https?:\/\/[^\s]+\?token=([\w-]+)/);if(m){const p=join(config.dsh_root,'.env'),text=readFileSync(p,'utf8'),updated=text.replace(/^STUDY_LAUNCH_TOKEN=.*(?:\r?\n|$)/m,'');write(p,updated.trimEnd()+'\nSTUDY_LAUNCH_TOKEN='+m[1]+'\n');}appendFileSync(join(dir,'runtime.log'),redact(line)+'\n','utf8');}});}
  consume(child.stdout);consume(child.stderr);
  child.on('exit',code=>{write(join(dir,'stopped.json'),{code,at:Date.now()});process.exitCode=code??1;});
}else {
  if(args.includes('--restart-owned')) {
    const statePath=join(dir,'process.json');
    if(existsSync(statePath)) {
      const old=JSON.parse(readFileSync(statePath,'utf8'));
      const pid=old.dsh_pid;
      if(!Number.isInteger(pid)||pid<1)throw new Error('INVALID_OWNED_PID');
      let command='';
      try {command=process.platform==='win32'?execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`],{encoding:'utf8',windowsHide:true}):execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});}catch{}
      if(command.trim()) {
        const expected=join(config.dsh_root,'node_modules','@deepseek-ai','dsh','lib','bin.js').replaceAll('\\','/');
        if(!command.replaceAll('\\','/').includes(expected))throw new Error('PID_NOT_OWNED_BY_THIS_APP');
        const client=new Client(config);await client.login();
        const response=await fetch(config.base_url+'/api/session/list',{method:'POST',headers:{Cookie:client.cookie,'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'session/list',payload:{args:{_request:{}}}}),signal:AbortSignal.timeout(10000)});
        const result=(await response.json()).result;
        if(!result?.ok||result.value.items.some(s=>s.running))throw new Error('ACTIVE_OR_UNKNOWN_SESSIONS_RESTART_NOT_ALLOWED');
        process.kill(pid);await new Promise(r=>setTimeout(r,700));
      }
    }
  }
  let ready=false;try{await new Client(config).call('health');ready=true;}catch{}
  if(!ready) {
    let listening=false;try{const r=await fetch(config.base_url,{signal:AbortSignal.timeout(1500)});listening=r.status>0;}catch{}
    if(listening)throw new Error('PORT_ALREADY_RUNNING_BUT_PLUGIN_NOT_READY_RESTART_CONFIRMED_OWNER');
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--config',configPath,'--serve'],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();
    const until=Date.now()+45000;
    while(Date.now()<until){try{await new Client(config).call('health');ready=true;break;}catch{}await new Promise(r=>setTimeout(r,500));}
  }
  if(!ready)throw new Error('APP_STARTUP_NOT_READY_CHECK_RUNTIME');
  await new Client(config).call('initialize',{});
  if(args.includes('--open')) {
    // A URL fragment survives the normal 303 login redirect and never reaches the HTTP server.
    const env=envValues(config.dsh_root);
    openApp(config.base_url+'/?token='+encodeURIComponent(env.STUDY_LAUNCH_TOKEN)+'#study');
  }
  console.log(JSON.stringify({ready:true,url:config.base_url+'/study',window_open_requested:args.includes('--open'),window_verified:false}));
}
