/**
 * 出站 URL 的最小安全校验（一个实现，两个消费者）。
 *
 * 这不是一个通用的 SSRF 防护，而是一道**方向性**的闸门：URL 来自不受信的一方
 * （QQ 平台负载、模型给出的 `web_fetch` 目标），而本进程会带着自己的凭据/网络位置
 * 去 GET 它。所以只做两件不依赖 DNS 的事——只允许 http/https，以及拒绝回环/私网/
 * 链路本地的**字面量**地址。域名不解析（那要 IO，也会把判定变成一次网络往返）；真正的
 * 隔离归部署方（容器/网络策略）。
 *
 * 存在的理由与 Hermes 的同名检查一致：不校验就把「对方说去哪就去哪」变成了「任何能
 * 构造一条消息（或一句提示词）的人都能让机器人去取内网地址」。
 */

/** 允许的协议。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Whether a URL is safe to fetch on an untrusted input's behalf.
 *
 * One implementation on purpose: the QQ channel's media download and the
 * `web_fetch` tool both gate on this, and two copies of a security check is how
 * one of them quietly rots.
 * @param raw - the URL from the untrusted input.
 * @returns true when this process may fetch it.
 */
export function isSafeHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return false;
  // `url.hostname` keeps the brackets on an IPv6 literal (`[::1]`), so strip them
  // before judging the address.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host.length === 0) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  return !isPrivateLiteral(host);
}

/**
 * Whether a hostname is a private/loopback/link-local IP LITERAL.
 *
 * A plain domain name is never private by this test — resolving it would need IO,
 * and the caller's allowlist is the deployment, not this function.
 * @param host - the lowercased hostname.
 * @returns true when it is a literal private address.
 */
function isPrivateLiteral(host: string): boolean {
  // IPv6 literals: `URL` keeps the brackets on `hostname` (stripped by the
  // caller) and NORMALIZES an IPv4-mapped address to hex — `::ffff:127.0.0.1`
  // reads back as `::ffff:7f00:1`, which is why the mapped form is decoded below
  // rather than matched textually.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    // fc00::/7 (unique local) and fe80::/10 (link local).
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    const firstGroup = host.split(':')[0] ?? '';
    if (/^fe[89ab]/u.test(firstGroup)) return true;
    const mapped = ipv4MappedFromIpv6(host);
    return mapped !== undefined ? isPrivateIpv4(mapped) : false;
  }
  return isPrivateIpv4(host);
}

/**
 * Decode an IPv4-mapped IPv6 literal (`::ffff:…`) back to a dotted quad.
 *
 * Accepts both spellings the URL parser can produce: the dotted form when it is
 * left alone, and the hex-group form (`::ffff:7f00:1`) that WHATWG normalization
 * actually emits.
 * @param host - the bracketed-stripped IPv6 hostname.
 * @returns the dotted quad, or undefined when it is not an IPv4-mapped address.
 */
function ipv4MappedFromIpv6(host: string): string | undefined {
  const match = /^::ffff:(.+)$/u.exec(host);
  const rest = match?.[1];
  if (rest === undefined) return undefined;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(rest)) return rest;
  const groups = rest.split(':');
  if (groups.length !== 2) return undefined;
  const hi = Number.parseInt(groups[0] ?? '', 16);
  const lo = Number.parseInt(groups[1] ?? '', 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return undefined;
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
}

/** 127/8 · 10/8 · 172.16/12 · 192.168/16 · 169.254/16 · 0.0.0.0 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN));
  if (octets.some((n) => Number.isNaN(n) || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
