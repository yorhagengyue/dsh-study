import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateBundle,persistVerdict} from '../evidence-cycle.mjs';

test('misplaced continuation task ID is rejected before dispatch instead of creating a new task',()=>{
 assert.throws(()=>validateBundle({source_text:'source',request:{task_id:'existing'}}),/TASK_ID_MUST_BE_AT_BUNDLE_TOP_LEVEL/);
 assert.doesNotThrow(()=>validateBundle({source_text:'source',task_id:'existing',request:{}}));
});
test('a caller verdict already in the evidence directory is retained without overwrite or collision',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'review-evidence-'));
 try {
  const filename=join(dir,'verdict.json');
  const original='{"decision":"changes_requested","reasoning":"specific defect"}\n';
  await writeFile(filename,original);
  await persistVerdict(dir,filename,JSON.parse(original));
  assert.equal(await readFile(filename,'utf8'),original);
  await assert.rejects(persistVerdict(dir,join(dir,'other.json'),{decision:'accepted'}),{code:'EEXIST'});
  assert.equal(await readFile(filename,'utf8'),original);
 }finally{await rm(dir,{recursive:true,force:true});}
});
