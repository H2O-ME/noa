/**
 * 这个行的设置：形状，以及关于密钥的两条规则。
 *
 * 设置直接写在 `plugins.entries[].config`（没有设置页），所以这里只剩「形状」与两条
 * 判定规则：
 *
 *  1. **不回显**：字面密钥永不进日志或错误信息；操作者自己写的 `{env:NAME}` 引用是
 *     **惰性文本**，可以照原样显示与再编辑。
 *  2. **不可用的凭据不拿去拨号**：配置层对**没能兑现**的 `{env:NAME}` 会原样留下，
 *     把它当密钥送去换 token 只会换来一句看不懂的 401。所以「这份设置能不能用」只有
 *     这一处判定——插件拿它决定拨不拨号，`noa --check` 拿它说明为什么没拨。
 */

/** `{env:NAME}` 引用的形状。刻意无 `g`：这个正则被反复 test，带状态会漏判。 */
const ENV_REF = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/;

/** 一次激活看得到的设置（行 `config` 的已校验值）。 */
export interface QqBotSettings {
  readonly appId?: string;
  readonly clientSecret?: string;
}

/** 值里没兑现的 `{env:NAME}` 引用名；undefined = 不是引用。 */
export function unresolvedEnvRef(value: string | undefined): string | undefined {
  const match = value === undefined ? null : ENV_REF.exec(value);
  return match?.[1];
}

/**
 * 「这份凭据能不能用」的**唯一定义**：undefined = 可以拿去拨号。
 *
 * 三种不可用各有各的说法，因为它们要人做的事不同：变量没设（去设环境变量）、
 * AppID 没填（去开放平台抄）、密钥没填（同左）。
 * @param settings - the row's settings.
 * @returns the reason it cannot be dialed with, or undefined when it can.
 */
export function qqBotCredentialProblem(settings: QqBotSettings): string | undefined {
  const appIdRef = unresolvedEnvRef(settings.appId);
  if (appIdRef !== undefined) return `AppID 引用了未设置的环境变量 {env:${appIdRef}}。`;
  const secretRef = unresolvedEnvRef(settings.clientSecret);
  if (secretRef !== undefined) return `密钥引用了未设置的环境变量 {env:${secretRef}}。`;
  if ((settings.appId ?? '').trim().length === 0) return '还没有填写 AppID。';
  if ((settings.clientSecret ?? '').trim().length === 0) return '还没有填写密钥。';
  return undefined;
}
