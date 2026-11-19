import { z } from 'zod';
import type { LlmConfig } from '../models/setting';
import type { ChatMessage } from './prompt';

/**
 * OpenAI 兼容接口客户端（/chat/completions）。
 * 网络实现由调用方注入，模块本身不直接依赖全局网络 API。
 */

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const ChatResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});

export interface ChatOptions {
  /** 默认 true：声明 response_format=json_object；400 时自动降级重试一次不带该字段 */
  jsonMode?: boolean;
  maxTokens?: number;
}

function statusError(status: number, body: string): Error {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 120);
  if (status === 401 || status === 403) return new Error('aiErr.http401');
  if (status === 404) return new Error('aiErr.http404');
  if (status === 429) return new Error('aiErr.http429');
  // 文案 key 无法携带参数（localizeError 无插值），HTTP 状态与响应片段放进 cause 供排查
  return new Error('aiErr.httpFailed', {
    cause: `HTTP ${status}${snippet ? `: ${snippet}` : ''}`,
  });
}

/** 调用 chat/completions，返回 message.content 文本 */
export async function chatCompletions(
  config: LlmConfig,
  messages: ChatMessage[],
  options: ChatOptions = {},
  fetchImpl?: FetchLike,
): Promise<string> {
  const doFetch: FetchLike =
    fetchImpl ??
    (globalThis as unknown as { fetch: FetchLike }).fetch?.bind(globalThis);
  if (!doFetch) throw new Error('aiErr.fetchUnsupported');

  const url = `${config.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const buildBody = (jsonMode: boolean) =>
    JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.3,
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiToken}`,
  };

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers,
      body: buildBody(options.jsonMode !== false),
    });
    // 部分兼容网关不支持 response_format：400 时降级重试一次
    if (!res.ok && res.status === 400 && options.jsonMode !== false) {
      res = await doFetch(url, { method: 'POST', headers, body: buildBody(false) });
    }
  } catch {
    throw new Error('aiErr.network');
  }

  if (!res.ok) throw statusError(res.status, await res.text().catch(() => ''));

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('aiErr.badResponse');
  }
  const parsed = ChatResponseSchema.safeParse(json);
  if (!parsed.success) throw new Error('aiErr.missingChoices');
  return parsed.data.choices[0]?.message.content ?? '';
}
