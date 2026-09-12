import {existsSync, mkdirSync, readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {write, read, safeId, hash, redactor, publicEvent} from './files.mjs';
import {discover, extractionPrompt, validateProfile, compileProfile, activeProfile} from './context.mjs';

export class StudyConnection {
  constructor(controller, config) {
    this.controller=controller; this.config=config; this.workspace=resolve(config.workspace);
    this.root=join(this.workspace,'connection'); this.redact=redactor(config.dshRoot);
    this.runs=new Map(); this.controllers=new Map(); this.disposed=false;
    mkdirSync(join(this.root,'runs'),{recursive:true});
    // The app owns only its connection/ subdirectory; existing user profiles and files are preserved.
    write(join(this.root,'.gitignore'),'*\n!.gitignore\n');
    for(const id of readdirSync(join(this.root,'runs'))) {
      const path=join(this.root,'runs',id,'state.json');
      if(existsSync(path)) {try {const r=read(path);this.runs.set(id,r);}catch{/* corrupt evidence remains on disk */}}
    }
  }
  async initialize({autoImport=false}={}) {
    if(existsSync(join(this.config.dshRoot,'runtime','study-app','installing.json')))return;
    for(const r of this.runs.values())if(['accepted','running','submitting'].includes(r.status)&&r.session_id)this.monitor(r).catch(e=>this.fail(r,e));
    if(autoImport && this.config.autoImport && !activeProfile(this.workspace) && ![...this.runs.values()].some(r=>r.kind==='onboarding')) await this.onboard({id:'first-onboarding',reasoning_effort:'max'});
  }
  save(r) {
    r.updated_at=Date.now(); r.metrics={...r.metrics,
      api_to_complete_ms:r.completed_ms? r.completed_ms-r.received_ms:null,
      api_to_render_ack_ms:r.display?.ack_ms? r.display.ack_ms-r.received_ms:null,
      user_to_render_ms:r.display?.user_to_render_ms??null,
      answer_chars:r.output?.length??0};
    write(join(this.root,'runs',r.id,'state.json'),this.redact(r));
  }
  fail(r,e) {r.status=r.status==='submitting'?'submission_unknown':'failed';r.error=this.redact(String(e?.message??e));this.save(r);}
  get(id) {const r=this.runs.get(safeId(id));if(!r)throw new Error('RUN_NOT_FOUND');return r;}
  async health() {
    let catalog,error;
    try {catalog=await this.controller.modelCatalog();}catch(e){error=this.redact(String(e.message));}
    const probe=join(this.root,'health.json');write(probe,{at:Date.now()});
    const writable=read(probe).at>0;
    const profile=activeProfile(this.workspace);
    return {version:'0.2.0',cordis_plugin:true,workspace:this.workspace,storage:writable?'ready':'failed',
      connection:'authenticated',model_catalog:catalog??null,error:error??null,initialization_error:this.initializationError??null,
      model_generation:[...this.runs.values()].some(r=>r.status==='completed'&&r.output)?'verified_by_completed_run':'not_yet_verified',
      profile:profile?{id:profile.id,version:profile.version,facts:profile.facts.filter(f=>f.enabled).length,coverage:'partial',validation:profile.validation}:null,
      display:[...this.runs.values()].some(r=>r.display?.ack_ms)?'browser_ack_received':'not_observed'};
  }
  list() {return [...this.runs.values()].sort((a,b)=>b.received_ms-a.received_ms).map(({id,kind,title,status,received_ms,updated_at,metrics,session_id})=>({id,kind,title,status,received_ms,updated_at,metrics,session_id}));}
  sources(paths=[]) {return discover({paths:[...(this.config.sourcePaths??[]),...paths],redact:this.redact});}
  async onboard(request={}) {
    const id=safeId(request.id??'onboard-'+randomUUID());
    const onboardingHash=hash(JSON.stringify(this.redact(request)));
    if(this.runs.has(id)){const old=this.get(id);if(old.request.onboarding_request_hash!==onboardingHash)throw new Error('IDEMPOTENCY_CONFLICT');return old;}
    if([...this.runs.values()].some(r=>r.kind==='onboarding'&&['preparing','submitting','accepted','running'].includes(r.status)))throw new Error('ONBOARDING_BUSY');
    const bundle=this.sources(request.paths??[]);
    if(!bundle.sources.length)throw new Error('NO_READABLE_SOURCES');
    const r=await this.submit({...request,id,onboarding_request_hash:onboardingHash,title:'自动导入个人背景',goal:extractionPrompt(bundle)+'\n补充：不要提取邮箱、电话号码、住址或课程系统内部数字编号。每条 text 只概括 quote 能直接支持的一个事实，不额外加其他字段。避免旧截止期当现状。保留用户要求例行工作用轻量模型的习惯。',use_profile:false,reasoning_effort:request.reasoning_effort??'max'},'onboarding',bundle);
    return r;
  }
  async submit(request,kind='task',bundle=null) {
    const id=safeId(request.id??'run-'+randomUUID());
    const requestHash=hash(JSON.stringify(this.redact(request)));
    if(this.runs.has(id)) {
      const prior=this.get(id);if(prior.request_hash!==requestHash)throw new Error('IDEMPOTENCY_CONFLICT');return prior;
    }
    if(typeof request.goal!=='string'||!request.goal.trim()||request.goal.length>900000)throw new Error('INVALID_GOAL');
    const effort=request.reasoning_effort??'low';
    if(!['off','low','high','max'].includes(effort))throw new Error('INVALID_REASONING_EFFORT');
    const r={schema_version:2,id,kind,title:String(request.title??'学习任务').slice(0,160),request_hash:requestHash,
      received_ms:Date.now(),user_sent_ms:request.user_sent_evidence==='browser_submit_handler'?request.user_sent_ms??null:null,
      status:'preparing',output:'',review:{decision:'pending_review'},display:{status:'not_observed'},metrics:{},request:this.redact(request)};
    this.runs.set(id,r);this.save(r);
    try {
      let context=''; const profile=request.use_profile===false?null:activeProfile(this.workspace);
      if(profile) {
        const categories=request.context_categories??['person','education','working-style'];
        const facts=profile.facts.filter(f=>f.enabled&&categories.includes(f.category));
        r.profile_used={id:profile.id,version:profile.version,fact_ids:facts.map(f=>f.id)};
        context='\n<personal_context_data>\n'+JSON.stringify({facts,unknowns:profile.unknowns})+'\n</personal_context_data>';
      }
      const sources=request.sources??[];
      if(!Array.isArray(sources)||sources.length>32||sources.some(s=>typeof s.text!=='string'||s.text.length>500000))throw new Error('INVALID_SOURCES');
      let prompt=request.goal+context;
      if(sources.length)prompt+='\n<untrusted_source_material>\n'+JSON.stringify(sources)+'\n</untrusted_source_material>';
      prompt=this.redact(prompt);
      r.input={user_instruction:request.user_instruction??request.goal,effective_prompt:prompt,prompt_sha256:hash(prompt),sources:this.redact(sources)};
      r.metrics.input_bytes=Buffer.byteLength(prompt);
      const dir=join(this.root,'runs',id);
      write(join(dir,'input.json'),this.redact(r.input));if(bundle)write(join(dir,'source-bundle.json'),bundle);
      const ownedPrior=request.continue_run_id?this.get(request.continue_run_id):null;
      if(ownedPrior&&!['completed','stopped'].includes(ownedPrior.status))throw new Error('PRIOR_RUN_NOT_TERMINAL');
      if(ownedPrior && [...this.runs.values()].some(x=>x.id!==id&&x.session_id===ownedPrior.session_id&&['submitting','accepted','running'].includes(x.status)))throw new Error('SESSION_BUSY');
      const session=ownedPrior?{sessionId:ownedPrior.session_id}:await this.controller.create({cwd:dir});
      r.session_id=session.sessionId;
      r.selection=(await this.controller.selectModel({sessionId:r.session_id,provider:this.config.provider,model:this.config.model,reasoningEffort:effort})).selected;
      r.health_before={plugin:'native_cordis',storage:'input_written',session:'created_or_resumed',selection:r.selection,model_generation:'not_yet_verified_for_this_run'};
      await this.controller.rename({sessionId:r.session_id,title:r.title});
      const baseline=await this.controller.inspect(r.session_id);
      r.baseline_seq=Math.max(-1,...baseline.events.map(e=>e.seq));
      r.payload={requestId:'request-'+randomUUID(),sessionId:r.session_id,mode:'queue',content:[{type:'text',text:prompt}]};
      r.status='submitting';r.native_send_ms=Date.now();this.save(r);
      r.receipt=await this.controller.prompt(r.payload,new AbortController().signal);
      r.accepted_ms=Date.now();r.status='accepted';this.save(r);
      this.monitor(r).catch(e=>this.fail(r,e));
    }catch(e){this.fail(r,e);if(r.status==='submission_unknown'&&r.session_id)this.monitor(r).catch(error=>this.fail(r,error));}
    return r;
  }
  async monitor(r) {
    if(this.controllers.has(r.id))return;
    const abort=new AbortController();this.controllers.set(r.id,abort);
    try {
      while(!abort.signal.aborted&&!this.disposed) {
        const snap=await this.controller.inspect(r.session_id,abort.signal);
        const all=snap.events.filter(e=>e.seq>r.baseline_seq);
        const events=all.map(publicEvent).filter(Boolean).map(this.redact);
        const cursor=all.at(-1)?.seq??r.baseline_seq;
        if(cursor!==r.cursor) {
          r.cursor=cursor;
          const messages=events.filter(e=>e.type==='assistant/message');
          r.output=messages.flatMap(e=>(e.data.message?.content??[]).filter(p=>p.type==='text').map(p=>p.text)).join('\n\n');
          r.metrics.tool_calls=events.filter(e=>e.type==='tool/call').length;
          r.metrics.usage=messages.map(e=>e.data.usage??{});
          const dir=join(this.root,'runs',r.id);
          write(join(dir,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
          write(join(dir,'output.md'),r.output);
          if(r.output&&!r.first_output_ms)r.first_output_ms=Date.now();
          const end=all.find(e=>e.type==='turn/end');
          if(end) {
            r.completion_reason=end.data.reason;r.completed_ms=end.time;
            r.status=end.data.reason.kind==='completed'?'completed':'stopped';
            if(r.status==='completed'&&!r.output){r.status='failed';r.error='EMPTY_OUTPUT';}
            if(r.kind==='onboarding'&&r.status==='completed') {
              const bundle=read(join(dir,'source-bundle.json'));
              const parsed=validateProfile(r.output,bundle);
              const prior=activeProfile(this.workspace);
              const profile={id:prior?.id??'profile-'+randomUUID(),version:(prior?.version??0)+1,created_at:Date.now(),...parsed};
              r.profile_created={id:profile.id,version:profile.version,path:compileProfile(this.workspace,profile,bundle),facts:profile.facts.length,rejected:profile.rejected.length};
              r.output_summary=`已导入 ${profile.facts.length} 条有原文引用的背景；${profile.rejected.length} 条拒收。语义与缺失项仍可核对。`;
            }
            r.health_after={storage:'output_written',model_generation:r.status==='completed'&&r.output?'verified_by_this_run':'not_verified',display:'separate_browser_ack_required'};
            r.finished_observed_ms=Date.now();this.save(r);return;
          }
          r.status='running';this.save(r);
        }
        if(Date.now()-r.received_ms>600000){r.status='needs_attention';r.error='TEN_MINUTE_OBSERVATION_LIMIT_NO_RESUBMIT';this.save(r);return;}
        await new Promise(resolve=>{const t=setTimeout(resolve,200);t.unref?.();});
      }
    }finally{this.controllers.delete(r.id);}
  }
  review(id, verdict) {
    const r=this.get(id);
    if(!['accepted','changes_requested'].includes(verdict.decision)||!verdict.reviewer||!verdict.reasoning)throw new Error('INVALID_REVIEW');
    if(!['completed','stopped','failed'].includes(r.status))throw new Error('RUN_NOT_TERMINAL');
    r.review={...this.redact(verdict),at:Date.now()};
    const p=join(this.root,'runs',id,'reviews.jsonl');
    write(p,(existsSync(p)?readFileSync(p,'utf8'):'')+JSON.stringify(r.review)+'\n');this.save(r);return r.review;
  }
  display(id, observation) {
    const r=this.get(id);
    if(r.status!=='completed'||observation.output_hash!==hash(r.output)||observation.visible!==true||observation.chars!==r.output.length)throw new Error('DISPLAY_NOT_COMPLETE');
    if(!r.display.ack_ms) {
      const latency=observation.user_to_render_ms;
      r.display={status:'browser_render_ack',ack_ms:Date.now(),client_rendered_ms:observation.rendered_ms,
        user_to_render_ms:r.user_sent_ms&&Number.isFinite(latency)&&latency>=0?latency:null,
        evidence:'Browser reports visible document, matching full output, two animation frames; not proof of human attention.'};
      this.save(r);
    }
    return r.display;
  }
  profile() {return activeProfile(this.workspace);}
  setFact(id,enabled) {
    const profile=this.profile();if(!profile)throw new Error('PROFILE_NOT_READY');
    const fact=profile.facts.find(f=>f.id===id);if(!fact||typeof enabled!=='boolean')throw new Error('INVALID_FACT');
    const bundle=read(join(this.root,'profiles',profile.id,'v'+profile.version,'sources.json'));
    fact.enabled=enabled;profile.version++;compileProfile(this.workspace,profile,bundle);return profile;
  }
  async cancel(id) {const r=this.get(id);if(!r.session_id)throw new Error('NO_SESSION');if(!['accepted','running','submission_unknown','needs_attention'].includes(r.status))throw new Error('RUN_NOT_ACTIVE');return this.controller.cancel({sessionId:r.session_id});}
  dispose(){this.disposed=true;for(const a of this.controllers.values())a.abort();}
}
