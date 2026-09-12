import z from '@deepseek-ai/schemastery';
export const inject = ['tools'];
export const Config = z.object({allowedStudySources: z.array(z.string()).default(['personal-example'])});

/** Scope gates sit in the official registry, before the unchanged study tool body. */
export function apply(ctx, config) {
  const allowed = new Set(config.allowedStudySources);
  const permittedJobs = new Set();
  const studyTools = new Set(['study_courses', 'study_catalog', 'study_read', 'study_refresh', 'study_import_local', 'study_status']);
  ctx.on('tools/pre-execute', async (exec, next) => {
    exec.signal.throwIfAborted();
    if (['read', 'write', 'edit', 'study_sources'].includes(exec.name)) return next();
    if (!studyTools.has(exec.name)) return {kind: 'deny', reason: 'This tool is outside the delegated task capability set'};
    const args = exec.arguments ?? {};
    if (exec.name === 'study_status' && args.job_id) {
      if (permittedJobs.has(args.job_id)) return next();
      return {kind: 'deny', reason: 'This synchronization job does not belong to this task runtime'};
    }
    if (!allowed.has(args.source_id)) return {kind: 'deny', reason: 'This source is outside the delegated task source allowlist'};
    return next();
  });
  ctx.on('tools/result', (exec, result) => {
    if (['study_refresh', 'study_import_local'].includes(exec.name) && allowed.has(exec.arguments?.source_id) && result.value?.job_id) permittedJobs.add(result.value.job_id);
  });
}
