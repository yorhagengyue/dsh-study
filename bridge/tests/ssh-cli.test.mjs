import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {remoteInvocation, runRemote, saveRemoteArtifact} from '../ssh-cli.mjs';

const target = {host:'authorized-mac',node:'/opt/node',cli:"/work/team's bridge/cli.mjs"};
test('SSH uses strict known-host authentication, no local shell, and quotes remote arguments',()=>{
  const args=remoteInvocation(target,'review',{'--target':'mac','--task':'task1234','--notes':"keep $(touch /tmp/never) `whoami` 'quoted'"});
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.equal(args.at(-2),'authorized-mac');
  assert.match(args.at(-1),/team'"'"'s bridge/);
  assert.match(args.at(-1),/'keep \$\(touch \/tmp\/never\) `whoami` '"'"'quoted'"'"''$/);
  assert.throws(()=>remoteInvocation({...target,host:'-oProxyCommand=unsafe'},'health',{}),{code:'REMOTE_HOST_INVALID'});
  assert.throws(()=>remoteInvocation(target,'serve',{}),{code:'REMOTE_COMMAND_UNSUPPORTED'});
});

test('request bytes go through stdin and artifact export stays on the calling machine',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-ssh-'));
  try{
    const helper=join(dir,'ssh-fixture.mjs');
    await writeFile(helper,"const chunks=[];for await(const c of process.stdin)chunks.push(c);const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));console.log(JSON.stringify({goal:request.goal,received:true}));",'utf8');
    const input=Buffer.from(JSON.stringify({goal:'读取合成资料🍎，保留出处。'}),'utf8');
    const result=await runRemote({target,command:'submit',values:{'--request':'secret-local-name.json'},input,
      spawnImpl(command,args,options){
        assert.equal(command,'ssh'); assert.equal(options.shell,false); assert.equal(options.windowsHide,true);
        assert.ok(!args.join(' ').includes('读取')); assert.ok(!args.join(' ').includes('secret-local-name'));
        assert.match(args.at(-1),/'--request' '-'$/);
        return spawn(process.execPath,[helper],options);
      }});
    assert.equal(result.goal,'读取合成资料🍎，保留出处。');
    const bytes=Buffer.from('真实文件字节🍎\n','utf8'), output=join(dir,'local','report.md');
    const artifact={encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),run_id:'run1234'};
    await saveRemoteArtifact(artifact,output);
    assert.deepEqual(await readFile(output),bytes);
    await assert.rejects(saveRemoteArtifact(artifact,output),{code:'EEXIST'});
    await assert.rejects(saveRemoteArtifact({...artifact,sha256:'wrong'},join(dir,'invalid.md')),{code:'REMOTE_ARTIFACT_HASH_MISMATCH'});
    assert.ok(!remoteInvocation(target,'artifact',{'--path':'report.md','--out':output}).join(' ').includes(output));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('SSH failure cannot become an accepted result or echo arbitrary diagnostics',async()=>{
  const options={target,command:'health',values:{}};
  const spawnImpl=(_command,_args,settings)=>spawn(process.execPath,['-e',"console.error('sensitive diagnostic');process.exit(255)"],settings);
  await assert.rejects(runRemote({...options,spawnImpl}),error=>error.code==='SSH_TRANSPORT_FAILED'&&!error.message.includes('sensitive'));
  const status=await runRemote({...options,command:'status',spawnImpl:(_c,_a,settings)=>spawn(process.execPath,['-e',"console.log('[]')"],settings)});
  assert.deepEqual(status,[]);
});

test('the actual remote CLI unwraps the HTTP artifact envelope before local byte export',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-ssh-cli-'));
  const bytes=Buffer.from('远端真实CLI返回的文件🍎\n','utf8');
  const artifact={path:'report.md',encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),run_id:'run1234'};
  const token='test-only-artifact-bridge-token-0000';
  const server=createServer((request,response)=>{
    assert.equal(request.headers.authorization,`Bearer ${token}`);
    assert.match(request.url,/^\/v1\/tasks\/task1234\/artifact\?/);
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({ok:true,result:artifact}));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  try{
    await writeFile(join(dir,'.env'),`BRIDGE_API_TOKEN=${token}\n`,'utf8');
    await writeFile(join(dir,'bridge.local.json'),JSON.stringify({port:server.address().port,dshInstall:dir,runtimeHome:dir,workspaceRoots:[dir]}),'utf8');
    const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));
    const result=await runRemote({target,command:'artifact',values:{'--task':'task1234','--path':'report.md'},
      spawnImpl:(_command,_args,settings)=>spawn(process.execPath,[cli,'artifact','--root',dir,'--task','task1234','--path','report.md'],settings)});
    assert.equal(result.encoding,'base64');
    assert.equal(result.result,undefined);
    const output=join(dir,'received','report.md');
    await saveRemoteArtifact(result,output);
    assert.deepEqual(await readFile(output),bytes);
  }finally{
    await new Promise(done=>{server.close(done);server.closeAllConnections();});
    await rm(dir,{recursive:true,force:true});
  }
});
