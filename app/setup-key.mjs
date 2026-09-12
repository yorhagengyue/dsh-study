import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {envValues} from './connection-client.mjs';
import {write} from '../connection-plugin/files.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(!envValues(config.dsh_root).DEEPSEEK_API_KEY){
  if(!process.stdin.isTTY)throw new Error('MODEL_KEY_REQUIRED_IN_PROJECT_ENV');
  process.stdout.write('Official DeepSeek API key (hidden; stored in project .env): ');
  process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  const value=await new Promise((resolve,reject)=>{let text='';process.stdin.on('data',chunk=>{for(const c of chunk){if(c==='\u0003'){process.stdin.setRawMode(false);reject(new Error('CANCELLED'));return;}if(c==='\r'||c==='\n'){process.stdin.setRawMode(false);process.stdin.pause();resolve(text);return;}if(c==='\u007f')text=text.slice(0,-1);else text+=c;}});});
  process.stdout.write('\n');if(!value.trim())throw new Error('EMPTY_KEY');
  const path=join(config.dsh_root,'.env'),old=readFileSync(path,'utf8');write(path,old.replace(/^DEEPSEEK_API_KEY=.*$/m,'DEEPSEEK_API_KEY='+value.trim()));
}
