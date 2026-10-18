/**
 * 联网工具：`web_fetch` 与 `web_search`（两个都始终存在）。
 *
 * 零依赖、零厂商锁定。抓网页只做一件事——把 HTML 变成模型能读的文本。
 *
 * ## 搜索后端的阶梯（照 Hermes 的做法）
 *
 * 1. 这一行的 config 写了 `searchBaseURL` → 走 **SearXNG 形状**的
 *    `GET {baseURL}/search?q=…&format=json`：自托管、无 key、也能指向任意厂商；
 * 2. 没写但给了 `searchApiKey` → 走 **TinyFish**（`GET api.search.tinyfish.ai/?query=…`，
 *    认证头 `X-API-Key`）；
 * 3. 都没有、但环境里有 `TINYFISH_API_KEY` → 还是 TinyFish，只是 key 从环境里来；
 * 4. 都没有 → 走**免 key 兜底**：DuckDuckGo 的 lite 页面（纯 HTML，零依赖）。
 *
 * 阶梯本身照 Hermes 的 `_autodetect_backend` / `_keyless_backend`
 * （`tools/web_tools.py:118-171`）：**显式选择优先，环境变量次之，没配过的安装落到免 key
 * 那一档**，于是「装上就能搜」。第 3 档就是 Hermes 的第一档（读环境变量自动探测后端）——
 * 差别只在 Noa 把结果放在 `searchApiKey` 的下一级而不是并列，因为「配置里写了什么」是操作
 * 者的显式决定，不该被一个残留的环境变量顶掉。
 *
 * 原先这里写的是「没配端点就**不注册** web_search」，理由是「一个查不到的搜索工具比没有
 * 更糟」——那个理由在**没有兜底**时成立，有了兜底就不成立了：工具是真的能搜，模型也就不会
 * 把「端点没配」误读成「网上没有」。
 *
 * 每一档的**来源都写进返回文本**（`（TinyFish）`/`（DuckDuckGo）`）：同一个问题走哪条路
 * 拿到答案，会改变答案的可信度，而模型看不到这层实现，只能靠这行字。
 *
 * ## 凭据：配置优先、环境兜底，且不兑现的引用要拒
 *
 * `{env:NAME}` 由 app 的配置层展开（`config-expand.ts`），所以插件这一层只认展开后的值。
 * 没兑现的引用会被原样留下，此时**拒绝发请求**并点名那个变量——这是 `config-expand.ts`
 * 写下的规矩（「owning plugin refuses it before any request goes out」），照做是因为把
 * `{env:X}` 当密钥发出去换回来的只会是一个没有线索的 401。
 *
 * 只有第 3 档读环境变量，而且只在配置里**什么都没写**时：那时没有「操作者写下的意图」被
 * 顶掉，读环境是纯粹的零配置默认值。
 *
 * ## 两件安全/资源上的事，都在这一层
 *
 *  - **SSRF 与重定向**：每一跳（含重定向后的地址）都过 `isSafeHttpUrl`，只跟有限跳数；
 *    响应体有字节上限，剥离后还有字符上限。这些都是「模型给什么就取什么」这句话的代价。
 *  - **权限**：两者都是 `network`，而 `network` 是**读**，所以在 `auto` 档里直接放行
 *    （理由见 `permission.ts` 的 `autoAllows`：抓一个 URL 改不了这台机器上的任何东西，
 *    而 Hermes 的审批根本不覆盖联网工具）。出网安全靠上面那条 URL 校验，不是靠打断运行
 *    去问人。
 */
import { errMessage, isSafeHttpUrl, objectConfig, tools as toolsKey } from '@noa/core';
import type { ConfigSchema, Context, Plugin } from '@noa/core';
import { registerTool } from '../toolbox.js';
import { intArg, strArg } from './args.js';

/** 这一行的设置（`plugins.entries[].config`）。 */
export interface WebPluginConfig {
  /**
   * SearXNG 形状的搜索端点（`{baseURL}/search?q=…&format=json`）。
   *
   * 不配置**不等于没有搜索**：`web_search` 会依次退到 TinyFish、再到免 key 的
   * DuckDuckGo（见文件头的阶梯）。这一项是给「想自己起一个」的部署准备的，不是启用搜索
   * 的开关。
   */
  searchBaseURL?: string;
  /**
   * 搜索凭据。**没写 `searchBaseURL` 时它就是 TinyFish 的 key**（`X-API-Key`）；写了则
   * 是那个 SearXNG 端点的 bearer token（自托管通常不需要）。
   *
   * 值可以是 `{env:NAME}` 引用（由 app 在加载时展开）。引用没兑现时本插件拒发请求并点名
   * 那个变量，而不是把一个字面量当密钥发出去换一个 401。
   */
  searchApiKey?: string;
  /** `web_fetch` 的默认字符上限。默认 20000。 */
  maxChars?: number;
  /** 单次请求的墙钟上限（毫秒）。默认 30000。 */
  timeoutMs?: number;
}

export const Config: ConfigSchema<WebPluginConfig> = objectConfig<WebPluginConfig>({
  searchBaseURL: { type: 'string' },
  searchApiKey: { type: 'string' },
  maxChars: { type: 'number' },
  timeoutMs: { type: 'number' },
});

/** 默认字符上限：够读一篇长文，又不至于把一次抓取变成一整轮上下文的全部。 */
export const DEFAULT_WEB_MAX_CHARS = 20_000;
/** 硬上限：模型可以在默认值之下请求更少，但不能把上限顶到无限。 */
export const MAX_WEB_CHARS = 200_000;
/** 响应体字节上限（剥标签之前）：超出的部分不读，避免一个坏端点把内存吃掉。 */
export const WEB_MAX_BYTES = 4 * 1024 * 1024;
/** 默认请求墙钟。 */
export const DEFAULT_WEB_TIMEOUT_MS = 30_000;
/** 最多跟几跳重定向（每一跳都重新过安全校验）。 */
const MAX_REDIRECTS = 5;

/**
 * `web_fetch` / `web_search` 作为标准插件。
 *
 * 设置来自**这一行自己的 config**（`plugins.entries[].config`），不是宿主的某个字段：
 * 宿主不知道什么是搜索端点，而「加一个可配置项 = 改宿主代码」正是这个仓库明确不要的
 * 那种耦合（见 `runtime-builtins.ts` 的说明）。
 * @returns the plugin.
 */
export function webPlugin(): Plugin<WebPluginConfig> {
  return {
    name: 'web',
    description: 'Fetch a URL as text, and search the web.',
    manifest: {
      title: '联网',
      description: '抓取网页正文为文本；按关键词搜索（TinyFish / 自配端点 / 免 key 兜底）。',
      tier: 'standard',
    },
    Config,
    inject: [toolsKey],
    apply: (ctx: Context, config: WebPluginConfig): void => {
      const settings = config ?? {};
      const maxChars = clampChars(settings.maxChars ?? DEFAULT_WEB_MAX_CHARS);
      const timeoutMs = settings.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;

      registerTool(ctx, {
        name: 'web_fetch',
        description:
          'Fetch a URL over http/https and return its content as plain text (HTML is stripped to readable text). '
          + 'Args: url (required), max_chars (optional; capped by configuration). Use it to read a page whose address you '
          + 'already know — not to search.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Absolute http/https URL to fetch.' },
            max_chars: { type: 'number', description: 'Optional cap on returned characters.' },
          },
          required: ['url'],
          additionalProperties: false,
        },
        execute: (args) => fetchAsText(args, maxChars, timeoutMs),
      }, 'network');

      const backend = resolveSearchBackend(settings);
      registerTool(ctx, {
        name: 'web_search',
        description:
          'Search the web and return a numbered list of result titles, URLs and snippets. '
          + 'Args: query (required), limit (optional, default 5). Follow up with web_fetch to read a result.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            limit: { type: 'number', description: 'How many results to return (default 5, max 20).' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        execute: (args) => runSearchTool(args, backend, timeoutMs),
      }, 'network');
    },
  };
}

/** TinyFish 的搜索端点：`GET /?query=…`，认证靠 `X-API-Key`（无分页大小参数）。 */
const TINYFISH_SEARCH_ENDPOINT = 'https://api.search.tinyfish.ai/';
/** 第三档读的环境变量名（照 TinyFish 自家 SDK 的 `process.env.TINYFISH_API_KEY`）。 */
const TINYFISH_KEY_ENV = 'TINYFISH_API_KEY';

/** 搜索后端的选择结果。 */
type SearchBackend =
  | { readonly kind: 'searxng'; readonly baseURL: string; readonly apiKey?: string | undefined }
  | { readonly kind: 'tinyfish'; readonly apiKey: string }
  | { readonly kind: 'duckduckgo' };

/**
 * 按文件头那条阶梯挑后端。纯函数：环境变量从参数进来，好测（也免得测试去动全局）。
 * @param settings - this row's config.
 * @param env - the environment, for the ambient-key rung.
 * @returns the chosen backend.
 */
export function resolveSearchBackend(
  settings: WebPluginConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SearchBackend {
  const configured = nonEmpty(settings.searchApiKey);
  const baseURL = nonEmpty(settings.searchBaseURL);
  if (baseURL !== undefined) return { kind: 'searxng', baseURL, apiKey: configured };
  if (configured !== undefined) return { kind: 'tinyfish', apiKey: configured };
  const ambient = nonEmpty(env[TINYFISH_KEY_ENV]);
  if (ambient !== undefined) return { kind: 'tinyfish', apiKey: ambient };
  return { kind: 'duckduckgo' };
}

/** 去掉空白后的值；空串等于没写（配置里留一个 `""` 不该被当成一个选择）。 */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * `{env:NAME}` 引用的形状。刻意无 `g`：这个正则会被反复 test，带状态会漏判
 * （同 `channel-qq/src/settings.ts` 里那一份；插件包不能依赖 app，所以各自留一行）。
 */
const ENV_REF = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/;

/** 值里没兑现的 `{env:NAME}` 引用名；undefined = 可用。 */
function unresolvedEnvRef(value: string): string | undefined {
  return ENV_REF.exec(value)?.[1];
}

/** 未兑现引用时拒发请求的那句话：点名变量，也给出两条出路。 */
function unresolvedKeyError(variable: string): string {
  return `Error: searchApiKey 引用了未设置的环境变量 {env:${variable}}，没有可用的搜索凭据。`
    + `请在 shell 里设置 ${variable}，或把 ~/.noa/config.json 里这一项改成字面值。`;
}

/** 把一次搜索派给选中的后端。 */
function runSearchTool(
  args: Record<string, unknown>,
  backend: SearchBackend,
  timeoutMs: number,
): Promise<string> {
  switch (backend.kind) {
    case 'searxng':
      return runSearch(args, backend.baseURL, backend.apiKey, timeoutMs);
    case 'tinyfish':
      return runTinyFishSearch(args, backend.apiKey, timeoutMs);
    case 'duckduckgo':
      return runKeylessSearch(args, timeoutMs);
  }
}

/** 上限收敛：模型请求的字符数只能在 [1, MAX_WEB_CHARS] 之内。 */
function clampChars(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_WEB_MAX_CHARS;
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_WEB_CHARS);
}

/** 一次 GET，带跳数受限的重定向与逐步的安全校验。 */
async function fetchOnce(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isSafeHttpUrl(current)) {
        throw new Error(`refusing to fetch ${current.slice(0, 120)}（只允许公网的 http/https 地址）`);
      }
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'noa/0.1 (+https://github.com/)', ...headers },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        // A 3xx with no Location is not a redirect: hand it back and let the
        // status check report it honestly.
        if (location === null) return { response, finalUrl: current };
        current = new URL(location, current).toString();
        continue;
      }
      return { response, finalUrl: current };
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读响应体，字节数有上限。
 *
 * `response.text()` 在这两个维度上都是无界的（大小与时间），而目标地址来自模型——所以
 * 手动读流并在超限时取消，而不是等一个坏端点把内存占满。
 */
async function readCappedText(response: Response, cap: number): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= cap) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8').decode(concatBytes(chunks));
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchAsText(args: Record<string, unknown>, maxChars: number, timeoutMs: number): Promise<string> {
  const url = strArg(args, 'url')?.trim();
  if (url === undefined || url.length === 0) return 'Error: url is required.';
  const cap = clampChars(intArg(args, 'max_chars') ?? maxChars);
  try {
    const { response, finalUrl } = await fetchOnce(url, timeoutMs);
    if (!response.ok) return `Error: HTTP ${response.status} for ${finalUrl}`;
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const raw = await readCappedText(response, WEB_MAX_BYTES);
    const text = contentType.includes('html') ? htmlToText(raw) : raw.trim();
    const clipped = clip(text, cap);
    return finalUrl === url ? clipped : `（已重定向到 ${finalUrl}）\n\n${clipped}`;
  } catch (err) {
    return `Error: ${errMessage(err)}`;
  }
}

/** 超长就截断并说明截掉了多少，让模型知道还有内容。 */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…（已截断，共 ${text.length} 字符，只返回前 ${maxChars} 个）`;
}

/**
 * HTML → 文本（零依赖）。
 *
 * 顺序即正确性：先整块去掉 script/style（它们的**内容**不是正文，留下会把 JS 源码当
 * 正文读），再去注释，再把块级标签换成换行（否则 `</p><p>` 会把两段粘成一行），最后才
 * 剥剩下的标签、解实体、收空白。
 * @param html - the raw document.
 * @returns readable text.
 */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ');
  text = text.replace(/<!--[\s\S]*?-->/gu, ' ');
  text = text.replace(/<\s*br\s*\/?\s*>/giu, '\n');
  text = text.replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol)\s*>/giu, '\n');
  text = text.replace(/<[^>]*>/gu, ' ');
  text = decodeEntities(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1] !== ''))
    .join('\n')
    .trim();
}

/** 常见命名实体 + 数字实体。够用即止：剩下的原样留着比猜错好。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™',
  middot: '·', bull: '•', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', times: '×', divide: '÷', deg: '°', euro: '€',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * 搜索：SearXNG 形状的 JSON 端点。
 */
async function runSearch(
  args: Record<string, unknown>,
  baseURL: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<string> {
  const query = strArg(args, 'query')?.trim();
  if (query === undefined || query.length === 0) return 'Error: query is required.';
  const limit = Math.min(Math.max(intArg(args, 'limit') ?? 5, 1), 20);
  const missing = apiKey === undefined ? undefined : unresolvedEnvRef(apiKey);
  if (missing !== undefined) return unresolvedKeyError(missing);
  const endpoint = new URL('/search', baseURL.endsWith('/') ? baseURL : `${baseURL}/`);
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('count', String(limit));
  try {
    const { response, finalUrl } = await fetchOnce(
      endpoint.toString(),
      timeoutMs,
      apiKey !== undefined && apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : undefined,
    );
    if (!response.ok) return `Error: HTTP ${response.status} for ${finalUrl}`;
    const body = await readCappedText(response, WEB_MAX_BYTES);
    return formatSearchResults(body, query);
  } catch (err) {
    return `Error: ${errMessage(err)}`;
  }
}

/**
 * SearXNG 的 `{ results: [{ title, url, content }] }` → 编号清单。
 *
 * 形状不对就如实说是协议问题，而不是返回一句「没有结果」：把「端点配错了」说成
 * 「网上没有」，会让模型据此下结论。
 * @param body - the response body.
 * @param query - the query, for the header line.
 * @returns the formatted list, or a protocol complaint.
 */
export function formatSearchResults(body: string, query: string): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return `Error: 搜索端点返回的不是 JSON（前 200 字符：${body.slice(0, 200)}）`;
  }
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return 'Error: 搜索端点返回的 JSON 里没有 results 数组（本工具期望 SearXNG 形状）。';
  }
  if (results.length === 0) return `没有找到与「${query}」相关的结果。`;
  const lines = results.slice(0, 20).map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const title = typeof item['title'] === 'string' ? item['title'] : '(无标题)';
    const url = typeof item['url'] === 'string' ? item['url'] : '(无链接)';
    const snippet = typeof item['content'] === 'string' ? item['content'].replace(/\s+/gu, ' ').trim() : '';
    return `${index + 1}. ${title}\n   ${url}${snippet.length > 0 ? `\n   ${snippet}` : ''}`;
  });
  return `「${query}」的搜索结果（配置的搜索端点）：\n${lines.join('\n')}`;
}

/**
 * TinyFish 搜索：`GET https://api.search.tinyfish.ai/?query=…`，认证头 `X-API-Key`。
 *
 * 与 SearXNG 那条路的区别只有两点：认证头不同，以及**没有分页大小参数**（接口只给
 * `page`，不给 `count`）——所以 `limit` 在客户端切，并在截断时如实说明还有多少条。
 * 走同一个 `fetchOnce`，于是 URL 安全校验、重定向上限、字节上限一条都不少。
 * @param args - the tool arguments.
 * @param apiKey - the TinyFish key.
 * @param timeoutMs - wall clock for the request.
 * @returns the formatted list, or an honest complaint.
 */
async function runTinyFishSearch(
  args: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
): Promise<string> {
  const query = strArg(args, 'query')?.trim();
  if (query === undefined || query.length === 0) return 'Error: query is required.';
  const limit = Math.min(Math.max(intArg(args, 'limit') ?? 5, 1), 20);
  const missing = unresolvedEnvRef(apiKey);
  if (missing !== undefined) return unresolvedKeyError(missing);
  const endpoint = new URL(TINYFISH_SEARCH_ENDPOINT);
  endpoint.searchParams.set('query', query);
  try {
    const { response, finalUrl } = await fetchOnce(endpoint.toString(), timeoutMs, { 'x-api-key': apiKey });
    if (!response.ok) return `Error: HTTP ${response.status} for ${finalUrl}`;
    const body = await readCappedText(response, WEB_MAX_BYTES);
    return formatTinyFishResults(body, query, limit);
  } catch (err) {
    return `Error: ${errMessage(err)}`;
  }
}

/**
 * TinyFish 的 `{ results: [{ title, url, snippet, site_name, date? }], total_results, page }`
 * → 编号清单。
 *
 * 字段名与 SearXNG 不同（`snippet` 对 `content`、`total_results` 对没有），所以各自一个
 * 格式化函数而不是硬塞进一个——把两个协议塞进一个函数，代价是每次读它都要先想「现在走的
 * 是哪条路」。输出形状则刻意保持一致，模型不必按后端改读法。
 *
 * `site_name` / `date` 不输出：前者是 URL 的冗余（域名就在下一行），后者只在部分结果上
 * 有，加了会让同一份清单参差不齐；要日期就 `web_fetch` 那一页。
 * @param body - the response body.
 * @param query - the query, for the header line.
 * @param limit - how many results to return.
 * @returns the formatted list, or a protocol complaint.
 */
export function formatTinyFishResults(body: string, query: string, limit: number): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return `Error: TinyFish 搜索返回的不是 JSON（前 200 字符：${body.slice(0, 200)}）`;
  }
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return 'Error: TinyFish 搜索返回的 JSON 里没有 results 数组。';
  }
  if (results.length === 0) return `没有找到与「${query}」相关的结果。`;
  const shown = results.slice(0, limit);
  const lines = shown.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const title = typeof item['title'] === 'string' ? item['title'] : '(无标题)';
    const url = typeof item['url'] === 'string' ? item['url'] : '(无链接)';
    const snippet = typeof item['snippet'] === 'string' ? item['snippet'].replace(/\s+/gu, ' ').trim() : '';
    return `${index + 1}. ${title}\n   ${url}${snippet.length > 0 ? `\n   ${snippet}` : ''}`;
  });
  const total = (json as { total_results?: unknown }).total_results;
  const more = results.length > shown.length
    ? `\n…（TinyFish 报告共 ${typeof total === 'number' ? total : results.length} 条，这里只显示前 ${shown.length} 条）`
    : '';
  return `「${query}」的搜索结果（TinyFish）：\n${lines.join('\n')}${more}`;
}

/** 免 key 兜底搜索的后端：DuckDuckGo 的 lite 页面（纯 HTML，无 JS、无 key）。 */
const DDG_LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';

/**
 * 免 key 搜索：抓 DuckDuckGo lite 的结果页，解析成与 SearXNG 那条路同样的形状。
 *
 * 为什么不干脆「没配端点就报错」：见文件头的阶梯说明——一个装好就能搜的默认值，比一个
 * 需要先去弄一个搜索服务才能用的工具，更符合这个产品的用法（手机上、无人值守）。
 * @param args - the tool arguments.
 * @param timeoutMs - wall clock for the request.
 * @returns the formatted list, or an honest complaint.
 */
async function runKeylessSearch(args: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const query = strArg(args, 'query')?.trim();
  if (query === undefined || query.length === 0) return 'Error: query is required.';
  const limit = Math.min(Math.max(intArg(args, 'limit') ?? 5, 1), 20);
  const endpoint = new URL(DDG_LITE_ENDPOINT);
  endpoint.searchParams.set('q', query);
  try {
    const { response, finalUrl } = await fetchOnce(endpoint.toString(), timeoutMs);
    if (!response.ok) return `Error: HTTP ${response.status} for ${finalUrl}`;
    const body = await readCappedText(response, WEB_MAX_BYTES);
    return formatDuckDuckGoResults(body, query, limit);
  } catch (err) {
    return `Error: ${errMessage(err)}`;
  }
}

/** 一条解析出来的结果。 */
interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * DuckDuckGo lite 的结果页 → 编号清单。
 *
 * 页面形状（每条约三行）：
 * `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=<编码后的真实地址>&rut=…" class='result-link'>标题</a>`
 * 后面跟一个 `class='result-snippet'` 的单元格。
 *
 * 两个必须做对的细节：
 *  - **真实地址藏在 `uddg` 参数里**，是百分号编码的；直接把 `duckduckgo.com/l/?…` 当结果
 *    交给模型，等于给了一串跳转链接。广告行的 href 是 `duckduckgo.com/y.js?…`（没有
 *    `uddg`），**跳过**——它不是搜索结果。
 *  - 一条结果的摘要要取「它自己之后、下一条结果之前」的那个单元格，不能按序号硬配：
 *    有的条目没有摘要，按序号配会把下面那条的摘要挪到上面。
 *
 * 解析不出任何结果时**不说「没有找到」**：这个页面在正常查询下几乎总会有结果，所以
 * 「一条都没有」更可能是被拦了或页面改版了。把这两种情况分开说，模型才不会据此下结论。
 * @param body - the response body.
 * @param query - the query, for the header line.
 * @param limit - how many results to return.
 * @returns the formatted list, or an honest complaint.
 */
export function formatDuckDuckGoResults(body: string, query: string, limit: number): string {
  const hits = parseDuckDuckGoResults(body);
  if (hits.length === 0) {
    if (/no\s+results|未找到|没有找到/iu.test(body)) return `没有找到与「${query}」相关的结果。`;
    return 'Error: 没能从 DuckDuckGo 的结果页里解析出任何结果（页面形状变了，或这次请求被拦了）。'
      + '要绕开它，在这一行的 config 里写 `searchBaseURL` 指向一个 SearXNG 端点。';
  }
  const lines = hits.slice(0, limit).map((hit, index) =>
    `${index + 1}. ${hit.title}\n   ${hit.url}${hit.snippet.length > 0 ? `\n   ${hit.snippet}` : ''}`);
  return `「${query}」的搜索结果（DuckDuckGo）：\n${lines.join('\n')}`;
}

/** 结果页 → 命中列表。纯函数，好测（夹具是一段真实页面）。 */
export function parseDuckDuckGoResults(body: string): SearchHit[] {
  const anchor = /<a\b[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/giu;
  const found: { start: number; end: number; title: string; href: string }[] = [];
  for (let match = anchor.exec(body); match !== null; match = anchor.exec(body)) {
    const href = /href=['"]([^'"]+)['"]/iu.exec(match[0])?.[1] ?? '';
    found.push({ start: match.index, end: anchor.lastIndex, title: flatten(match[1] ?? ''), href });
  }
  const hits: SearchHit[] = [];
  for (const [index, item] of found.entries()) {
    const url = realUrl(item.href);
    if (url === undefined) continue;
    // 摘要的搜索范围止于**下一条结果锚点的起点**（不是终点）：那才是「这一条自己的」区域。
    const stop = found[index + 1]?.start ?? body.length;
    const slice = body.slice(item.end, stop);
    const snippet = flatten(/<td\b[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/iu.exec(slice)?.[1] ?? '');
    hits.push({ title: item.title.length > 0 ? item.title : '(无标题)', url, snippet });
  }
  return hits;
}

/**
 * 一条结果的真实地址。
 *
 * lite 页把地址放在 `//duckduckgo.com/l/?uddg=<百分号编码>` 里；没有 `uddg` 的锚点，
 * 如果它指向 duckduckgo.com 自己，那是**跳转器或广告**（`/y.js?ad_provider=…`），不是
 * 搜索结果 —— 返回 undefined 由调用方跳过。直接就是别的 http(s) 站点的（少见）原样用。
 *
 * 宁可少一条也不要多一条：把广告当结果交给模型，比漏掉一条真结果糟得多。
 */
function realUrl(href: string): string | undefined {
  if (href.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(href, 'https://duckduckgo.com');
  } catch {
    return undefined;
  }
  const uddg = parsed.searchParams.get('uddg');
  if (uddg !== null && uddg.length > 0) {
    // `searchParams` 已经解过一层百分号编码；剩下的交给 isSafeHttpUrl 判定。
    return /^https?:\/\//iu.test(uddg) ? uddg : undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const host = parsed.hostname.toLowerCase();
  if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) return undefined;
  return parsed.toString();
}

/** 一小段 HTML → 单行文本（去标签、解实体、收空白）。 */
function flatten(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim();
}
