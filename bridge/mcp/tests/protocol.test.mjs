import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../server.mjs';
import {DshAdapter} from '../adapter.mjs';

test('MCP initialize/listTools/callTool requires distinct real caller review and exposes only three tools',async()=>{
 const calls=[];
 const server=createServer({start:async x=>{calls.push('start');return {status:'pending_review',source:x.source_text,report:'actual report',handle:'test'};},review:async x=>{calls.push(x.decision);return {status:x.decision};},continue:async()=>({status:'pending_review'})});
 const client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 try {
  assert.equal(client.getServerVersion().name,'dsh-study');
  assert.deepEqual((await client.listTools()).tools.map(x=>x.name),['start','review','continue']);
  const result=await client.callTool({name:'start',arguments:{source_text:'source',goal:'goal'}});
  assert.equal(result.structuredContent.status,'pending_review');assert.deepEqual(calls,['start']);
  const bad=await client.callTool({name:'review',arguments:{handle:'test',decision:'accepted'}});
  assert.equal(bad.isError,true);assert.deepEqual(calls,['start']);
  const good=await client.callTool({name:'review',arguments:{handle:'test',decision:'changes_requested',reviewer:'independent caller',reasoning:'actual defect'}});
  assert.equal(good.structuredContent.status,'changes_requested');
 }finally{await client.close();await server.close();}
});
test('unsafe handles fail before filesystem access and errors do not leak exception secrets',async()=>{
 const adapter=new DshAdapter({outputRoot:'.'});
 await assert.rejects(adapter.state('../private'),/INVALID_HANDLE/);
 const server=createServer({start:async()=>{throw Error('secret value must not escape');}});
 const client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{const x=await client.callTool({name:'start',arguments:{source_text:'s',goal:'g'}});assert.equal(x.isError,true);assert.ok(!JSON.stringify(x).includes('secret value'));}finally{await client.close();await server.close();}
});
