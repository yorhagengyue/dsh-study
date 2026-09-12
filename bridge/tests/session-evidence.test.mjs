import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeSession, captureSession, validateSessionEvidence} from '../session-evidence.mjs';

test('session evidence preserves visible tool I/O and rejects internal reasoning and system surfaces', () => {
  const rows = [
    {type:'system/message',data:{message:'PRIVATE_SYSTEM'}},
    {type:'agent/inbox/spliced',data:{inserted:'PRIVATE_INBOX'}},
    {type:'user/message',data:{content:[{type:'text',text:'source task'}]}},
    {type:'assistant/message',data:{message:{source:{provider:'test',model:'flash'},content:[{type:'reasoning',text:'PRIVATE_REASONING'},{type:'text',text:'visible output'}]},stream:[{text:'PRIVATE_STREAM'}]}},
    {type:'tool/call',data:{callId:'call1',name:'read',arguments:{path:'source.md'}}},
    {type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:'call1',isError:true,content:[{type:'text',text:'missing source'}]}]},meta:{private:'PRIVATE_META'}}},
  ];
  const evidence=sanitizeSession(rows.map(JSON.stringify).join('\n'));
  assert.equal(evidence.event_count,4);
  assert.ok(!evidence.jsonl.includes('PRIVATE_'));
  const events=evidence.jsonl.trim().split('\n').map(JSON.parse);
  assert.equal(events[1].model.model,'flash');
  assert.equal(events[2].call.arguments.path,'source.md');
  assert.equal(events[3].content[0].isError,true);
  assert.equal(events[3].content[0].content[0].text,'missing source');
});

test('credential redaction removes supplied secrets and sensitive argument fields before serialization', () => {
  const secret='synthetic-credential-value';
  const rows=[{type:'user/message',data:{content:[{type:'text',text:`prefix ${secret} Bearer abc123 sk-abcdefghijklmnop`}]}},{type:'tool/call',data:{name:'fetch',arguments:{apiKey:'unknown-key',password:'unknown-password',safe:'kept',thinking:'hidden'}}}];
  const evidence=sanitizeSession(rows.map(JSON.stringify).join('\n'),[secret]);
  for(const forbidden of [secret,'abc123','sk-abcdefghijklmnop','unknown-key','unknown-password','hidden']) assert.ok(!evidence.jsonl.includes(forbidden));
  assert.ok(evidence.jsonl.includes('kept'));
});

test('invalid session path identifiers fail before SSH is invoked', async () => {
  await assert.rejects(captureSession({},'../elsewhere','valid'),/SESSION_EVIDENCE_INVALID_ID/);
});

test('error envelopes and incomplete payloads are rejected independently of SSH exit status', () => {
  for (const result of [{error:'SESSION_EVIDENCE_FAILED'}, {}, {task_id:'task',session_id:'session',event_count:1,jsonl:'',text:''}]) {
    assert.throws(()=>validateSessionEvidence(result,'task','session'),/SESSION_EVIDENCE_INVALID_RESPONSE/);
  }
});
