import {readFileSync, writeFileSync, mkdirSync, renameSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function desktop() {
  const path = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')"], {encoding:'utf8', windowsHide:true}).trim()
    : join(homedir(), 'Desktop');
  if (!path || !existsSync(path)) throw new Error('DESKTOP_UNAVAILABLE');
  return path;
}
export function write(path, data) {
  mkdirSync(dirname(path), {recursive:true});
  const tmp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2), {encoding:'utf8', mode:0o600});
  renameSync(tmp, path);
}
export const read = path => JSON.parse(readFileSync(path, 'utf8'));
// Human-readable Markdown remains the durable record. The bounded metadata block
// lets the plugin recover exact IDs/timestamps without a second JSON sidecar.
export function writeRecord(path, title, value, body = '') {
  write(path, `# ${title}\n\n${body}${body ? '\n\n' : ''}<!-- dsh-state -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n<!-- /dsh-state -->\n`);
}
export function readRecord(path) {
  const text=readFileSync(path,'utf8');
  const start=text.lastIndexOf('<!-- dsh-state -->\n```json\n');
  const end=text.indexOf('\n```\n<!-- /dsh-state -->',start);
  if(start<0||end<0)throw new Error('INVALID_MARKDOWN_RECORD');
  return JSON.parse(text.slice(start+'<!-- dsh-state -->\n```json\n'.length,end));
}
export function safeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('INVALID_ID');
  return value;
}
export function redactor(root) {
  const envFile = join(resolve(root), '.env');
  const secrets = existsSync(envFile) ? readFileSync(envFile,'utf8').split(/\r?\n/).flatMap(line => {
    const m = line.match(/^\s*(?:export\s+)?([\w]+)\s*=\s*(.*?)\s*$/);
    if (!m || !/(key|token|secret|password)/i.test(m[1])) return [];
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    return v.length > 6 ? [v] : [];
  }) : [];
  return value => {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    text = text.replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi,'$1[REDACTED]')
      .replace(/([?&](?:token|api_key|access_token)=)[^\s&"<>]+/gi,'$1[REDACTED]')
      .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)["']?[A-Za-z0-9_.\/-]{12,}["']?/gi,'$1[REDACTED]');
    return typeof value === 'string' ? text : JSON.parse(text);
  };
}
export function publicEvent(event) {
  const allowed = ['assistant/message','tool/call','tool/result','turn/start','turn/end','step/start','step/end','model/selection','session/title'];
  if (!allowed.includes(event.type)) return null;
  function clean(v) {
    if (Array.isArray(v)) return v.filter(x => !['reasoning','thinking'].includes(x?.type)).map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !['stream','reasoning','thinking','reasoningContent'].includes(k)).map(([k,x]) => [k,clean(x)]));
    return v;
  }
  return clean(event);
}
