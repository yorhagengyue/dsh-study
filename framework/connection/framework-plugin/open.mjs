// 打开用户默认浏览器：由 DSH 进程执行，入口 Agent 通过 POST /framework/api/open 触发。
// 只允许本机回环地址（DSH 自己的界面），纯函数便于测试。
import {existsSync, readFileSync} from 'node:fs';

export function openCommand(platform, url) {
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/** 只放行 http(s)://127.0.0.1|localhost|[::1](:port)/path?query，字符集收紧到 URL 安全字符。 */
export function isLoopbackUrl(url) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/[A-Za-z0-9\-._~%?=&/]*$/.test(url);
}

export function redactToken(url) {
  return String(url).replace(/([?&]token=)[^&#]+/g, '$1<redacted>');
}

/** 从 .env 读启动令牌（launch.mjs 把 DSH 打印的登录令牌写在这里）。读不到返回 null。 */
export function tokenFromEnv(envPath) {
  if (!envPath || !existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?(STUDY_LAUNCH_TOKEN|DSH_DIALOGUE_LAUNCH_TOKEN)\s*=\s*(.*?)\s*$/);
    if (m) return m[2].replace(/^(['"])(.*)\1$/, '$2') || null;
  }
  return null;
}
