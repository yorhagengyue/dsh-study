import z from '@deepseek-ai/schemastery';
import {Service} from '@deepseek-ai/cordis';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {readFileSync,existsSync} from 'node:fs';
import {StudyConnection} from './engine.mjs';
import {desktop, hash} from './files.mjs';
import {join} from 'node:path';
import {homedir} from 'node:os';

export const name='dsh-study-connection';
export const inject=['webServer','connection','sessionController','tools'];
export const Config=z.object({workspace:z.string(),dshRoot:z.string(),sourcePaths:z.array(String).default([]),autoImport:z.boolean().default(false),provider:z.string().default('deepseek-official'),model:z.string().default('deepseek-flash')});
export function apply(ctx,config) {
  const engine=new StudyConnection(ctx.sessionController,{...config,workspace:config.workspace??join(desktop(),'DSH-Study'),dshRoot:config.dshRoot??join(homedir(),'dsh')});
  class ConnectionService extends Service {constructor(){super(ctx,'studyConnection');} status(){return engine.health();} profile(){return engine.profile();}}
  new ConnectionService();
  ctx.on('dispose',()=>engine.dispose());
  // Injected feature plugins can activate after the root ready event (live profile reload).
  // Schedule from this fiber's activation so cold start and live loading both initialize.
  ctx.effect(()=>{const timer=setTimeout(()=>engine.initialize().catch(e=>{engine.initializationError=String(e.message??e);}),0);return()=>clearTimeout(timer);});
  const routes=new Map([
    ['/study',['text/html; charset=utf-8','web/index.html']],
    ['/study/app.js',['text/javascript; charset=utf-8','web/app.js']],
    ['/study/app.css',['text/css; charset=utf-8','web/app.css']]
  ]);
  const reply=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(engine.redact(value)));};
  async function handler(req,res) {
    const rejection=ctx.connection.requestRejection(req);
    if(rejection){res.writeHead(rejection,{'content-type':'text/plain; charset=utf-8'});res.end('请先通过 DSH 正常启动入口登录，再进入 /study。');return;}
    const url=new URL(req.url,'http://localhost');
    if(routes.has(url.pathname)&&req.method==='GET') {
      const [type,file]=routes.get(url.pathname);
      res.writeHead(200,{'content-type':type,'cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'",'x-content-type-options':'nosniff'});
      res.end(readFileSync(new URL(file,import.meta.url)));return;
    }
    try {
      let body={};
      if(req.method==='POST') {
        if(!String(req.headers['content-type']).startsWith('application/json'))return reply(res,415,{error:'JSON_REQUIRED'});
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1200000)return reply(res,413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      }
      const action=url.pathname.slice('/study/api/'.length);
      let result;
      if(req.method==='GET'&&action==='health')result=await engine.health();
      else if(req.method==='GET'&&action==='runs')result=engine.list();
      else if(req.method==='GET'&&action==='profile')result=engine.profile();
      else if(req.method==='GET'&&action==='sources'){const b=engine.sources();result={...b,sources:b.sources.map(({content,...s})=>s)};}
      else if(req.method==='GET'&&action==='events'){const r=engine.get(url.searchParams.get('id'));const path=join(engine.root,'runs',r.id,'events.jsonl');result=existsSync(path)?readFileSync(path,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];}
      else if(req.method==='GET'&&action.startsWith('runs/')){const r=engine.get(action.slice(5));result={...r,output_hash:hash(r.output),evidence_dir:join(engine.root,'runs',r.id)};}
      else if(req.method==='POST'&&action==='onboard')result=await engine.onboard(body);
      else if(req.method==='POST'&&action==='initialize'){await engine.initialize({autoImport:true});result={initialized:true};}
      else if(req.method==='POST'&&action==='tasks')result=await engine.submit(body);
      else if(req.method==='POST'&&action==='review')result=engine.review(body.id,body.verdict);
      else if(req.method==='POST'&&action==='display')result=engine.display(body.id,body);
      else if(req.method==='POST'&&action==='cancel')result=await engine.cancel(body.id);
      else if(req.method==='POST'&&action==='profile/fact')result=engine.setFact(body.id,body.enabled);
      else return reply(res,404,{error:'NOT_FOUND'});
      reply(res,200,result);
    }catch(e){reply(res,400,{error:String(e.message??e)});}
  }
  ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:'/study',handler}));
  // An ordinary link in the native DSH page; no core file edits or forced redirects.
  ctx.on('webserver/index-inject',table=>{
    table.push({kind:'html',placement:'body',html:'<a href="/study" style="position:fixed;right:16px;bottom:12px;z-index:9999;background:#fff;color:#111;padding:8px 12px;border:1px solid #aaa;border-radius:8px">学习连接</a>'});
    table.push({kind:'script',placement:'body',text:'if(location.hash==="#study") location.replace("/study");'});
  });
  for(const [name,description,execute] of [
    ['study_connection_status','读取学习连接插件健康状态，不发起新模型任务。',()=>engine.health()],
    ['study_personal_context','读取当前学习用户的有来源背景；没有背景则明确返回 null。',()=>engine.profile()]
  ])ctx.tools.register(defineTool({name,description,parameters:{},output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},isParallelSafe:()=>true,execute}));
}
