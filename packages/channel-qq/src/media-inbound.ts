/**
 * 入站附件：分类，以及「图片 → 内核持久引用」这一步。
 *
 * 从 `types.ts` 拆出，因为它要碰 IO（下载字节、落盘）；`types.ts` 只解码平台负载，
 * 不该知道存储。分类规则照抄平台的语义，且有一条**正确性**细节值得单独说：
 *
 *   - `content_type === 'file'` 是**显式上传**（有人把一个 `.wav` 当文件发上来），
 *     **绝不**能路由到语音识别——那不是一条语音消息，把它转成文字是把文件读成别的东西。
 *
 * 图片走内核既有的图片管线：`admitImage` 嗅探类型（不信任 `content_type`）、内容寻址
 * 落盘、8MB 上限，返回 `ImageAttachmentRef` —— 与浏览器粘贴的图片是同一种引用，于是
 * 请求装配、日志、压缩都不需要为本通道加特例。
 */
import { admitImage, errMessage, type ImageAttachmentRef } from '@noa/core';
import type { QqAttachment } from './types.js';
/** 附件的三类：图片（发给模型看）、语音（转写成文字）、其它（只留一句说明）。 */
export type AttachmentKind = 'image' | 'voice' | 'other';

/** 语音扩展名兜底：平台没给 `content_type` 时按文件名判。 */
const VOICE_EXTENSIONS = ['.silk', '.amr', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.speex', '.flac'];

/**
 * 附件属于哪一类。
 *
 * 顺序即优先级，`file` 的例外在最后一步——见模块头：显式上传的音频是文件，不是语音。
 * @param att - one attachment.
 * @returns its kind.
 */
export function classifyAttachment(att: QqAttachment): AttachmentKind {
  const contentType = (att.content_type ?? '').trim().toLowerCase();
  if (contentType === 'voice' || contentType.startsWith('audio/')) return 'voice';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType === 'file') return 'other';
  const filename = (att.filename ?? '').trim().toLowerCase();
  if (filename.length > 0 && VOICE_EXTENSIONS.some((ext) => filename.endsWith(ext))) return 'voice';
  return 'other';
}

/** 一次入站里图片的解析结果：可用的引用，加上为什么没成的说明。 */
export interface ResolvedImages {
  readonly images: readonly ImageAttachmentRef[];
  /** 被拒的图片（过大/类型不认识/下载失败），一句话一条，供日志与告知对端。 */
  readonly failures: readonly string[];
}

/**
 * 下载并登记这一条消息里的图片。
 *
 * 逐张独立：一张失败不影响另一张（部分成功比整条丢弃有用）。`fetchMedia` 由通道注入
 * （它知道 QQ CDN 需要哪个鉴权头），所以这个模块不联网、不持有 token，可以单独测。
 * @param attachments - the message's attachments.
 * @param fetchMedia - the channel's authenticated media fetch.
 * @param homedir - the home the image store lives under (tests redirect it).
 * @returns the durable references plus the per-image failures.
 */
export async function resolveInboundImages(
  attachments: readonly QqAttachment[],
  fetchMedia: (url: string) => Promise<Uint8Array>,
  homedir?: string,
): Promise<ResolvedImages> {
  const images: ImageAttachmentRef[] = [];
  const failures: string[] = [];
  for (const att of attachments) {
    if (classifyAttachment(att) !== 'image' || att.url === undefined) continue;
    let bytes: Uint8Array;
    try {
      bytes = await fetchMedia(att.url);
    } catch (err) {
      failures.push(`下载失败（${errMessage(err)}）`);
      continue;
    }
    const admitted = await admitImage(bytes, att.filename, homedir);
    if (!admitted.ok) {
      failures.push(describeRefusal(admitted.reason));
      continue;
    }
    images.push(admitted.ref);
  }
  return { images, failures };
}

/** `admitImage` 的拒绝码 → 一句人话。 */
function describeRefusal(reason: 'empty' | 'too-large' | 'unsupported-type'): string {
  if (reason === 'too-large') return '图片超过 8MB 上限';
  if (reason === 'unsupported-type') return '不是可识别的图片格式（PNG/JPEG/WebP/GIF）';
  return '图片是空的';
}

/**
 * 把一条语音附件变成一段文本块（`[语音] …`）。
 *
 * 三级优先，顺序即成本：
 *
 *  1. **平台自带的 `asr_refer_text`** —— 免费、不用下载、是平台自己对这段音频的读法；
 *  2. **配置了转写时**：下载音频（优先 `voice_wav_url`，那是平台预转好的 WAV，于是
 *     不需要 SILK 解码）交给 `transcribe`；
 *  3. 都没有 → 一句如实的降级说明。
 *
 * `content_type === 'file'` 的附件在 `classifyAttachment` 里已经归为 `other`，永远走不到
 * 这里 —— 上传的 `.wav` 是文件，不是语音消息。
 */
export interface ResolvedVoice {
  /** 每个语音附件折成的一行文本（按平台顺序）。 */
  readonly blocks: readonly string[];
}

export async function resolveInboundVoice(
  attachments: readonly QqAttachment[],
  fetchMedia: (url: string) => Promise<Uint8Array>,
  transcribe: ((bytes: Uint8Array, hints: { mediaType?: string; filename?: string }) => Promise<string>) | undefined,
): Promise<ResolvedVoice> {
  const blocks: string[] = [];
  for (const att of attachments) {
    if (classifyAttachment(att) !== 'voice') continue;
    const asr = (att.asr_refer_text ?? '').trim();
    if (asr.length > 0) {
      blocks.push(`[语音] ${asr}`);
      continue;
    }
    if (transcribe === undefined) {
      blocks.push('（收到一条语音，未配置转写）');
      continue;
    }
    const source = voiceSource(att);
    if (source === undefined) {
      blocks.push('（收到一条语音，但平台没有给出可下载的地址）');
      continue;
    }
    try {
      const bytes = await fetchMedia(source);
      const transcript = (await transcribe(bytes, {
        ...(att.content_type !== undefined ? { mediaType: att.content_type } : {}),
        ...(att.filename !== undefined ? { filename: att.filename } : {}),
      })).trim();
      blocks.push(transcript.length > 0 ? `[语音] ${transcript}` : '（语音里没有识别出文字）');
    } catch (err) {
      blocks.push(`（语音转写失败：${errMessage(err)}）`);
    }
  }
  return { blocks };
}

/**
 * 语音该从哪个地址下载。
 *
 * `voice_wav_url` 优先：那是平台预转好的 WAV，于是本通道**不需要** SILK 解码（这个
 * 产品零依赖，不解 SILK 是刻意的）。平台给的是协议相对地址（`//host/…`），补上 https。
 */
function voiceSource(att: QqAttachment): string | undefined {
  const wav = att.voice_wav_url?.trim();
  if (wav !== undefined && wav.length > 0) return wav.startsWith('//') ? `https:${wav}` : wav;
  return att.url;
}
