// dsh-study-framework：学习系统框架的注入层（Cordis 插件入口）。
// 做四件事：算状态并回写 MANIFEST.md；按模板渲染开场；把开场写到 DSH 原生 agent-instructions 会读的位置；给 Codex 留 HTTP 接口和原生工具。
import z from '@deepseek-ai/schemastery';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {existsSync, watch} from 'node:fs';
import {spawn} from 'node:child_process';
import {join, dirname} from 'node:path';
import {FrameworkEngine, PLUGIN_NAME} from './engine.mjs';
import {DEFAULT_REQUIRED_SLOTS} from './state.mjs';
import {openCommand, isLoopbackUrl, redactToken, tokenFromEnv} from './open.mjs';

export const name = PLUGIN_NAME;
export const inject = ['webServer', 'connection', 'tools'];

export const Config = z.object({
  workspace: z.string().default(''),
  dshHome: z.string().default(''),
  userName: z.string().default(''),
  machine: z.string().default(''),
  role: z.string().default('DSH（执行 Agent）'),
  targets: z.array(String).default(['dshHome']),
  templatePath: z.string().default(''),
  maxBytes: z.number().default(60000),
  watch: z.boolean().default(true),
  watchDebounceMs: z.number().default(1500),
  requiredSlots: z.array(z.object({file: z.string(), slot: z.string()})).default(DEFAULT_REQUIRED_SLOTS),
  openBrowser: z.boolean().default(true),
  uiPath: z.string().default('/'),
  envPath: z.string().default(''),
});

export function apply(ctx, config) {
  const engine = new FrameworkEngine(config);
  const safeDeliver = () => { try { engine.deliver(); } catch (e) { engine.lastError = String(e?.message ?? e); } };

  ctx.effect(() => {
    const t = setTimeout(safeDeliver, 0);
    return () => clearTimeout(t);
  });

  if (config.watch) {
    ctx.effect(() => {
      let timer = null;
      const schedule = (path) => {
        if (path && engine.isOwnRecent(path)) return;
        clearTimeout(timer);
        timer = setTimeout(safeDeliver, config.watchDebounceMs);
      };
      const dirs = [engine.workspace, join(engine.workspace, 'USER'), join(engine.workspace, 'connection', 'runs'), dirname(engine.templatePath)];
      const watchers = [];
      for (const d of dirs) {
        if (!existsSync(d)) continue;
        try {
          const w = watch(d, {persistent: false}, (_ev, file) => schedule(file ? join(d, String(file)) : null));
          w.on('error', () => {});
          watchers.push(w);
        } catch {}
      }
      return () => { clearTimeout(timer); for (const w of watchers) w.close(); };
    });
  }

  // 预留：把开场注册为系统提示段（需要注入 systemPrompt 服务）。这版先只走 agent-instructions 文件通道。

  const reply = (res, status, value) => {
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
    res.end(JSON.stringify(value));
  };
  const readJson = (req) => new Promise((resolveBody, rejectBody) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; if (data.length > 65536) { rejectBody(new Error('BODY_TOO_LARGE')); req.destroy(); } });
    req.on('end', () => { try { resolveBody(data.trim() ? JSON.parse(data) : {}); } catch { rejectBody(new Error('BAD_JSON')); } });
    req.on('error', rejectBody);
  });
  async function handler(req, res) {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection) { res.writeHead(rejection, {'content-type': 'text/plain; charset=utf-8'}); res.end('DSH authentication required.'); return; }
    const url = new URL(req.url, 'http://localhost');
    const action = url.pathname.replace(/^\/framework\/api\/?/, '');
    try {
      if (req.method === 'GET' && action === 'health') return reply(res, 200, engine.health());
      if (req.method === 'GET' && action === 'state') return reply(res, 200, engine.state().state);
      if (req.method === 'GET' && action === 'opening') {
        const r = engine.render({role: url.searchParams.get('role') || undefined});
        if (url.searchParams.get('format') === 'json') return reply(res, 200, {bytes: r.bytes, omitted: r.omitted, stage: r.state.stage, text: r.text});
        res.writeHead(200, {'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store'});
        return res.end(r.text);
      }
      if (req.method === 'POST' && action === 'open') {
        // 入口 Agent 让 DSH 进程在用户默认浏览器里打开自己的界面。只放行回环地址；令牌不回显。
        if (!config.openBrowser) return reply(res, 403, {error: 'OPEN_DISABLED'});
        const body = await readJson(req);
        let path = typeof body.path === 'string' && body.path.startsWith('/') && !body.path.startsWith('//') ? body.path : null;
        if (!path) {
          const token = tokenFromEnv(config.envPath || join(engine.dshHome, '..', '.env'));
          path = token ? `/?token=${encodeURIComponent(token)}` : config.uiPath;
        }
        const url = `http://${req.headers.host || '127.0.0.1:3090'}${path}`;
        if (!isLoopbackUrl(url)) return reply(res, 400, {error: 'URL_NOT_LOOPBACK'});
        const [cmd, cmdArgs] = openCommand(process.platform, url);
        const child = spawn(cmd, cmdArgs, {detached: true, stdio: 'ignore', windowsHide: true});
        child.on('error', (e) => { engine.lastError = 'open: ' + String(e?.message ?? e); });
        child.unref();
        engine.lastOpen = {url: redactToken(url), at: new Date().toISOString()};
        return reply(res, 200, {opened: true, url: engine.lastOpen.url, stage: engine.state().state.stage});
      }
      if (req.method === 'POST' && action === 'render') return reply(res, 200, engine.deliver());
      return reply(res, 404, {error: 'NOT_FOUND'});
    } catch (e) { return reply(res, 400, {error: String(e?.message ?? e)}); }
  }
  ctx.effect(() => ctx.webServer.register({kind: 'prefix', path: '/framework', handler}));

  const specs = [
    ['study_framework_state', '读取学习框架的状态：处在哪一档（first_run / filling / complete）、空着哪些必填槽、抽屉几条、过期与冲突几条。不改任何文件。', {}, () => engine.state().state],
    ['study_framework_opening', '取得按当前框架文件渲染的开场全文（Markdown）。派工或换会话时用它做开场；不要向用户复述。', {role: {type: 'string'}}, args => { const r = engine.render({role: args?.role}); return {stage: r.state.stage, bytes: r.bytes, omitted: r.omitted, text: r.text}; }],
    ['study_framework_render', '重新算状态、渲染开场并写回 MANIFEST.md 与 AGENTS.md。框架文件改动后调用一次。', {}, () => engine.deliver()],
  ];
  for (const [toolName, description, parameters, execute] of specs) {
    ctx.tools.register(defineTool({
      name: toolName, description, parameters,
      output: {schema: {type: 'json'}, render: (_a, v) => [{type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v)}]},
      isConcurrencySafe: () => true,
      execute,
    }));
  }
}
