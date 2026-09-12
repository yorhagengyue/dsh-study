import{readFileSync}from'node:fs';import{Client}from'./connection-client.mjs';import{writeRecord}from'../connection-plugin/files.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),c=new Client(config),h=await c.call('health');
const unauthorized=await fetch(c.base+'/study/api/health');
const badOrigin=await fetch(c.base+'/study/api/health',{headers:{Cookie:c.cookie,Origin:'https://untrusted.invalid'}});
const traversal=await fetch(c.base+'/study/api/runs/%2e%2e',{headers:{Cookie:c.cookie}});
if(!h.cordis_plugin||h.storage!=='ready'||unauthorized.status!==401||badOrigin.status!==403||traversal.status===200)throw new Error('NATIVE_HEALTH_OR_AUTH_FAILED');
const page=await fetch(c.base+'/study',{headers:{Cookie:c.cookie}});if(page.status!==410||!page.headers.get('content-type')?.includes('text/markdown'))throw new Error('CUSTOM_UI_STILL_ENABLED');
const r={custom_page_status:page.status,at:Date.now(),plugin:h.version,storage:h.storage,model_generation:h.model_generation,context:h.context,initialization_error:h.initialization_error,unauthenticated_status:unauthorized.status,cross_origin_status:badOrigin.status,path_escape_status:traversal.status};
if(process.argv[3])writeRecord(process.argv[3],'连接健康验收',r);console.log(JSON.stringify(r,null,2));
