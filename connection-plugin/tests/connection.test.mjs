import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync,readdirSync,existsSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {write,hash,publicEvent,redactor,readRecord} from '../files.mjs';
import {discover,buildCatalog,activeCatalog,contextIndex,readSource,setSource} from '../context.mjs';
import {StudyConnection} from '../engine.mjs';
import {loadRequest} from '../../app/connection-client.mjs';

const fixture=()=>mkdtempSync(join(tmpdir(),'study-connection-'));
test('Markdown request preserves Chinese instructions and typed controls',()=>{
 const dir=fixture(),path=join(dir,'task.md');write(path,'---\nid: md-task\nreasoning_effort: max\nuse_context: false\n---\n解释完整，不必过短。');
 assert.deepEqual(loadRequest(path),{id:'md-task',reasoning_effort:'max',use_context:false,goal:'解释完整，不必过短。'});
});
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
test('A new request cannot overwrite a legacy run or unreadable evidence directory',async()=>{
 const {engine,dir,calls}=harness(),old=join(dir,'connection','runs','legacy');write(join(old,'state.json'),{schema_version:2});write(join(old,'output.md'),'Original evidence');
 await assert.rejects(engine.submit({id:'legacy',goal:'New request'}),/RUN_ID_RESERVED/);
 assert.equal(calls(),0);assert.equal(readFileSync(join(old,'output.md'),'utf8'),'Original evidence');engine.dispose();
});
function catalogFixture(dir) {
 const home=join(dir,'person'),desktopPath=join(dir,'Desktop'),file=join(home,'school.md');mkdirSync(desktopPath,{recursive:true});
 write(file,'# Example school\n\nCourse Alpha special detail.\n'+('long private text\n'.repeat(60))+'End of detail.');
 const bundle=discover({home,desktopPath,paths:[file]});buildCatalog(dir,bundle);return{file,bundle,id:bundle.sources[0].id};
}
test('Catalog contains pointers, not source bodies; reads are current, paginated, redacted and revocable',()=>{
 const dir=fixture(),{file,id}=catalogFixture(dir);
 assert(!contextIndex(dir).content.includes('Course Alpha'));
 assert(!readFileSync(join(dir,'connection','context','CATALOG.md'),'utf8').includes('long private text'));
 const one=readSource(dir,{source_id:id,max_chars:256});assert(one.next_line);assert(one.content.length<=256);
 const next=readSource(dir,{source_id:id,start_line:one.next_line,max_chars:256});assert.equal(next.start_line,one.end_line+1);
 write(file,'# Updated\nsecret text');const newer=readSource(dir,{source_id:id},x=>x.replace('secret','[REDACTED]'));assert(newer.changed_since_index);assert(!newer.content.includes('secret'));
 setSource(dir,id,false);assert.throws(()=>readSource(dir,{source_id:id}),/DISABLED/);assert.throws(()=>readSource(dir,{source_id:'unregistered'}),/NOT_REGISTERED/);
});
test('Brief is injected in full; detailed documents and old profiles are not preloaded; evidence is Markdown',async()=>{
 const {engine,dir}=harness(),{id}=catalogFixture(dir);
 write(join(dir,'connection','context','BRIEF.md'),'# Brief\nSimple stable preference.');
 write(join(dir,'connection','active-profile.json'),{facts:['obsolete profile']});
 const r=await engine.submit({id:'index-task',goal:'Explain'});await new Promise(r=>setTimeout(r,20));
 assert(r.input.effective_prompt.includes('Simple stable preference'));assert(r.input.effective_prompt.includes('INDEX.md'));
 assert(!r.input.effective_prompt.includes('Course Alpha'));assert(!r.input.effective_prompt.includes('obsolete profile'));
 assert.equal(r.metrics.preloaded_source_bytes,0);assert.equal(r.metrics.user_to_visible_ms,null);
 assert(readdirSync(join(dir,'connection','runs',r.id)).every(p=>p.endsWith('.md')));
 assert.equal(readRecord(join(dir,'connection','runs',r.id,'STATUS.md')).output,'完整答案');
 assert.equal(r.review.decision,'pending_review');engine.review(r.id,{decision:'accepted',reviewer:'test',reasoning:'Read actual fixture output'});
 const engine2=new StudyConnection(engine.controller,engine.config);assert.equal(engine2.get(r.id).review.decision,'accepted');
 assert.equal(engine.readContext({source_id:id,query:'Alpha'}).found,true);
 const off=await engine.submit({id:'no-background',goal:'Explain',use_context:false});assert.equal(off.input.effective_prompt,'Explain');engine.dispose();engine2.dispose();
});
test('Refresh preserves brief and disabled sources and never calls the model',async()=>{
 const {engine,dir,calls}=harness(),{bundle,id}=catalogFixture(dir);engine.sources=()=>bundle;
 write(join(dir,'connection','context','BRIEF.md'),'Custom brief');setSource(dir,id,false);
 const result=await engine.onboard();assert.equal(result.model_calls,0);assert.equal(calls(),0);
 assert.equal(readFileSync(join(dir,'connection','context','BRIEF.md'),'utf8'),'Custom brief');assert.equal(activeCatalog(dir).sources[0].enabled,false);engine.dispose();
});
test('Explicit history sources only return user text and reject invalid ranges',()=>{
 const dir=fixture(),home=join(dir,'home'),desktopPath=join(dir,'Desktop');mkdirSync(desktopPath,{recursive:true});
 const history=join(dir,'history.jsonl');write(history,JSON.stringify({type:'user',message:{content:'User material'}})+'\n'+JSON.stringify({type:'assistant',message:{content:'Private assistant material'}}));
 const bundle=discover({home,desktopPath,paths:[history]});buildCatalog(dir,bundle);const out=readSource(dir,{source_id:bundle.sources[0].id});assert(out.content.includes('User material'));assert(!out.content.includes('Private assistant'));
 const source=activeCatalog(dir).sources[0];assert.throws(()=>readSource(dir,{source_id:source.id,start_line:0}),/INVALID_READ/);
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
