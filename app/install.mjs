import {existsSync,readFileSync,mkdirSync,copyFileSync,cpSync,writeFileSync,unlinkSync} from 'node:fs';
import {join,resolve,dirname,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {desktop,hash,write,redactor} from '../connection-plugin/files.mjs';
import {Client} from './connection-client.mjs';

const args=process.argv.slice(2), at=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const workspace=resolve(at('--workspace')??join(desktop(),'DSH-Study'));
const dshRoot=resolve(at('--dsh-root')??(existsSync(join(homedir(),'dsh','package.json'))?join(homedir(),'dsh'):join(workspace,'runtime','dsh')));
const dshHome=resolve(at('--dsh-home')??join(dshRoot,'home'));
const port=Number(at('--port')??3090);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('INVALID_PORT');
const started=Date.now(), report={version:'0.2.0',started_at:started,workspace,dshRoot,dshHome,steps:[]};
const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
if(nodeMajor<22||(nodeMajor===22&&nodeMinor<16))throw new Error('NODE_22_16_OR_NEWER_REQUIRED');
let listening=false;try{const r=await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(1200)});listening=r.status>0;}catch{}
if(listening) {
  const client=new Client({dsh_root:dshRoot,base_url:'http://127.0.0.1:'+port});await client.login();
  const response=await fetch(client.base+'/api/session/list',{method:'POST',headers:{Cookie:client.cookie,'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'session/list',payload:{args:{_request:{}}}}),signal:AbortSignal.timeout(10000)});
  const result=(await response.json()).result;
  if(!result?.ok||result.value.items.some(s=>s.running))throw new Error('ACTIVE_OR_UNKNOWN_SESSIONS_INSTALL_NOT_ALLOWED');
}
mkdirSync(dshRoot,{recursive:true});mkdirSync(join(workspace,'connection'),{recursive:true});
const installMarker=join(dshRoot,'runtime','study-app','installing.json');write(installMarker,{started_ms:started});
const npm=[process.env.npm_execpath,join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),join(dirname(process.execPath),'..','lib','node_modules','npm','bin','npm-cli.js'),'/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js','/usr/local/lib/node_modules/npm/bin/npm-cli.js'].filter(Boolean).find(existsSync);
if(!npm)throw new Error('NODE_WITH_NPM_REQUIRED');
function command(entry,params,cwd=dshRoot) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.toLowerCase()!=='path'));
  env.PATH=[join(dshRoot,'node_modules','.bin'),dirname(process.execPath),process.env.PATH??process.env.Path??''].join(delimiter);env.DSH_HOME=dshHome;
  env.CI='true';
  const r=spawnSync(process.execPath,[entry,...params],{cwd,env,windowsHide:true,encoding:'utf8',maxBuffer:10000000});
  if(r.status!==0){const log=join(workspace,'connection','install-error.log');write(log,redactor(dshRoot)(String(r.stdout??'')+'\n'+String(r.stderr??'')));throw new Error('INSTALL_COMMAND_FAILED; '+log);}
  return r.stdout;
}
const cli=join(dshRoot,'node_modules','@deepseek-ai','dsh','lib','bin.js');
if(!existsSync(cli)) {
  if(!existsSync(join(dshRoot,'package.json')))write(join(dshRoot,'package.json'),{name:'dsh-study-runtime',private:true});
  command(npm,['install','--save-exact','@deepseek-ai/dsh@0.1.5-rc.1']);report.steps.push('official_dsh_installed');
}else report.steps.push('existing_official_dsh_reused');
const modulesMeta=join(dshHome,'profiles','web','node_modules','.modules.yaml');
const wantedPnpm=(existsSync(modulesMeta)?readFileSync(modulesMeta,'utf8').match(/pnpm@(\d+\.\d+\.\d+)/)?.[1]:null)??'10.17.1';
const localPnpm=join(dshRoot,'node_modules','pnpm','package.json');
if(!existsSync(localPnpm)||JSON.parse(readFileSync(localPnpm,'utf8')).version!==wantedPnpm)command(npm,['install','--save-exact','pnpm@'+wantedPnpm,'--ignore-scripts']);
if(!existsSync(join(dshRoot,'.gitignore')))write(join(dshRoot,'.gitignore'),'.env\n.env.*\nhome/\nruntime/\nnode_modules/\n');
else {const p=join(dshRoot,'.gitignore'),s=readFileSync(p,'utf8');if(!s.split(/\r?\n/).includes('.env'))write(p,s+'\n.env\n');}
if(!existsSync(join(dshRoot,'.env')))write(join(dshRoot,'.env'),'# Supply your own official DeepSeek credential here. Never commit this file.\nDEEPSEEK_API_KEY=\n');
// Current official DSH reserves DSH_* names in dotenv. Preserve the legacy token under an application-owned name.
{const p=join(dshRoot,'.env'),s=readFileSync(p,'utf8');if(s.includes('DSH_DIALOGUE_LAUNCH_TOKEN='))write(p,s.replace(/^DSH_DIALOGUE_LAUNCH_TOKEN=/gm,'STUDY_LAUNCH_TOKEN='));}
const profile=join(dshHome,'profiles','web'),backup=join(workspace,'connection','install-backups',String(started));mkdirSync(backup,{recursive:true});
for(const f of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml'])if(existsSync(join(profile,f)))copyFileSync(join(profile,f),join(backup,f));
const packed=join(dshRoot,'runtime','study-packages');mkdirSync(packed,{recursive:true});
const archive=JSON.parse(command(npm,['pack',join(root,'connection-plugin'),'--pack-destination',packed,'--json','--ignore-scripts']))[0];
const original=join(packed,archive.filename),digest=hash(readFileSync(original));
const tarball=join(packed,archive.filename.replace('.tgz','-'+digest.slice(0,16)+'.tgz'));if(!existsSync(tarball))copyFileSync(original,tarball);
command(cli,['plugin','--profile','web','add',tarball,'--ignore-scripts']);
const yaml=createRequire(join(dshRoot,'package.json'))('js-yaml');
class Expr{constructor(value){this.value=value;}}
const schema=yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',instanceOf:Expr,construct:v=>new Expr(v),represent:v=>v.value})]);
const patchFile=join(profile,'cordis.patch.yml'),patch=existsSync(patchFile)?yaml.load(readFileSync(patchFile,'utf8'),{schema})??[]:[];
const kept=patch.filter(r=>r.id!=='dsh-study-connection');
kept.push({id:'dsh-study-connection',config:{workspace,dshRoot,autoImport:args.includes('--auto-import'),sourcePaths:at('--sources')?JSON.parse(readFileSync(at('--sources'),'utf8')):[]}});
write(patchFile,yaml.dump(kept,{schema,noRefs:true,lineWidth:120}));
for(const f of archive.files)if(!readFileSync(join(root,'connection-plugin',f.path)).equals(readFileSync(join(profile,'node_modules','@yorhagengyue','dsh-study-connection',f.path))))throw new Error('INSTALLED_FILE_MISMATCH');
report.steps.push('cordis_bundle_installed_and_files_verified');report.package_sha256=digest;
const appRoot=join(workspace,'connection','app');mkdirSync(appRoot,{recursive:true});
for(const dir of ['app','connection-plugin'])cpSync(join(root,dir),join(appRoot,dir),{recursive:true});
const config={version:2,dsh_root:dshRoot,dsh_home:dshHome,node:process.execPath,base_url:'http://127.0.0.1:'+port,workspace};
write(join(appRoot,'app.local.json'),config);
const skill=join(at('--skills-dir')??join(homedir(),'.codex','skills'),'dsh-dialogue');
if(existsSync(skill))cpSync(skill,join(backup,'dsh-dialogue'),{recursive:true});
cpSync(join(root,'skills','dsh-dialogue'),skill,{recursive:true});
const contextSkill=join(dirname(skill),'dsh-context-onboarding');
if(existsSync(contextSkill))cpSync(contextSkill,join(backup,'dsh-context-onboarding'),{recursive:true});
cpSync(join(root,'skills','dsh-context-onboarding'),contextSkill,{recursive:true});
write(join(skill,'connection.local.json'),config);
// Installed client is self-contained, sharing the same portable source as the App.
cpSync(join(root,'app'),join(skill,'app'),{recursive:true});cpSync(join(root,'connection-plugin'),join(skill,'connection-plugin'),{recursive:true});
report.steps.push('codex_skill_installed');
if(process.platform==='win32')write(join(workspace,'启动学习应用.cmd'),'@echo off\r\nchcp 65001 >nul\r\n"'+process.execPath+'" "'+join(appRoot,'app','launch.mjs')+'" --config "'+join(appRoot,'app.local.json')+'" --open\r\n');
else {const p=join(workspace,'启动学习应用.command');write(p,'#!/bin/sh\nexec '+[process.execPath,join(appRoot,'app','launch.mjs'),'--config',join(appRoot,'app.local.json'),'--open'].map(s=>"'"+s.replace(/'/g,"'\\''")+"'").join(' ')+'\n');const{chmodSync}=await import('node:fs');chmodSync(p,0o700);}
report.finished_at=Date.now();report.elapsed_ms=report.finished_at-started;report.restart_required=true;
write(join(workspace,'connection','install-report.json'),report);console.log(JSON.stringify(report,null,2));
unlinkSync(installMarker);
