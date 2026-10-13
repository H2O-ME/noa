/**
 * The wire format: internal IR (`AgentMessage` / `ToolDefinition`) → the
 * OpenAI-compatible JSON an endpoint expects, and the chunks it sends back →
 * `StreamEvent`s.
 *
 * This is the whole of `ai`'s knowledge of the vendor's shapes, and it is
 * deliberately pure: no fetch, no timers, no state. That is what lets the
 * client stay provider-agnostic and lets these mappings be reasoned about (and
 * tested) without a network.
 */
import type { AgentMessage, StreamEvent, ToolDefinition, Usage } from '@noa/core';

export interface ProviderToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ProviderChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      /** Chain-of-thought stream (DeepSeek reasoner style). */
      reasoning_content?: string;
      tool_calls?: ProviderToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
  error?: { message?: string };
}

export function toProviderMessage(msg: AgentMessage): Record<string, unknown> {
  switch (msg.role) {
    case 'system':
      return { role: msg.role, content: msg.content };
    case 'user':
      return { role: 'user', content: userContent(msg.content, msg.resolvedImages) };
    case 'assistant': {
      const out: Record<string, unknown> = { role: 'assistant', content: msg.content };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        out['tool_calls'] = msg.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: call.rawArgs.length > 0 ? call.rawArgs : '{}',
          },
        }));
      }
      return out;
    }
    case 'tool':
      return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
  }
}

/**
 * One user turn's content: a plain string when there are no resolved images,
 * else the OpenAI content-part array.
 *
 * The string form is kept for the no-image case on purpose — it is the shape
 * every gateway accepts, including ones that predate multimodal requests, so a
 * conversation without images stays byte-identical to what it was before this
 * feature existed.
 *
 * The image form is the documented OpenAI `image_url` part carrying a `data:`
 * URI. It was verified against a real gateway rather than assumed: a
 * 64x64 solid-blue PNG sent as `data:image/png;base64,…` came back described as
 * blue, and the response's `usage.prompt_tokens_details.image_tokens` was
 * non-zero. A bare-base64 `url` and a bare `image_url` string were also
 * accepted there, but the `data:` URI is the one the specification requires, so
 * it is the one used.
 *
 * Only `resolvedImages` is read. A message still holding unresolved references
 * (the log form) renders as text: resolution belongs to core's request
 * assembly, which is the layer that can consult the model in force and read the
 * stored bytes, and a provider that could not resolve them must not invent
 * bytes of its own.
 * @param text - the turn's text.
 * @param images - request-resolved images, already base64.
 * @returns the provider-facing `content` value.
 */
export function userContent(
  text: string,
  images: readonly { mediaType: string; data: string }[] | undefined,
): unknown {
  if (images === undefined || images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    })),
  ];
}

export function toProviderTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** Chain-of-thought text of one delta, under any of the three field names
 * gateways use — or undefined when this chunk carries none. */
function reasoningText(raw: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['reasoning_content', 'reasoning', 'thought']) {
    const value = raw?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Tool-call deltas of one chunk. Empty/null members count as absent (some
 * gateways repeat entries with empty id/name and null arguments), and `index`
 * is coerced to 0 unless it is a non-negative integer — the accumulator keys
 * by it, so a NaN-shaped index must not open a second accumulator. */
function toolCallDeltas(deltas: ProviderToolCallDelta[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const tc of deltas) {
    const id = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : undefined;
    const name =
      typeof tc.function?.name === 'string' && tc.function.name.length > 0 ? tc.function.name : undefined;
    const argsDelta =
      typeof tc.function?.arguments === 'string' && tc.function.arguments.length > 0
        ? tc.function.arguments
        : undefined;
    if (id === undefined && name === undefined && argsDelta === undefined) continue;
    const index = typeof tc.index === 'number' && Number.isInteger(tc.index) && tc.index >= 0 ? tc.index : 0;
    out.push({
      type: 'tool_call_delta',
      index,
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(argsDelta !== undefined ? { argsDelta } : {}),
    });
  }
  return out;
}

/** The chunk's usage, normalised across the two cache-reporting shapes. */
function usageFrom(raw: NonNullable<ProviderChunk['usage']>): Usage {
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0,
  };
}

/** One provider chunk → the events it carries, in wire order. */
export function* translateChunk(chunk: ProviderChunk): Generator<StreamEvent> {
  const choice = chunk.choices?.[0];
  if (choice) {
    const delta = choice.delta;
    const reasoning = reasoningText(delta as Record<string, unknown> | undefined);
    if (reasoning !== undefined) yield { type: 'reasoning_delta', text: reasoning };
    if (delta?.content) yield { type: 'text_delta', text: delta.content };
    if (delta?.tool_calls) yield* toolCallDeltas(delta.tool_calls);
    if (choice.finish_reason) yield { type: 'finish', finishReason: choice.finish_reason };
  }
  if (chunk.usage) yield { type: 'usage', usage: usageFrom(chunk.usage) };
}
