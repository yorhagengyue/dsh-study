import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export const now = () => new Date().toISOString();
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Guard state before loading it: a second broker must not interrupt the first one's records. */
export function acquireStoreLease(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'broker-owner.json');
  const owner = JSON.stringify({ pid: process.pid, lease: randomUUID(), createdAt: now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(filename, owner, { flag: 'wx', mode: 0o600 });
      return () => {
        try { if (fs.readFileSync(filename, 'utf8') === owner) fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = fs.readFileSync(filename, 'utf8'); } catch { throw new Error('Bridge state ownership could not be verified'); }
      let pid;
      try { pid = JSON.parse(previous).pid; } catch { throw new Error('Bridge state lease is incomplete; another startup may be in progress'); }
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid bridge state owner');
      let alive = true;
      try { process.kill(pid, 0); } catch (check) { if (check.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Bridge state is already owned by a running process');
      // Only reclaim a lease whose owner is dead and whose contents did not change.
      if (fs.readFileSync(filename, 'utf8') !== previous) throw new Error('Bridge state owner changed during recovery');
      fs.unlinkSync(filename);
    }
  }
  throw new Error('Could not acquire bridge state ownership');
}

/** One broker owns this file. Requests are persisted before execution starts. */
export class TaskStore {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filename = path.join(directory, 'tasks.json');
    this.state = fs.existsSync(this.filename)
      ? JSON.parse(fs.readFileSync(this.filename, 'utf8'))
      : { version: 1, tasks: {}, requests: {} };
    if (this.state.version !== 1) throw new Error('Unsupported bridge state version');
    for (const task of Object.values(this.state.tasks)) {
      task.session_closed = true;
      task.active_run_id = null;
      for (const run of task.runs) {
        if (!terminalStatuses.has(run.status)) {
          run.status = 'interrupted';
          run.error = { code: 'broker_restarted', message: 'Broker restarted; execution was not replayed.' };
          run.facts.finishedAt = now();
        }
      }
    }
    this.save();
  }
  save() {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filename);
  }
  get(id) { return this.state.tasks[id]; }
  list() { return Object.values(this.state.tasks); }
  request(id) { return this.state.requests[id]; }
  recordRequest(id, value) { this.state.requests[id] = value; }
}
