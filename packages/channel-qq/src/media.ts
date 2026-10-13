/**
 * 什么时候「一段内容本身就是一张图/一段视频」——两条入口的共用规则。
 *
 * 公网 URL 与本地文件是两种上传协议（URL 转存 vs 分片上传），但**认不认得出来**是
 * 同一个问题，所以规则住在一起：`bareImageUrl` 认公网 URL，`localMediaInText` 认
 * 本地路径（由调用方注入存在性检查——本模块是纯函数层，不做 IO）。
 *
 * 从 `rich-send.ts` 拆出：那边是官方 payload 的构造，这里是「什么该走媒体通道」的
 * 判断，两者的变化原因不同。
 */

/** 按扩展名认媒体类型（图片 / 视频 / 语音）；其余扩展名不参与自动发送。 */
const MEDIA_BY_EXT: readonly { pattern: RegExp; fileType: 1 | 2 | 3 }[] = [
  { pattern: /\.(?:png|jpe?g|gif|webp|bmp)$/iu, fileType: 1 },
  { pattern: /\.mp4$/iu, fileType: 2 },
  { pattern: /\.(?:silk|mp3|wav|ogg)$/iu, fileType: 3 },
];

/** 绝对路径样子的媒体 token（Windows 盘符或 POSIX 根，到扩展名为止）。 */
const MEDIA_PATH_TOKEN = /(?:[A-Za-z]:[\\/]|\/)[^\s`"'<>|*?]+?\.(?:png|jpe?g|gif|webp|bmp|mp4|silk|mp3|wav|ogg)/giu;

/** 一行就是一张图片（协议 http(s)、扩展名可识别）：发图片本体而不是一个链接。 */
export function bareImageUrl(content: string): { fileType: 1 | 2 | 3 | 4; url: string } | undefined {
  const trimmed = content.trim();
  const match = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp)$/iu.exec(trimmed);
  return match === null ? undefined : { fileType: 1, url: trimmed };
}

/** 一个路径的媒体类型：图片/视频/语音按扩展名，其余一律按文件（4）发。 */
export function mediaTypeOf(filePath: string): 1 | 2 | 3 | 4 {
  return MEDIA_BY_EXT.find((entry) => entry.pattern.test(filePath))?.fileType ?? 4;
}

/**
 * 回复里出现的**真实存在的本地媒体路径**：发文件本体，而不是只发一串路径。
 *
 * agent 说「截图在 /tmp/a.png」时，读者要的是那张图，不是那个路径；路径夹在解释文字
 * 里也算。`exists` 由调用方注入。
 */
export function localMediaInText(
  content: string,
  exists: (candidate: string) => boolean,
): { fileType: 1 | 2 | 3 | 4; path: string } | undefined {
  for (const match of content.matchAll(MEDIA_PATH_TOKEN)) {
    const candidate = match[0];
    const ext = MEDIA_BY_EXT.find((entry) => entry.pattern.test(candidate));
    if (ext === undefined) continue;
    if (exists(candidate)) return { fileType: ext.fileType, path: candidate };
  }
  return undefined;
}
