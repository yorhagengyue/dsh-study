// FrameworkEngine：算状态、渲染开场、写目标文件。不依赖 Cordis，便于单独测试和被 CLI 复用。
import {existsSync, mkdirSync, copyFileSync, readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {homedir, hostname, platform, release} from 'node:os';
import {fileURLToPath} from 'node:url';
import {computeState, writeManifest, atomicWrite, readText, DEFAULT_REQUIRED_SLOTS} from './state.mjs';
import {renderOpening} from './render.mjs';

export const PLUGIN_NAME = 'dsh-study-framework';
const here = dirname(fileURLToPath(import.meta.url));
export const defaultWorkspace = () => join(homedir(), 'Desktop', 'DSH-Study');
export const defaultDshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');

export class FrameworkEngine {
  constructor(config = {}) {
    this.config = {
      userName: '', machine: '', role: 'DSH（执行 Agent）', targets: ['dshHome'], templatePath: '', maxBytes: 60000,
      watch: true, watchDebounceMs: 1500, requiredSlots: DEFAULT_REQUIRED_SLOTS, ...config,
    };
    if (!this.config.requiredSlots?.length) this.config.requiredSlots = DEFAULT_REQUIRED_SLOTS;
    this.workspace = this.config.workspace || defaultWorkspace();
    this.dshHome = this.config.dshHome || defaultDshHome();
    this.templatePath = this.config.templatePath || join(this.workspace, 'connection', 'templates', 'opening.md');
    this.lastRendered = '';
    this.lastState = null;
    this.lastDelivery = null;
    this.lastError = null;
    this.lastOpen = null;
    this.ownWrites = new Map();
  }

  ensureTemplate() {
    if (!existsSync(this.templatePath)) {
      mkdirSync(dirname(this.templatePath), {recursive: true});
      copyFileSync(join(here, 'templates', 'opening.md'), this.templatePath);
    }
    return readText(this.templatePath);
  }

  frameworkVersion() {
    const m = readText(join(this.workspace, 'README.md')).match(/framework_version[`\s]*([0-9][\w.-]*)/);
    return m ? m[1] : '';
  }

  variables(role) {
    return {
      userName: this.config.userName || '（还不知道，第一次见面时问）',
      machine: this.config.machine || `${platform()} ${release()}（${hostname()}），DSH_HOME ${this.dshHome}`,
      workspace: this.workspace,
      role: role || this.config.role,
    };
  }

  state() {
    return computeState({workspace: this.workspace, requiredSlots: this.config.requiredSlots});
  }

  render({role, now} = {}) {
    const template = this.ensureTemplate();
    const {state} = this.state();
    const rendered = renderOpening({workspace: this.workspace, variables: this.variables(role), template, state, maxBytes: this.config.maxBytes, frameworkVersion: this.frameworkVersion(), now: now ?? new Date()});
    return {...rendered, state};
  }

  /** 去掉时间戳后比较，避免只因渲染时间不同就重写文件。 */
  static stable(text) {
    return String(text ?? '').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>');
  }

  targetPaths() {
    const out = [];
    for (const t of this.config.targets ?? []) {
      if (t === 'dshHome') out.push(join(this.dshHome, 'AGENTS.md'));
      else if (t === 'workspace') out.push(join(this.workspace, 'AGENTS.md'));
    }
    return out;
  }

  markOwn(path) { this.ownWrites.set(path, Date.now()); }
  isOwnRecent(path, windowMs = 3000) { const t = this.ownWrites.get(path); return !!t && Date.now() - t < windowMs; }

  deliver() {
    const {state, manifest, manifestPath} = this.state();
    const written = writeManifest({workspace: this.workspace, state, manifest, manifestPath, machineId: hostname(), workspaceLabel: this.workspace});
    if (written.written) this.markOwn(manifestPath);
    const rendered = this.render();
    const same = (path) => FrameworkEngine.stable(readText(path)) === FrameworkEngine.stable(rendered.text);
    const targets = [];
    for (const path of this.targetPaths()) {
      if (!same(path)) { this.markOwn(path); atomicWrite(path, rendered.text); targets.push({path, written: true}); }
      else targets.push({path, written: false});
    }
    const copy = join(this.workspace, 'connection', 'OPENING.md');
    if (!same(copy)) { this.markOwn(copy); atomicWrite(copy, rendered.text); }
    this.lastRendered = rendered.text;
    this.lastState = rendered.state;
    this.lastDelivery = {at: new Date().toISOString(), stage: rendered.state.stage, bytes: rendered.bytes, omitted: rendered.omitted, targets, copy, manifest_written: written.written};
    this.lastError = null;
    return this.lastDelivery;
  }

  health() {
    let version = '';
    try { version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version; } catch {}
    return {
      plugin: PLUGIN_NAME,
      version,
      workspace: this.workspace,
      dsh_home: this.dshHome,
      template: this.templatePath,
      targets: this.targetPaths(),
      last_delivery: this.lastDelivery,
      last_error: this.lastError,
      last_open: this.lastOpen,
      stage: this.lastState?.stage ?? null,
    };
  }
}
