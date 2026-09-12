import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const at = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const root = resolve(at('--root') ?? fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, 'runtime');
await mkdir(runtime, {recursive: true});
if (argv.includes('--prepare')) {
  // --sources accepts a JSON array of fixed selectors, never executable instructions.
  const sources = JSON.parse(at('--sources') ?? '[{"source_id":"personal-example"},{"source_id":"sydney-example"}]');
  if (!Array.isArray(sources) || !sources.length || sources.some(source => typeof source.source_id !== 'string')) throw new Error('Expected --sources JSON array with source_id');
  const request = {id: randomUUID(), created_at: new Date().toISOString(), sources,
    exercise_local_import: argv.includes('--exercise-local-import')};
  await writeFile(join(runtime, 'verify-request.json'), JSON.stringify(request, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({prepared: true, id: request.id, next: 'Restart the authorized DSH host with the installed plugin, then run --wait.'}));
} else if (argv.includes('--wait')) {
  const request = await readFile(join(runtime, 'verify-request.json'), 'utf8').catch(() => readFile(join(runtime, 'verify-request.consumed.json'), 'utf8'));
  const expected = JSON.parse(request).id;
  const until = Date.now() + Math.min(Number(at('--timeout-ms') ?? 50_000), 50_000);
  let found = false;
  while (Date.now() < until) {
    const result = await readFile(join(runtime, 'verify-result.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (result?.id === expected) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      found = true;
      break;
    }
    await delay(250);
  }
  if (!found) { console.error('No matching DSH probe result yet; inspect DSH startup and rerun --wait.'); process.exitCode = 2; }
} else {
  console.log('Usage: node scripts/verify-dsh.mjs --prepare [--sources JSON] [--exercise-local-import] | --wait [--timeout-ms 50000]');
}
