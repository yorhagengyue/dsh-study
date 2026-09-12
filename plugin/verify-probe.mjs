import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** One-use diagnostic: read-only by default; explicit option exercises configured local inputs. */
export async function runPendingProbe(ctx, projectRoot, signal) {
  const runtime = join(projectRoot, 'runtime');
  const pending = join(runtime, 'verify-request.json');
  let request;
  try {
    request = JSON.parse(await readFile(pending, 'utf8'));
    if (typeof request.id !== 'string' || !Array.isArray(request.sources)) return;
    if (Date.now() - Date.parse(request.created_at) > 15 * 60_000) return;
    await rename(pending, join(runtime, 'verify-request.consumed.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const report = {id: request.id, started_at: new Date().toISOString(), process_id: process.pid,
    execution: 'live-dsh-ctx.tools.execute', model_call: false, provider_ids: [], tool_names: [], events: [], sources: [],
    exercise_local_import: request.exercise_local_import === true, local_exercises: [], ok: false};
  const prefix = `dsh-study-verify-${request.id}-`;
  const dispose = ctx.on('tools/result', (exec, result) => {
    if (String(exec.callId).startsWith(prefix)) report.events.push({name: exec.name, is_error: result.isError});
  });
  try {
    for (let i = 0; ctx.study.providerIds().length === 0 && i < 100; i++) await delay(100, undefined, {signal});
    report.provider_ids = ctx.study.providerIds();
    report.tool_names = ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('study_'));
    let serial = 0;
    const execute = async (name, args) => {
      const result = await ctx.tools.execute({callId: `${prefix}${++serial}`, name, arguments: args, signal});
      if (result.isError) throw Object.assign(new Error('Native tool invocation failed'), {code: result.error?.info?.code ?? 'TOOL_FAILED'});
      return result.value;
    };
    const sources = await execute('study_sources', {});
    const sourceList = Array.isArray(sources) ? sources : sources.sources ?? [];
    const exercised = new Set();
    const exerciseLocal = async source_id => {
      for (const operation of ['study_import_local', 'study_refresh']) {
        const job = await execute(operation, {source_id});
        if (typeof job.job_id !== 'string') throw Object.assign(new Error('Local input did not return a job'), {code: 'VERIFY_LOCAL_JOB_MISSING'});
        const until = Date.now() + 30_000;
        let status;
        do {
          signal.throwIfAborted();
          status = await execute('study_status', {source_id, job_id: job.job_id});
          if (status.status !== 'running') break;
          await delay(200, undefined, {signal});
        } while (Date.now() < until);
        report.local_exercises.push({source_id, operation, status: status.status});
        if (status.status !== 'completed') throw Object.assign(new Error('Local input job did not complete'), {code: 'VERIFY_LOCAL_JOB_INCOMPLETE'});
      }
    };
    for (const requested of request.sources) {
      const source_id = requested.source_id;
      const source = sourceList.find(source => (source.id ?? source.source_id) === source_id);
      if (!source) throw Object.assign(new Error('Requested source absent'), {code: 'VERIFY_SOURCE_MISSING'});
      // Type comes from the configured backend source, never from the request file.
      // Canvas cannot enter this branch, even when the option is explicitly enabled.
      if (request.exercise_local_import === true && source.type === 'local' && !exercised.has(source_id)) {
        await exerciseLocal(source_id);
        exercised.add(source_id);
      }
      const courses = await execute('study_courses', {source_id});
      const courseList = Array.isArray(courses) ? courses : courses.courses ?? [];
      const course = requested.course_id ? courseList.find(course => String(course.course_id) === String(requested.course_id)) : courseList[0];
      if (!course) throw Object.assign(new Error('No cached course; synchronize source first'), {code: 'VERIFY_COURSE_MISSING'});
      const course_id = String(course.course_id);
      const catalog = await execute('study_catalog', {source_id, course_id, limit: 500});
      const resources = catalog.resources ?? [];
      const isReady = resource => ['ready', 'available'].includes(resource.status ?? resource.availability) || resource.available === true;
      const resource = requested.resource_id ? resources.find(item => item.resource_id === requested.resource_id) : resources.find(isReady);
      if (!resource) throw Object.assign(new Error('No ready indexed material; synchronize source first'), {code: 'VERIFY_RESOURCE_MISSING'});
      const read = await execute('study_read', {source_id, course_id, resource_id: resource.resource_id, max_bytes: 65536});
      const bytes = typeof read.base64 === 'string' ? Buffer.from(read.base64, 'base64') : Buffer.from(read.text ?? read.safe_html ?? '', 'utf8');
      if (!bytes.length) throw Object.assign(new Error('Read returned no material bytes'), {code: 'VERIFY_EMPTY_READ'});
      const sentinel_match = requested.sentinel === undefined ? null : String(read.text ?? '').includes(requested.sentinel);
      if (sentinel_match === false) throw Object.assign(new Error('Synthetic example content did not match'), {code: 'VERIFY_CONTENT_MISMATCH'});
      report.sources.push({source_id, course_id, resource_id: resource.resource_id, resource_count: resources.length,
        availability: resource.status ?? resource.availability ?? null, read_bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), sentinel_match,
        representation: read.representation ?? null, extraction_status: read.extraction_status ?? null,
        text_available: read.text_available ?? (typeof read.text === 'string'), truncated: read.truncated ?? false});
    }
    report.ok = report.sources.length === request.sources.length && report.sources.length > 0 && report.tool_names.length === 7;
  } catch (error) {
    // Do not persist arbitrary backend error text: it can contain private course titles or URLs.
    report.error = {code: String(error.code ?? error.name ?? 'VERIFY_FAILED')};
  } finally {
    dispose();
    report.finished_at = new Date().toISOString();
    await mkdir(runtime, {recursive: true});
    const temp = join(runtime, 'verify-result.json.tmp');
    await writeFile(temp, JSON.stringify(report, null, 2) + '\n', 'utf8');
    await rename(temp, join(runtime, 'verify-result.json'));
  }
}
