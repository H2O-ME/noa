/**
 * 本地文件的富媒体上传（官方四步：prepare → 分片 PUT → part_finish → 合并）。
 *
 * 从 `protocol.ts`（REST 客户端）拆出：那边回答「一个请求体怎么发出去并核对回执」，
 * 这里回答「一个本地文件怎么变成 file_info」——四步、带校验值与分片循环，是另一件事。
 *
 * 这是本地文件唯一的入口：URL 方式要求平台能自己下载到文件，工作区里的截图做不到。
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FetchLike } from './token.js';
import { hashOf, step, uploadParts } from './upload-parts.js';

/** 上传要用到的两件事，由 `QqApi` 提供（避免把整个客户端类型拖进来）。 */
export interface UploadPort {
  /** 带鉴权的 JSON 请求（prepare / part_finish / 合并三步都用它）。 */
  request(path: string, body: unknown): Promise<unknown>;
  fetchFn: FetchLike;
  /** 诊断留痕（回落重试等）；缺省静默。 */
  log?: (line: string) => void;
}

/**
 * 上传一个本地文件，返回发消息用的 `file_info`（单聊专用）。
 * @param port - 鉴权请求与 fetch 的接缝。
 * @param openid - 单聊对端 openid。
 * @param media - 文件类型（1 图 / 2 视频 / 3 语音 / 4 文件）与本地绝对路径。
 * @returns 限时有效的 `file_info`（过期重传）。
 */
export async function uploadLocalFile(
  port: UploadPort,
  openid: string,
  media: { fileType: 1 | 2 | 3 | 4; path: string },
): Promise<string> {
  const data = await readFile(media.path);
  const name = basename(media.path);
  const prepare = (fileType: 1 | 2 | 3 | 4): Promise<unknown> =>
    step('upload_prepare', () =>
      port.request(`/v2/users/${openid}/upload_prepare`, {
        file_type: fileType,
        file_size: String(data.length),
        file_name: name,
        md5: hashOf('md5', data),
        sha1: hashOf('sha1', data),
        md5_10m: hashOf('md5', data.subarray(0, 10_002_432)),
      }));
  let type = media.fileType;
  let prepared: { upload_id?: unknown; parts?: unknown } | undefined;
  try {
    prepared = (await prepare(type)) as { upload_id?: unknown; parts?: unknown } | undefined;
  } catch (err) {
    // 850019 是平台对「声明类型」的否决（扩展名像图片、内容却不是它能认的图片）。文件
    // 本身改不动，就按通用文件再报一次名：读者至少拿到一个可下载的卡片，而不是一句错误。
    if (type === 4) throw err;
    port.log?.(`qqbot: upload rejected as type ${type} (${name}), retrying as a plain file: ${String(err)}`);
    type = 4;
    prepared = (await prepare(type)) as { upload_id?: unknown; parts?: unknown } | undefined;
  }
  const uploadId = typeof prepared?.upload_id === 'string' ? prepared.upload_id : '';
  if (uploadId.length === 0) throw new Error('qqbot: local upload failed: response carried no upload_id');
  await uploadParts(port, openid, uploadId, data, prepared?.parts);
  const merged = await step('files(merge)', () => port.request(`/v2/users/${openid}/files`, {
    file_type: type,
    upload_id: uploadId,
    srv_send_msg: false,
  }));
  const info = typeof merged === 'object' && merged !== null ? (merged as { file_info?: unknown }).file_info : undefined;
  if (typeof info !== 'string' || info.length === 0) {
    throw new Error('qqbot: local upload failed: response carried no file_info');
  }
  return info;
}
