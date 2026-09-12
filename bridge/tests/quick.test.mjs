import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateQuickInput,validateStaged,stageSource} from '../quick.mjs';

const target={host:'authorized-mac',node:'/opt/node',cli:'/work/project/bridge/cli.mjs'};
const id='quick-550e8400-e29b-41d4-a716-446655440000';
const valid={source_text:'原始资料🍎',goal:'依据来源写说明'};
const staged=bytes=>({workspace:'/work/tasks/'+id,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});

test('quick input rejects missing or oversized source and goal before staging',()=>{
  for(const source_text of [undefined,null,42,'','  ','中'.repeat(45000)]) assert.throws(()=>validateQuickInput({...valid,source_text}),/QUICK_SOURCE_REQUIRED/);
  for(const goal of [undefined,null,42,'','  ','a'.repeat(16001)]) assert.throws(()=>validateQuickInput({...valid,goal}),/QUICK_GOAL_REQUIRED/);
  assert.deepEqual(validateQuickInput(valid),valid);
});

test('prefilled decisions are rejected even when false or null',()=>{
  for(const extra of [{decision:'accepted'},{decision:null},{verdict:false}]) assert.throws(()=>validateQuickInput({...valid,...extra}),/QUICK_VERDICT_MUST_FOLLOW_ACTUAL_REVIEW/);
});

test('stage validation requires exact source hash and byte size and an absolute path',()=>{
  const bytes=Buffer.from(valid.source_text);
  assert.deepEqual(validateStaged(staged(bytes),bytes),staged(bytes));
  for(const override of [{error:'failed'},{size:bytes.length+1},{sha256:'wrong'},{workspace:'relative/task'}]) assert.throws(()=>validateStaged({...staged(bytes),...override},bytes),/QUICK_SOURCE_STAGE_FAILED/);
});

test('stage sends exact UTF-8 source only on stdin under strict host authentication',async()=>{
  const source='中文🍎 source with $(touch bad) and `cmd`';
  const result=await stageSource(target,id,source,(command,args,options)=>{
    assert.equal(command,'ssh');assert.equal(options.windowsHide,true);
    assert.ok(args.includes('BatchMode=yes'));assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(!args.join(' ').includes(source));assert.ok(!args.join(' ').includes('touch bad'));
    assert.ok(args.at(-1).includes(id));
    const helper="const c=[];for await(const b of process.stdin)c.push(b);const bytes=Buffer.concat(c);console.log(JSON.stringify({workspace:'/work/tasks/test',size:bytes.length,sha256:(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')}));";
    return spawn(process.execPath,['--input-type=module','-e',helper],options);
  });
  assert.equal(result.size,Buffer.byteLength(source));
});

test('stage rejects error envelopes even when remote shell exits zero',async()=>{
  await assert.rejects(stageSource(target,id,valid.source_text,(_command,_args,options)=>spawn(process.execPath,['-e',"console.log(JSON.stringify({error:'QUICK_SOURCE_STAGE_FAILED'}));"],options)),/QUICK_SOURCE_STAGE_FAILED/);
});

test('stage rejects nonzero transport exit even after a plausible receipt',async()=>{
  const receipt=JSON.stringify(staged(Buffer.from(valid.source_text)));
  await assert.rejects(stageSource(target,id,valid.source_text,(_command,_args,options)=>spawn(process.execPath,['-e',`console.log(${JSON.stringify(receipt)});process.exitCode=1;`],options)),/QUICK_SOURCE_STAGE_FAILED/);
});

test('stage rejects traversal and shell-shaped IDs without launching SSH',async()=>{
  let called=false;
  for(const invalid of ['../task','quick-../../secret',id+'/../other',id+';touch bad','quick-ABCDEF']) {
    await assert.rejects(stageSource(target,invalid,valid.source_text,()=>{called=true;}),/QUICK_ID_INVALID/);
  }
  assert.equal(called,false);
});
