import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {write,hash,publicEvent,redactor} from '../files.mjs';
import {discover,validateProfile,compileProfile,activeProfile} from '../context.mjs';
import {StudyConnection} from '../engine.mjs';

const fixture=()=>mkdtempSync(join(tmpdir(),'study-connection-'));
test('Discovery follows canonical relative school links, excludes archive, secrets and unrelated project documents',()=>{
 const dir=fixture(),home=join(dir,'user'),desktopPath=join(dir,'Desktop');mkdirSync(desktopPath,{recursive:true});
 const canonical=join(desktopPath,'context','shared','CLAUDE.md');
 write(join(home,'.codex','AGENTS.md'),'上游个人真源 `'+canonical+'`\n学校课程 `shared/projects/school/SCHOOL.md`\n旧历史快照 `'+join(home,'archive.md')+'`\n');
 write(canonical,'本人是学生\n课程 `shared/projects/school/SCHOOL.md`\n开发文件 `project.md`\n');
 write(join(desktopPath,'context','shared','projects','school','SCHOOL.md'),'目前有两个课程');
 write(join(home,'archive.md'),'旧内容');write(join(home,'.env'),'API_KEY=secret-secret');
 const d=discover({home,desktopPath,paths:[join(home,'.env')]});
 assert(d.sources.some(s=>s.path.endsWith('SCHOOL.md')));assert(!d.sources.some(s=>s.path.includes('archive')));assert(!d.sources.some(s=>s.path.endsWith('.env')));
 assert(d.skipped.some(s=>s.reason==='historical_reference'));
});
test('Exact quotes required; unsupported or fabricated facts do not enter the profile',()=>{
 const bundle={sources:[{id:'s',content:'本人学习两个课程。',sha256:'abc'}]};
 const p=validateProfile(JSON.stringify({facts:[{category:'education',text:'学习两个课程',quote:'学习两个课程',source_id:'s'},{category:'person',text:'金融专业',quote:'金融学专业',source_id:'s'}]}),bundle);
 assert.equal(p.facts.length,1);assert.equal(p.rejected.length,1);
 const dir=fixture();compileProfile(dir,{id:'p',version:1,...p},bundle);assert.equal(activeProfile(dir).facts.length,1);
 assert.throws(()=>validateProfile('{"facts":[]}',bundle),/NO_GROUNDED/);
});
test('Secret values and hidden reasoning are excluded from public evidence',()=>{
 const dir=fixture();write(join(dir,'.env'),'DEEPSEEK_API_KEY=sk-01234567890123456789\n');
 assert(!redactor(dir)({text:'sk-01234567890123456789'}).text.includes('012345'));
 const e=publicEvent({type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'private'},{type:'text',text:'public'}]},stream:['private']}});
 assert(!JSON.stringify(e).includes('private'));assert.equal(publicEvent({type:'system/prompt'}),null);
});
function harness(){
 const dir=fixture(),events=new Map();let calls=0;
 const controller={modelCatalog:async()=>({groups:[],failures:[]}),create:async()=>{const sessionId='s'+events.size;events.set(sessionId,[]);return{sessionId};},rename:async()=>{},selectModel:async x=>({selected:x}),inspect:async id=>({events:events.get(id)}),prompt:async p=>{calls++;const ev=events.get(p.sessionId),seq=ev.length;ev.push({type:'assistant/message',seq,time:Date.now(),data:{message:{content:[{type:'text',text:'完整答案'}]},usage:{outputTokens:4}}},{type:'turn/end',seq:seq+1,time:Date.now(),data:{reason:{kind:'completed'}}});return{accepted:true};},cancel:()=>({accepted:true})};
 const engine=new StudyConnection(controller,{workspace:dir,dshRoot:dir,provider:'p',model:'m'});return{engine,calls:()=>calls,dir};
}
test('Native run persists complete input/output, idempotent submit and same-session correction',async()=>{
 const {engine,calls,dir}=harness();const req={id:'one',goal:'解释概念'};
 const r=await engine.submit(req);await new Promise(r=>setTimeout(r,20));
 assert.equal(r.status,'completed');assert.equal(r.output,'完整答案');await engine.submit(req);assert.equal(calls(),1);
 await assert.rejects(engine.submit({...req,goal:'不同'}),/IDEMPOTENCY_CONFLICT/);
 const next=await engine.submit({id:'two',goal:'再解释',continue_run_id:'one'});await new Promise(r=>setTimeout(r,20));
 assert.equal(r.session_id,next.session_id);assert.equal(next.output,'完整答案');assert.equal(calls(),2);
 assert.equal(readFileSync(join(dir,'connection','runs','one','output.md'),'utf8'),'完整答案');engine.dispose();
});
test('Render proof needs exact output and cannot manufacture external user send timing',async()=>{
 const {engine}=harness();const r=await engine.submit({id:'one',goal:'解释'});await new Promise(r=>setTimeout(r,20));
 assert.throws(()=>engine.display(r.id,{output_hash:'wrong',visible:true,chars:4}),/DISPLAY_NOT_COMPLETE/);
 engine.display(r.id,{output_hash:hash(r.output),visible:true,chars:r.output.length,rendered_ms:Date.now(),user_to_render_ms:30});
 assert.equal(r.display.user_to_render_ms,null);assert(r.metrics.api_to_render_ack_ms>=0);assert.equal(r.review.decision,'pending_review');
 engine.review('one',{decision:'accepted',reviewer:'independent-test',reasoning:'read exact expected answer'});assert.equal(r.review.decision,'accepted');engine.dispose();
});
test('Disabled facts are not injected; source tools remain untouched',async()=>{
 const {engine,dir}=harness();const bundle={sources:[]};compileProfile(dir,{id:'p',version:1,facts:[{id:'f1',category:'person',text:'active person',enabled:true},{id:'f2',category:'person',text:'disabled person',enabled:false}],unknowns:[],rejected:[]},bundle);
 const r=await engine.submit({id:'p-test',goal:'who'});assert(r.input.effective_prompt.includes('active person'));assert(!r.input.effective_prompt.includes('disabled person'));assert.deepEqual(r.profile_used.fact_ids,['f1']);engine.dispose();
});
test('Health is lossless JSON for native DSH tool output validation',async()=>{
 const {engine}=harness();const health=await engine.health();assert.deepEqual(health,JSON.parse(JSON.stringify(health)));engine.dispose();
});
test('Plugin activation does not begin import until the App explicitly initializes',async()=>{
 const {engine}=harness();engine.config.autoImport=true;let started=0;engine.onboard=async()=>{started++;};
 await engine.initialize();assert.equal(started,0);await engine.initialize({autoImport:true});assert.equal(started,1);engine.dispose();
});
test('An uncertain prompt receipt is reconciled from the native journal without resubmission',async()=>{
 const {engine,calls}=harness(),prompt=engine.controller.prompt;
 engine.controller.prompt=async p=>{await prompt(p);throw new Error('RECEIPT_INTERRUPTED');};
 const r=await engine.submit({id:'uncertain',goal:'explain'});await new Promise(r=>setTimeout(r,20));assert.equal(r.status,'completed');assert.equal(calls(),1);engine.dispose();
});
