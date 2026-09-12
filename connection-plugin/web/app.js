const $=id=>document.getElementById(id);
let current=null, latest=null, run=null, polling=false, profileVersion=null, renderedId=null, listSignature=null;
const setText=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
const acknowledged=new Set(), submits=new Map();
const labels={preparing:'准备中',submitting:'正在派工',accepted:'已接收',running:'执行中',completed:'生成完成 · 请查看验收状态',failed:'失败',stopped:'已停止',submission_unknown:'派工状态待确认，请勿重发',needs_attention:'需要检查'};
async function api(path,data) {const r=await fetch('/study/api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});let v;try{v=await r.json();}catch{throw new Error('连接失效，请通过 DSH 启动入口重新登录。');}if(!r.ok)throw new Error(v.error??'请求失败');return v;}
const fail=e=>{$('error').textContent=e.message;};
function time() {
  if(!run)return;
  const ms=run.display?.user_to_render_ms??run.metrics.api_to_render_ack_ms??(run.completed_ms??Date.now())-run.received_ms;
  const label=run.display?.user_to_render_ms!=null?'本页发送到完整显示':run.display?.ack_ms?'API接收到显示回执':'API接收到当前状态';
  setText('time',`${label}：${(ms/1000).toFixed(3)} 秒。生成：${run.metrics.api_to_complete_ms==null?'进行中':(run.metrics.api_to_complete_ms/1000).toFixed(3)+' 秒'}。`);
}
async function profile() {
  const p=await api('profile');
  if(!p){$('profileTitle').textContent='尚未导入个人背景';return;}
  const version=p.id+':'+p.version;if(version===profileVersion)return;profileVersion=version;
  $('profileTitle').textContent=`${p.facts.filter(f=>f.enabled).length} 条背景 · v${p.version} · 来源覆盖部分完成`;
  $('profile').replaceChildren();
  for(const f of p.facts) {const row=document.createElement('p'),label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=f.enabled;check.addEventListener('change',async()=>{try{await api('profile/fact',{id:f.id,enabled:check.checked});await profile();}catch(e){fail(e);}});label.append(check,document.createTextNode(f.text));row.append(label);const detail=document.createElement('details'),title=document.createElement('summary'),quote=document.createElement('pre');title.textContent='出处 '+f.source_id;quote.textContent=f.quote;detail.append(title,quote);row.append(detail);$('profile').append(row);}
  const unknown=document.createElement('p');unknown.textContent='待核实：'+p.unknowns.join('；');$('profile').append(unknown);
}
async function refreshHealth(){try{const h=await api('health');$('health').textContent=`Cordis 插件已连接 · 存储 ${h.storage} · 模型${h.model_generation==='verified_by_completed_run'?'已有真实生成记录':'尚待真实生成'} · ${h.workspace}`;await profile();}catch(e){fail(e);}}
async function poll() {
  if(polling)return;polling=true;
  try {
    const rows=await api('runs');if($('error').textContent.includes('连接失效'))$('error').textContent='';
    if(rows[0]&&rows[0].id!==latest){latest=rows[0].id;if($('follow').checked||!current)current=latest;}
    const signature=JSON.stringify(rows.map(({id,title,status})=>({id,title,status})));
    if(signature!==listSignature){listSignature=signature;$('runs').replaceChildren();for(const r of rows){const b=document.createElement('button');b.textContent=r.title+' · '+(labels[r.status]??r.status);b.addEventListener('click',()=>{current=r.id;$('follow').checked=false;poll();});$('runs').append(b);}}
    if(current){
      const next=await api('runs/'+encodeURIComponent(current));run=next;
      setText('title',run.title);setText('status',`${labels[run.status]??run.status} · 验收：${run.review.decision}${run.error?' · '+run.error:''}`);
      setText('answer',run.output||'等待 DSH 输出…');setText('summary',run.output_summary??'');
      setText('log',JSON.stringify(run,null,2));setText('evidence','完整日志目录：'+run.evidence_dir);
      $('cancel').hidden=!['accepted','running'].includes(run.status);time();
      if(renderedId!==run.id){renderedId=run.id;$('events').textContent='';$('title').scrollIntoView({block:'start'});}
      if(run.status==='completed'&&run.output&&!acknowledged.has(run.id)&&document.visibilityState==='visible') {
        const candidate=run;
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        if(current===candidate.id&&$('answer').textContent===candidate.output&&document.visibilityState==='visible') {
          const local=submits.get(candidate.id);
          await api('display',{id:candidate.id,visible:true,rendered_ms:Date.now(),output_hash:candidate.output_hash,chars:candidate.output.length,user_to_render_ms:local==null?null:performance.now()-local});
          acknowledged.add(candidate.id);await refreshHealth();
        }
      }
    }
  }catch(e){fail(e);}finally{polling=false;}
}
$('taskForm').addEventListener('submit',async e=>{
  e.preventDefault();const started=performance.now(),sent=Date.now(),id='run-'+crypto.randomUUID();submits.set(id,started);
  $('send').disabled=true;$('error').textContent='';
  try {const r=await api('tasks',{id,goal:$('goal').value,user_instruction:$('goal').value,user_sent_ms:sent,user_sent_evidence:'browser_submit_handler',reasoning_effort:$('effort').value,title:$('goal').value.slice(0,50),...($('continue').checked&&current?{continue_run_id:current}:{})});current=r.id;$('follow').checked=true;await poll();}catch(e){fail(e);}finally{$('send').disabled=false;}
});
$('onboard').addEventListener('click',async()=>{try{$('onboard').disabled=true;const r=await api('onboard',{id:'onboard-'+crypto.randomUUID(),paths:$('sourcePaths').value.split('\n').map(x=>x.trim()).filter(Boolean),reasoning_effort:'max'});current=r.id;$('follow').checked=true;await poll();}catch(e){fail(e);}finally{$('onboard').disabled=false;}});
$('sourcesButton').addEventListener('click',async()=>{try{$('sources').textContent=JSON.stringify(await api('sources'),null,2);$('sources').hidden=!$('sources').hidden;}catch(e){fail(e);}});
$('cancel').addEventListener('click',async()=>{try{await api('cancel',{id:current});}catch(e){fail(e);}});
$('eventsButton').addEventListener('click',async()=>{try{$('events').textContent=JSON.stringify(await api('events?id='+encodeURIComponent(current)),null,2);}catch(e){fail(e);}});
api('initialize',{}).catch(fail);refreshHealth();poll();setInterval(poll,500);setInterval(time,100);setInterval(refreshHealth,30000);
