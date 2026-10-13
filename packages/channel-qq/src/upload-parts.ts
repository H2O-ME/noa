/**
 * 分片上传的中间两步：逐片 PUT 到预签名 URL，再逐片确认。
 *
 * 从 `upload.ts` 拆出：那边回答「一个文件怎么走完四步」，这里回答「一堆分片怎么
 * 逐片落地」——循环与校验值住在这里，编排住在那一边。
 */
import { createHash } from 'node:crypto';
import { withDeadline } from './deadline.js';
import type { UploadPort } from './upload.js';

/** 校验值的唯一算法入口：整文件 md5/sha1、前 10MB 的 md5、每片 md5。 */
export function hashOf(algorithm: 'md5' | 'sha1', data: Uint8Array): string {
  return createHash(algorithm).update(data).digest('hex');
}

/** 给一步的失败加上名字：不然「send failed (400)」不知道是哪一步、拿什么发的。 */
export async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new Error(`qqbot: local upload ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 逐片上传并确认。
 *
 * 每片 PUT 到它自己的预签名 URL（签名在 URL 里，所以不带鉴权头，body 是裸二进制），
 * 成功后立刻 `upload_part_finish` 通知服务端该片完成——顺序不能反：平台按确认过的
 * 分片做合并。
 *
 * 已知限制（2026-10-06 真机实测，非本地推断）：**多分片**（文件 > 10MiB，平台把
 * block_size 定为 10MiB）在最后一片的 `upload_part_finish` 上必失败——40093001
 * 「文件上传失败，请重试」；重试、换名义 block_size、补齐末片 md5、跳过末片确认全都
 * 一样失败，随后 merge 报 40093006。单片（≤10MiB）完整走通。所以这里不另造兜底：
 * 让平台的错误如实上抛，调用方（`outbox`）回落成纯文本，路径还在。
 * @param port - 鉴权请求与 fetch 的接缝。
 * @param openid - 单聊对端 openid。
 * @param uploadId - `upload_prepare` 返回的上传任务 id。
 * @param data - 整个文件的字节。
 * @param rawParts - `upload_prepare` 返回的分片列表（未校验的原始 JSON）。
 */
export async function uploadParts(
  port: UploadPort,
  openid: string,
  uploadId: string,
  data: Uint8Array,
  rawParts: unknown,
): Promise<void> {
  const parts = Array.isArray(rawParts) ? rawParts : [];
  for (const raw of parts) {
    const part = raw as { index?: unknown; presigned_url?: unknown; block_size?: unknown };
    const index = typeof part.index === 'number' ? part.index : -1;
    const url = typeof part.presigned_url === 'string' ? part.presigned_url : '';
    const size = Number(part.block_size ?? 0);
    if (index < 1 || url.length === 0 || !Number.isFinite(size) || size <= 0) {
      throw new Error('qqbot: local upload failed: malformed part from upload_prepare');
    }
    // `index` 是 **1 起算**的：平台对单分片文件也返回 index=1，预签名 URL 里的
    // `part_1` 同此。按 `index * size` 取片会让第一片落在文件末尾之外——空片照样
    // PUT 成功、part_finish 也照样 200，直到合并那一步才以「850019 富媒体文件格式
    // 不支持」报出来，看着像格式问题，其实是传上去的文件是空的。
    const slice = data.subarray((index - 1) * size, Math.min(index * size, data.length));
    const res = await withDeadline(async (signal) => {
      return await port.fetchFn(url, { method: 'PUT', body: slice, signal });
    }, 'upload part');
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`qqbot: upload part ${index} failed (${res.status})`);
    }
    await step('upload_part_finish', () =>
      port.request(`/v2/users/${openid}/upload_part_finish`, {
        upload_id: uploadId,
        part_index: index,
        block_size: String(size),
        md5: hashOf('md5', slice),
      }),
    );
  }
}
