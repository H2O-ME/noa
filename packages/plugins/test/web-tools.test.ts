/**
 * 联网工具的四条契约。
 *
 *  1. **HTML 变文本**：`web_fetch` 的价值全在这一步。先整块去掉 script/style 的内容
 *     （留下就把 JS 源码当正文），块级标签换行（否则两段粘成一行），最后解实体。
 *  2. **搜索始终存在，且后端按阶梯选**：显式 `searchBaseURL` → TinyFish（`searchApiKey`
 *     或环境里的 `TINYFISH_API_KEY`）→ 免 key 的 DuckDuckGo（照 Hermes 的
 *     `_autodetect_backend` / `_keyless_backend`）。原先「没配就不注册」的理由是「一个查
 *     不到的搜索工具比没有更糟」——有了兜底，这个理由不成立了。
 *  3. **TinyFish 的协议**：字段是 `snippet` 不是 `content`，认证走 `X-API-Key`，且接口没有
 *     分页大小参数，所以 `limit` 在客户端切、截断要说明。
 *  4. **DuckDuckGo 那页的形状**：真实地址藏在 `uddg` 参数里（百分号编码），广告行没有它
 *     必须跳过，摘要只归「自己那一条」。
 *
 * 测试不联网：fetch 被替换成假的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginHost } from '../src/index.js';
import {
  webPlugin,
  htmlToText,
  decodeEntities,
  formatSearchResults,
  formatTinyFishResults,
  formatDuckDuckGoResults,
  parseDuckDuckGoResults,
  resolveSearchBackend,
} from '../src/builtin/web.js';
import { rowsOf, configuredRowsOf } from './plugin-rows.js';

/** 装配这一行（带 config）并返回工具表。 */
async function hostWith(config?: unknown): Promise<PluginHost> {
  const host = new PluginHost('.');
  await host.sync(config === undefined
    ? rowsOf([webPlugin()])
    : configuredRowsOf([webPlugin()], { web: config }));
  return host;
}

const HTML = `<!doctype html><html><head><title>T</title>
<script>var leak = "SHOULD NOT APPEAR";</script>
<style>.x{color:red}</style></head>
<body><h1>标题</h1><p>第一段 &amp; 实体 &#65;</p>
<p>第二段</p><ul><li>甲</li><li>乙</li></ul>
<!-- 注释也要去掉 -->
</body></html>`;

/** 一次假请求带上的某个请求头。写成函数是为了不在可选链的结果上直接取下标。 */
function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  return headers === undefined ? undefined : (headers as Record<string, string>)[name];
}

afterEach(() => {
  vi.unstubAllGlobals();
  // 环境变量必须还原：这台机器上真的设了 TINYFISH_API_KEY，不还原的话「没配就走
  // DuckDuckGo」那条用例会变成走 TinyFish，而且只在别人的机器上绿。
  vi.unstubAllEnvs();
});

describe('htmlToText', () => {
  it('drops script/style content, breaks blocks and decodes entities', () => {
    const text = htmlToText(HTML);
    expect(text).not.toContain('SHOULD NOT APPEAR');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('注释');
    expect(text).not.toContain('<');
    expect(text).toContain('标题');
    expect(text).toContain('第一段 & 实体 A');
    // A block boundary becomes a line break rather than gluing two paragraphs.
    expect(text.split('\n').filter((line) => line.length > 0)).toEqual([
      '标题', '第一段 & 实体 A', '第二段', '甲', '乙',
    ]);
  });

  it('decodes named and numeric entities, leaving unknown ones alone', () => {
    expect(decodeEntities('a &amp; b &mdash; c &#39;d&#39; &unknown;')).toBe("a & b — c 'd' &unknown;");
  });
});

describe('web_fetch', () => {
  it('fetches, strips HTML and reports the text', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const host = await hostWith();
    const tool = host.tools.find((t) => t.name === 'web_fetch')!;
    const out = await tool.execute({ url: 'https://example.com/page' }, { rootDir: '.' });
    expect(out).toContain('标题');
    expect(out).not.toContain('SHOULD NOT APPEAR');
  });

  it('refuses a non-http scheme and a private literal without dialing', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const host = await hostWith();
    const tool = host.tools.find((t) => t.name === 'web_fetch')!;
    expect(await tool.execute({ url: 'file:///etc/passwd' }, { rootDir: '.' })).toContain('Error');
    expect(await tool.execute({ url: 'http://127.0.0.1/secret' }, { rootDir: '.' })).toContain('Error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows a redirect, re-checking the target', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url));
      if (String(url).endsWith('/a')) {
        return new Response(null, { status: 302, headers: { location: 'https://example.com/b' } });
      }
      return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const host = await hostWith();
    const tool = host.tools.find((t) => t.name === 'web_fetch')!;
    const out = await tool.execute({ url: 'https://example.com/a' }, { rootDir: '.' });
    expect(seen).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(out).toContain('done');
  });

  it('refuses to follow a redirect into a private address', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/admin' } }));
    const host = await hostWith();
    const tool = host.tools.find((t) => t.name === 'web_fetch')!;
    expect(await tool.execute({ url: 'https://example.com/a' }, { rootDir: '.' })).toContain('Error');
  });

  it('clips a long body and says how much was dropped', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('x'.repeat(500), { status: 200, headers: { 'content-type': 'text/plain' } }));
    const host = await hostWith();
    const tool = host.tools.find((t) => t.name === 'web_fetch')!;
    const out = await tool.execute({ url: 'https://example.com/a', max_chars: 100 }, { rootDir: '.' });
    expect(out).toContain('已截断');
    expect(out.length).toBeLessThan(300);
  });

  it('reports a non-2xx status instead of an empty page', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    const host = await hostWith();
    const tool = host.tools.find((t) => t.name === 'web_fetch')!;
    expect(await tool.execute({ url: 'https://example.com/a' }, { rootDir: '.' })).toContain('HTTP 404');
  });
});

describe('web_search', () => {
  it('exists even with no search endpoint configured (keyless fallback)', async () => {
    // 线上原样事故：这个部署没配 searchBaseURL，于是 web_search 根本没注册，模型调它拿到
    // 「unknown tool」，然后把「工具不存在」当成「网上没有」。工具必须一直在。
    const bare = await hostWith();
    expect(bare.tools.some((t) => t.name === 'web_search')).toBe(true);
    const configured = await hostWith({ searchBaseURL: 'https://searx.example' });
    expect(configured.tools.some((t) => t.name === 'web_search')).toBe(true);
  });

  it('queries the SearXNG shape and formats the results', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({
        results: [
          { title: '第一篇', url: 'https://a.example', content: '摘要一' },
          { title: '第二篇', url: 'https://b.example', content: '摘要二' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const host = await hostWith({ searchBaseURL: 'https://searx.example' });
    const tool = host.tools.find((t) => t.name === 'web_search')!;
    const out = await tool.execute({ query: '天气', limit: 2 }, { rootDir: '.' });
    expect(seen[0]).toContain('/search?');
    expect(seen[0]).toContain('format=json');
    expect(out).toContain('1. 第一篇');
    expect(out).toContain('https://b.example');
  });

  it('says the endpoint is misconfigured rather than "no results"', () => {
    expect(formatSearchResults(JSON.stringify({ ok: true }), 'q')).toContain('没有 results 数组');
    expect(formatSearchResults('not json', 'q')).toContain('不是 JSON');
    expect(formatSearchResults(JSON.stringify({ results: [] }), 'q')).toContain('没有找到');
  });

  it('falls back to DuckDuckGo when no endpoint is configured', async () => {
    vi.stubEnv('TINYFISH_API_KEY', '');
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url));
      return new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    });
    const host = await hostWith();
    const tool = host.tools.find((t) => t.name === 'web_search')!;
    const out = await tool.execute({ query: 'deepseek api' }, { rootDir: '.' });
    expect(seen[0]).toContain('lite.duckduckgo.com');
    expect(seen[0]).toContain('q=deepseek+api');
    expect(out).toContain('1. Your First API Call | DeepSeek API Docs');
    expect(out).toContain('https://api-docs.deepseek.com/');
  });
});

describe('search backend ladder', () => {
  it('walks endpoint → configured key → ambient key → keyless', () => {
    expect(resolveSearchBackend({ searchBaseURL: 'https://searx.example' }, {})).toEqual({
      kind: 'searxng', baseURL: 'https://searx.example', apiKey: undefined,
    });
    expect(resolveSearchBackend({ searchApiKey: 'row-key' }, {})).toEqual({
      kind: 'tinyfish', apiKey: 'row-key',
    });
    expect(resolveSearchBackend({}, { TINYFISH_API_KEY: 'env-key' })).toEqual({
      kind: 'tinyfish', apiKey: 'env-key',
    });
    expect(resolveSearchBackend({}, {})).toEqual({ kind: 'duckduckgo' });
  });

  it('lets the row beat the ambient variable, and an explicit endpoint beat both', () => {
    // 配置里写下的东西是操作者的显式决定，不该被一个残留的环境变量顶掉。
    expect(resolveSearchBackend({ searchApiKey: 'row-key' }, { TINYFISH_API_KEY: 'env-key' })).toEqual({
      kind: 'tinyfish', apiKey: 'row-key',
    });
    expect(resolveSearchBackend(
      { searchBaseURL: 'https://searx.example', searchApiKey: 'row-key' },
      { TINYFISH_API_KEY: 'env-key' },
    )).toEqual({ kind: 'searxng', baseURL: 'https://searx.example', apiKey: 'row-key' });
  });

  it('treats a blank setting as absent', () => {
    // `"searchApiKey": ""` 不是「选 TinyFish 但没 key」，是没写。
    expect(resolveSearchBackend({ searchApiKey: '   ' }, { TINYFISH_API_KEY: 'env-key' })).toEqual({
      kind: 'tinyfish', apiKey: 'env-key',
    });
    expect(resolveSearchBackend({ searchBaseURL: '' }, {})).toEqual({ kind: 'duckduckgo' });
  });
});

describe('TinyFish backend', () => {
  it('sends the key as X-API-Key and formats the results', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(TINYFISH_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const host = await hostWith({ searchApiKey: 'tf-row-key' });
    const tool = host.tools.find((t) => t.name === 'web_search')!;
    const out = await tool.execute({ query: 'deepseek api docs', limit: 2 }, { rootDir: '.' });

    expect(calls[0]?.url).toContain('api.search.tinyfish.ai');
    expect(calls[0]?.url).toContain('query=deepseek+api+docs');
    expect(headerOf(calls[0]?.init, 'x-api-key')).toBe('tf-row-key');
    expect(out).toContain('（TinyFish）');
    expect(out).toContain('1. DeepSeek API Docs: Your First API Call');
    expect(out).toContain('https://api-docs.deepseek.com/');
    expect(out).toContain('OpenAI/Anthropic');
  });

  it('uses the ambient key when the row config names none', async () => {
    vi.stubEnv('TINYFISH_API_KEY', 'tf-env-key');
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      inits.push(init);
      return new Response(TINYFISH_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const host = await hostWith();
    const tool = host.tools.find((t) => t.name === 'web_search')!;
    await tool.execute({ query: 'q' }, { rootDir: '.' });
    expect(headerOf(inits[0], 'x-api-key')).toBe('tf-env-key');
  });

  it('slices to the limit client-side and says how many it withheld', async () => {
    // 接口没有分页大小参数（只给 page），所以只能自己切；切了就要说，否则模型以为就这两条。
    const out = formatTinyFishResults(TINYFISH_JSON, 'q', 2);
    expect(out).toContain('2. DeepSeek 开放平台');
    expect(out).not.toContain('GitHub');
    expect(out).toContain('共 3 条');
  });

  it('says the protocol is wrong rather than "no results"', () => {
    expect(formatTinyFishResults('not json', 'q', 5)).toContain('不是 JSON');
    expect(formatTinyFishResults(JSON.stringify({ ok: true }), 'q', 5)).toContain('没有 results 数组');
    expect(formatTinyFishResults(JSON.stringify({ results: [] }), 'q', 5)).toContain('没有找到');
  });

  it('refuses an unexpanded {env:} reference instead of sending it as a key', async () => {
    // 配置层对没兑现的引用会原样留下（`config-expand.ts` 的规矩），此时发出去换回来的只会
    // 是一个没有线索的 401 —— 所以本插件在发请求之前就拒，并点名那个变量。
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const host = await hostWith({ searchApiKey: '{env:NO_SUCH_SEARCH_KEY}' });
    const tool = host.tools.find((t) => t.name === 'web_search')!;
    const out = await tool.execute({ query: 'q' }, { rootDir: '.' });
    expect(out).toContain('{env:NO_SUCH_SEARCH_KEY}');
    expect(out).toContain('未设置');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/** TinyFish 真实响应的形状（截取自实机）：字段是 `snippet`，另有 `site_name`/`position`。 */
const TINYFISH_JSON = JSON.stringify({
  query: 'deepseek api docs',
  results: [
    {
      position: 1,
      site_name: 'api-docs.deepseek.com',
      snippet: 'The DeepSeek API uses an API format compatible with OpenAI/Anthropic.',
      title: 'DeepSeek API Docs: Your First API Call',
      url: 'https://api-docs.deepseek.com/',
    },
    {
      position: 2,
      site_name: 'platform.deepseek.com',
      snippet: '开放平台首页。',
      title: 'DeepSeek 开放平台',
      url: 'https://platform.deepseek.com/',
    },
    {
      position: 3,
      site_name: 'github.com',
      snippet: 'Repositories from DeepSeek.',
      title: 'deepseek-ai · GitHub',
      url: 'https://github.com/deepseek-ai',
    },
  ],
  total_results: 3,
  page: 0,
});

/**
 * 一段真实形状的 DuckDuckGo lite 结果页（截取自实机响应）：两条真结果，中间夹一行广告。
 * 第一条**没有摘要**，用来钉住「摘要只归自己那一条」——按序号硬配会把第二篇的摘要挪上去。
 */
const DDG_HTML = `<!DOCTYPE HTML><html><body><table>
<tr><td valign="top">1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fapi-docs.deepseek.com%2F&amp;rut=de73" class='result-link'>Your First <b>API</b> Call | DeepSeek API Docs</a></td></tr>
<tr><td valign="top">2.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/y.js?ad_provider=bingv7aa&amp;u3=x" class='result-link'>买点什么</a></td></tr>
<tr><td valign="top">3.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fdeepseek-ai&amp;rut=9f1" class='result-link'>deepseek-ai &middot; GitHub</a></td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>Repositories &amp; projects from DeepSeek.</td></tr>
</table></body></html>`;

describe('DuckDuckGo result parsing', () => {
  it('unwraps the uddg parameter and skips the ad row', () => {
    const hits = parseDuckDuckGoResults(DDG_HTML);
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://api-docs.deepseek.com/',
      'https://github.com/deepseek-ai',
    ]);
    expect(hits[0]?.title).toBe('Your First API Call | DeepSeek API Docs');
    expect(hits[1]?.title).toBe('deepseek-ai · GitHub');
    // 广告行的标题绝不出现：它没有 uddg，不是搜索结果。
    expect(JSON.stringify(hits)).not.toContain('买点什么');
  });

  it('gives a snippet only to the result it belongs to', () => {
    const hits = parseDuckDuckGoResults(DDG_HTML);
    expect(hits[0]?.snippet).toBe('');
    expect(hits[1]?.snippet).toBe('Repositories & projects from DeepSeek.');
  });

  it('refuses to call a broken page "no results"', () => {
    // 正常查询下这页几乎总有结果，所以「一条都没有」更可能是被拦了或改版了。把这两种
    // 情况分开说，模型才不会据此下结论。
    const broken = formatDuckDuckGoResults('<html><body>are you a robot?</body></html>', 'q', 5);
    expect(broken).toContain('没能');
    expect(broken).not.toContain('没有找到');
    expect(formatDuckDuckGoResults('<html>No results.</html>', 'q', 5)).toContain('没有找到');
  });

  it('honours the limit', () => {
    const out = formatDuckDuckGoResults(DDG_HTML, 'deepseek', 1);
    expect(out).toContain('1. Your First API Call');
    expect(out).not.toContain('deepseek-ai · GitHub');
  });
});
