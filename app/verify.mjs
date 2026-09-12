import{readFileSync}from'node:fs';import{Client}from'./connection-client.mjs';import{write}from'../connection-plugin/files.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),c=new Client(config),h=await c.call('health');
const unauthorized=await fetch(c.base+'/study/api/health');
const badOrigin=await fetch(c.base+'/study/api/health',{headers:{Cookie:c.cookie,Origin:'https://untrusted.invalid'}});
const traversal=await fetch(c.base+'/study/api/runs/%2e%2e',{headers:{Cookie:c.cookie}});
if(!h.cordis_plugin||h.storage!=='ready'||unauthorized.status!==401||badOrigin.status!==403||traversal.status===200)throw new Error('NATIVE_HEALTH_OR_AUTH_FAILED');
const r={at:Date.now(),plugin:h.version,storage:h.storage,model_generation:h.model_generation,profile:h.profile,initialization_error:h.initialization_error,unauthenticated_status:unauthorized.status,cross_origin_status:badOrigin.status,path_escape_status:traversal.status};
if(process.argv[3])write(process.argv[3],r);console.log(JSON.stringify(r,null,2));
