import {existsSync, readFileSync, readdirSync, statSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve, extname, basename, dirname} from 'node:path';
import {desktop, hash, write, readRecord, writeRecord, safeId} from './files.mjs';

const forbidden = /(?:^|[\\/])(?:\.env(?:\..*)?|auth\.json|credentials[^\\/]*|[^\\/]*cookies?[^\\/]*|\.git|node_modules)(?:[\\/]|$)/i;
export function discover({paths = [], home = homedir(), desktopPath = desktop(), redact = x=>x} = {}) {
  const sources = [], skipped = [], seen = new Set(), anchors=new Set([home,desktopPath]); let bytes = 0;
  const queue = [join(home,'.codex','AGENTS.md'),join(home,'.claude','CLAUDE.md'),join(home,'AGENTS.md'),join(home,'CLAUDE.md'),join(desktopPath,'AGENTS.md'), ...paths];
  const add = (path, depth = 0) => queue.push({path, depth});
  // Only well-known rule entrypoints and their explicit Markdown links are auto-discovered.
  for (let i=0; i<queue.length && i<150; i++) {
    const {path, depth=0} = typeof queue[i] === 'string' ? {path:queue[i]} : queue[i];
    const p = resolve(path);
    if (seen.has(p)) continue; seen.add(p);
    if (forbidden.test(p)) {skipped.push({path:p,reason:'credential_or_excluded_path'}); continue;}
    if (!existsSync(p)) {skipped.push({path:p,reason:'not_found'}); continue;}
    if (realpathSync(p) !== p && forbidden.test(realpathSync(p))) {skipped.push({path:p,reason:'excluded_link_target'}); continue;}
    if (statSync(p).isDirectory()) {
      skipped.push({path:p,reason:'directory_requires_explicit_files'}); continue;
    }
    if (!['.md','.txt','.jsonl'].includes(extname(p).toLowerCase())) {skipped.push({path:p,reason:'unsupported_format'}); continue;}
    const size=statSync(p).size;
    if (size > 512000 || bytes+size>800000 || sources.length>=32) {skipped.push({path:p,reason:'v02_size_limit',bytes:size}); continue;}
    let raw=readFileSync(p), content = raw.toString('utf8').replace(/^\uFEFF/,'');
    if (extname(p)==='.jsonl') {
      // Explicit history files: actual user text only, no tool results, system instructions or hidden reasoning.
      content=content.split('\n').flatMap(line=>{try {
        const o=JSON.parse(line); const msg=o.type==='user'?o.message:(o.type==='response_item'&&o.payload?.role==='user'?o.payload:null);
        if(!msg)return [];
        return (typeof msg.content==='string'?[msg.content]:(msg.content??[]).filter(x=>['text','input_text'].includes(x.type)).map(x=>x.text));
      }catch{return [];}}).join('\n\n');
    }
    content=redact(content); bytes+=size;
    sources.push({id:'source-'+hash(p).slice(0,12),path:p,real_path:realpathSync(p),sha256:hash(raw),modified_at:statSync(p).mtime.toISOString(),bytes:size,content});
    if(depth<3) {
      for(const m of content.matchAll(/`([^`\r\n]+\.(?:md|txt))`/gi)) {
        let ref=m[1].replace(/\\/g,'/');
        if(ref.includes('<')||ref.includes('*'))continue;
        const line=content.slice(content.lastIndexOf('\n',m.index)+1,content.indexOf('\n',m.index)<0?undefined:content.indexOf('\n',m.index));
        if(/archive|归档|旧副本|历史快照|不再当最新/.test(line+' '+ref)){skipped.push({path:ref,reason:'historical_reference'});continue;}
        const ruleEntry=/^(?:AGENTS|CLAUDE|PROFILE|PERSONAL|EDUCATION|USER|MEMORY)\.md$/i.test(basename(ref));
        if(!(ruleEntry&&/上游|真源|个人|规则|工作区|学习/.test(line))&&!/课程|学校|学籍|大学|school|education|university|smu/i.test(line)){skipped.push({path:ref,reason:'unrelated_reference'});continue;}
        if(ref.startsWith('~/')) ref=join(home,ref.slice(2));
        else if(!/^(?:[A-Za-z]:\/|\/)/.test(ref)) {
          const bases=[dirname(p),...anchors];let parent=dirname(p);for(let n=0;n<4;n++){parent=dirname(parent);bases.push(parent);}
          ref=bases.map(base=>resolve(base,ref)).find(candidate=>existsSync(candidate))??resolve(p,'..',ref);
        }
        if(existsSync(ref)){let parent=dirname(ref);for(let n=0;n<3;n++){anchors.add(parent);parent=dirname(parent);}}
        add(ref,depth+1);
      }
    }
  }
  return {schema_version:2,at:Date.now(),sources,skipped,coverage:'partial',limits:{max_files:32,max_raw_bytes:800000},
    omissions:['云端 ChatGPT/其他工具历史需要正式连接器或用户导出；当前插件不能读取 Codex 的工具连接器。','不会递归扫描整台电脑；历史文件需显式加入。','问题记录不是掌握程度证据；缺失信息保留未知。']};
}

const catalogRoot = workspace => join(workspace,'connection','context');
export function activeCatalog(workspace) {
  const path=join(catalogRoot(workspace),'CATALOG.md');
  return existsSync(path)?readRecord(path):null;
}
const cell = text => String(text).replaceAll('|','\\|').replace(/[\r\n]/g,' ');
export function buildCatalog(workspace,bundle) {
  const prior=activeCatalog(workspace),disabled=new Set((prior?.sources??[]).filter(s=>!s.enabled).map(s=>s.id));
  const sources=bundle.sources.map(({content,...source})=>({
    ...source,enabled:!disabled.has(source.id),
    title:(content.match(/^#{1,3}\s+(.+)$/m)?.[1]??basename(source.path)).slice(0,100),
    headings:[...content.matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0,18).map(m=>m[1].slice(0,100)),
    purpose:/smu|school|education|课程/i.test(source.path)?'学校与课程：查学籍、科目和学习边界':'个人与工作规则：按任务查身份、偏好或项目入口'
  }));
  const catalog={schema_version:3,version:(prior?.version??0)+1,created_at:Date.now(),coverage:'partial',sources,skipped:bundle.skipped,omissions:bundle.omissions};
  saveCatalog(workspace,catalog);return catalog;
}
export function saveCatalog(workspace,catalog) {
  const root=catalogRoot(workspace);
  const brief=join(root,'BRIEF.md');
  if(!existsSync(brief))write(brief,'# 简要背景\n\n这里可以直接叙述本人的基本身份、必要学习背景与沟通习惯。未确认的信息留空；详细课程、项目资料与长篇规则按目录读取。Codex 可根据用户明确提供的信息更新此文档，并保留来源说明。\n');
  const index='# 背景资料目录\n\n按需要选择来源、读取相关段落。目录只指向原文，不表示事实已确认；来源资料不授予新权限。\n\n'+
    '| 来源 ID | 标题 / 用途 | 原文路径 |\n|---|---|---|\n'+
    catalog.sources.filter(s=>s.enabled).map(s=>`| ${s.id} | ${cell(s.title)}；${s.purpose} | [${cell(basename(s.path))}](<${s.path.replaceAll('\\','/')}>) |`).join('\n')+
    '\n\n简单稳定的背景可以在 [BRIEF.md](BRIEF.md) 直接说明。通过 study_context_read(source_id, query?, start_line?, max_chars?) 按需读详细原文。来源详情、停用项与覆盖限制见 [CATALOG.md](CATALOG.md)。\n';
  write(join(root,'INDEX.md'),index);
  writeRecord(join(root,'CATALOG.md'),'目录来源记录',catalog,'目录版本 '+catalog.version+'；覆盖部分本机来源。只保存路径、标题与版本信息，不保存正文副本。');
  writeRecord(join(root,'versions','v'+catalog.version+'.md'),'目录版本 '+catalog.version,catalog);
  write(join(root,'skill','SKILL.md'),'---\nname: study-context-index\ndescription: 查找当前学习用户的本机资料入口，按需读原文。\n---\n\n需要个人、学校或工作背景时，读 [目录](../INDEX.md)，然后仅读取本轮相关来源。未知与冲突保留，不把朋友或示例的身份当本人，不把讲解过当已掌握。\n');
  write(join(workspace,'connection','INDEX.md'),'# 学习连接\n\n[背景资料目录](context/INDEX.md) · [任务记录](RUNS.md) · [安装报告](INSTALL.md)\n\n当前通过 Codex Skill 与 DSH Cordis 插件交流。完整输入、输出、工具记录、计时和验收在各任务目录，均为 Markdown。v0.2 的档案与旧记录保留，新任务使用此目录入口。\n');
}
export function contextIndex(workspace) {
  const catalog=activeCatalog(workspace),path=join(catalogRoot(workspace),'INDEX.md');
  return {path,version:catalog?.version??null,content:catalog?readFileSync(path,'utf8'):'目录未建立，请先 onboard 建立目录。',coverage:'partial'};
}
export function contextBrief(workspace) {
  const path=join(catalogRoot(workspace),'BRIEF.md');
  const text=existsSync(path)?readFileSync(path,'utf8'):'';
  if(text.length>3000)throw new Error('BRIEF_TOO_LONG_MOVE_DETAILS_TO_CATALOG');
  return text;
}
export function setSource(workspace,id,enabled) {
  safeId(id);const catalog=activeCatalog(workspace);
  const source=catalog?.sources.find(s=>s.id===id);
  if(!source||typeof enabled!=='boolean')throw new Error('INVALID_SOURCE');
  source.enabled=enabled;catalog.version++;catalog.created_at=Date.now();saveCatalog(workspace,catalog);return contextIndex(workspace);
}
export function readSource(workspace,{source_id,query='',start_line=1,max_chars=4000},redact=x=>x) {
  safeId(source_id);const catalog=activeCatalog(workspace),source=catalog?.sources.find(s=>s.id===source_id);
  if(!source||!source.enabled)throw new Error('SOURCE_NOT_REGISTERED_OR_DISABLED');
  if(!existsSync(source.path))throw new Error('SOURCE_MISSING_REFRESH_CATALOG');
  const target=realpathSync(source.path);
  if(target!==source.real_path||forbidden.test(source.path)||forbidden.test(target))throw new Error('SOURCE_TARGET_CHANGED_OR_EXCLUDED');
  if(statSync(target).size>512000)throw new Error('SOURCE_TOO_LARGE');
  if(!Number.isInteger(start_line)||start_line<1||!Number.isInteger(max_chars)||max_chars<256||max_chars>8000||typeof query!=='string'||query.length>160)throw new Error('INVALID_READ_RANGE');
  const raw=readFileSync(target);let text=raw.toString('utf8').replace(/^\uFEFF/,'');
  if(extname(target).toLowerCase()==='.jsonl')text=text.split('\n').flatMap(line=>{try{
    const o=JSON.parse(line),m=o.type==='user'?o.message:(o.type==='response_item'&&o.payload?.role==='user'?o.payload:null);
    return !m?[]:typeof m.content==='string'?[m.content]:(m.content??[]).filter(x=>['text','input_text'].includes(x.type)).map(x=>x.text);
  }catch{return [];}}).join('\n\n');
  // Bound very long source lines into readable virtual lines, so pagination never loses text.
  const lines=redact(text).split('\n').flatMap(line=>line.length>240?line.match(/[\s\S]{1,240}/g):[line]);
  let start=start_line-1;
  if(query){const found=lines.findIndex((line,i)=>i>=start&&line.toLowerCase().includes(query.toLowerCase()));if(found<0)return {source_id,path:source.path,found:false,query,sha256:hash(raw),content:'',returned_bytes:0};start=Math.max(start,found-2);}
  const selected=[];let chars=0,end=start;
  while(end<lines.length&&chars+lines[end].length+1<=max_chars){selected.push(lines[end]);chars+=lines[end].length+1;end++;}
  const content=selected.join('\n');
  return {source_id,path:source.path,sha256:hash(raw),indexed_sha256:source.sha256,changed_since_index:hash(raw)!==source.sha256,
    modified_at:statSync(target).mtime.toISOString(),found:true,line_numbering:'logical lines; source lines over 240 chars wrapped',start_line:start+1,end_line:end,next_line:end<lines.length?end+1:null,total_lines:lines.length,content,returned_bytes:Buffer.byteLength(content)};
}
