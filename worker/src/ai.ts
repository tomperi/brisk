import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './env';

export interface ChatRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  system?: string;
  model?: string;
  maxTokens?: number;
}

export interface ChatResponse {
  text: string;
  model: string;
  provider: 'anthropic' | 'openai';
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
const DEFAULT_OPENAI_MODEL = 'gpt-5.2';
const DEFAULT_MAX_TOKENS = 4096;
const MAX_MAX_TOKENS = 16_384;

const cappedMaxTokens = (requested: number | undefined): number =>
  Math.min(Math.max(1, requested ?? DEFAULT_MAX_TOKENS), MAX_MAX_TOKENS);

/**
 * The zero-API-key trick: keys live on the server as Worker secrets, so any
 * site can call `brisk.ai.chat(...)` straight from the browser. Provider is
 * picked by whichever key is configured (Anthropic wins when both are).
 */
export async function chat(env: Env, req: ChatRequest): Promise<ChatResponse> {
  if (env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: req.model ?? DEFAULT_ANTHROPIC_MODEL,
      max_tokens: cappedMaxTokens(req.maxTokens),
      system: req.system,
      messages: req.messages,
    });
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return { text, model: response.model, provider: 'anthropic' };
  }

  if (env.OPENAI_API_KEY) {
    const model = req.model ?? DEFAULT_OPENAI_MODEL;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: cappedMaxTokens(req.maxTokens),
        messages: [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          ...req.messages,
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const data = await res.json<{ choices: { message: { content: string } }[] }>();
    return { text: data.choices[0]?.message.content ?? '', model, provider: 'openai' };
  }

  throw new AiNotConfiguredError();
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super('No AI provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY on the worker.');
  }
}
