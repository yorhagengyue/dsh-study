// Standard SDK client for reproducible stdio initialize/listTools/callTool checks.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const [outputRoot,requestFile]=process.argv.slice(2);
if(!outputRoot||!requestFile)throw Error('OUTPUT_ROOT_AND_REQUEST_REQUIRED');
const folder=resolve(outputRoot);await mkdir(folder,{recursive:true});
const request=JSON.parse(await readFile(resolve(requestFile),'utf8'));
const client=new Client({name:'dsh-study-validation-client',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url)),'--output-root',folder],env:process.platform==='win32'?{PROGRAMDATA:process.env.PROGRAMDATA}:{},stderr:'pipe'});
const record={started_at:new Date().toISOString(),request};
transport.setProtocolVersion=version=>{record.negotiated_protocol_version=version;};
try {
 await client.connect(transport);
 record.server=client.getServerVersion();record.capabilities=client.getServerCapabilities();
 record.tools=(await client.listTools()).tools;
 record.result=await client.callTool(request,undefined,{timeout:120000});
 record.finished_at=new Date().toISOString();
 const evidence=join(folder,`mcp-client-${randomUUID()}.json`);await writeFile(evidence,JSON.stringify(record,null,2),{flag:'wx'});
 console.log(JSON.stringify({client_evidence:evidence,isError:record.result.isError??false,result:record.result.structuredContent??record.result.content}));
}finally{await client.close();}
