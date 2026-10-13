/**
 * 凭据与 access_token：QQ 开放平台的鉴权前置件。
 *
 * 从 `protocol.ts` 拆出，因为它回答的是另一个问题：`protocol.ts` 讲**协议怎么走**
 * （网关状态机、REST 发消息），这里讲**拿什么证明自己是谁**（凭据从哪来、token 怎么
 * 取与缓存、什么时候必须丢弃）。两者唯一的连接点是网关与 REST 都消费一个
 * `AccessTokenManager`。
 *
 * 依赖全部注入（fetch / 时钟），测试不发真实网络请求。
 */
import { withDeadline } from './deadline.js';

export interface HttpClientResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type FetchLike = (
  url: string,
  // `body` 允许二进制：分片上传要把文件块原样 PUT 到预签名 URL（见 `uploadLocalC2C`）。
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal },
) => Promise<HttpClientResponse>;

export const TOKEN_ENDPOINT = 'https://api.bot.qq.com/app/getAppAccessToken';
/** Token 生命周期 7200s；余量低于该值即刷新（官方建议余量 <120s 主动换新）。 */
const TOKEN_REFRESH_MARGIN_MS = 120_000;

/**
 * 凭据来源：字面值，或一个**每次取用都重新读取**的 getter。
 *
 * getter 形式存在的理由：宿主（`nova --web`）会**在进程运行中**改写配置文件里的
 * 凭据，而通道对象必须保持稳定——插件已经在 roster 的候选清单里，重建它等于换掉
 * roster 身份（见 `createQqBotChannel` 的注释）。所以凭据迟绑定：通道构造时拿到的
 * 是取值函数，真正发请求时才读。
 */
export type CredentialSource = string | (() => string);

/** 一对解析后的凭据，带一个可比较的指纹。 */
interface ResolvedCredentials {
  appId: string;
  clientSecret: string;
  /** NUL 不可出现在配置值里，所以这个拼接不会与另一对凭据碰撞。 */
  fingerprint: string;
}

/** access_token 获取与缓存；单飞：并发 get() 共享同一次刷新请求。 */
export class AccessTokenManager {
  private token: string | undefined;
  private expiresAt = 0;
  private inflight: Promise<string> | undefined;
  /** 在飞请求对应哪对凭据（见 `get`）。 */
  private inflightFor: string | undefined;
  /** 当前缓存 token 是用哪对凭据换来的（见 `get`）。 */
  private mintedFor: string | undefined;

  constructor(
    private readonly appId: CredentialSource,
    private readonly clientSecret: CredentialSource,
    private readonly fetchFn: FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    const creds = this.credentials();
    // 换过凭据就必须丢弃旧 token：`expires_in` 有 2 小时，而旧 token 属于**上一个
    // appId**——继续用它只会得到 401，且缓存还会让这个错误持续到自然过期。按凭据指纹
    // 判定，调用方无需记得在任何一处显式作废。
    if (this.mintedFor !== creds.fingerprint) this.invalidate();
    if (this.token !== undefined && this.now() < this.expiresAt - TOKEN_REFRESH_MARGIN_MS) return this.token;
    // 单飞只对**同一对凭据**成立：凭据换了就是一个新问题，不能被上一次的在飞请求顶掉。
    if (this.inflight !== undefined && this.inflightFor === creds.fingerprint) return this.inflight;
    const pending = this.request(creds).finally(() => {
      if (this.inflight === pending) {
        this.inflight = undefined;
        this.inflightFor = undefined;
      }
    });
    this.inflight = pending;
    this.inflightFor = creds.fingerprint;
    return pending;
  }

  /** 401/鉴权失败时强制下次重新获取。 */
  invalidate(): void {
    this.token = undefined;
    this.expiresAt = 0;
    this.mintedFor = undefined;
  }

  /** 当前凭据里的 appId（惰性来源现读；BOT 身份按它缓存，见 `QqApi.botName`）。 */
  currentAppId(): string {
    return this.credentials().appId;
  }

  private credentials(): ResolvedCredentials {
    const appId = typeof this.appId === 'string' ? this.appId : this.appId();
    const clientSecret = typeof this.clientSecret === 'string' ? this.clientSecret : this.clientSecret();
    return { appId, clientSecret, fingerprint: `${appId}\u0000${clientSecret}` };
  }

  private async request(creds: ResolvedCredentials): Promise<string> {
    const body = await withDeadline(async (signal) => {
      const res = await this.fetchFn(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: creds.appId, clientSecret: creds.clientSecret }),
        signal,
      });
      // Read the body INSIDE the deadline: a transport that resolves the headers
      // and then stalls on the body would otherwise hang past the bound, and a
      // 200 whose body never arrives is not a token.
      const parsed = (await res.json().catch(() => undefined)) as
        | { access_token?: unknown; expires_in?: unknown }
        | undefined;
      return { res, parsed };
    }, 'access token request');
    const token = body.parsed?.access_token;
    if (!body.res.ok || typeof token !== 'string' || token.length === 0) {
      throw new Error(`qqbot: access token request failed (${body.res.status})`);
    }
    const raw = body.parsed?.expires_in;
    const seconds = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : 7200;
    // 只在凭据没在中途换过时才缓存：否则这次（属于旧凭据的）token 会覆盖掉新一轮请求
    // 刚写入的那一个。返回值照给——调用方拿到的是它请求时所对的那对凭据的 token。
    if (this.credentials().fingerprint === creds.fingerprint) {
      this.token = token;
      this.expiresAt = this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 7200) * 1000;
      this.mintedFor = creds.fingerprint;
    }
    return token;
  }
}
