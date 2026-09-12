import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
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
