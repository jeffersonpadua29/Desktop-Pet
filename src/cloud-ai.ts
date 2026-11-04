export const cloudModels = {
  gemini: 'gemini-3.8-flash',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-5-5',
} as const;

export type CloudProvider = keyof typeof cloudModels;
export type CloudConfig = { provider: CloudProvider; model: string; key: string };
export type AiSettingsView = {
  enabled: boolean; provider: CloudProvider; model: string; hasKey: boolean;
  defaults: typeof cloudModels;
};
export type AiRun = { engine: CloudProvider | 'qwen' | 'windows'; fallback?: CloudProvider };

export type ModelTool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type ModelMessage = {
  content?: string;
  tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[];
};

export function isCloudProvider(value: unknown): value is CloudProvider {
  return typeof value === 'string' && Object.hasOwn(cloudModels, value);
}

export function isCloudModel(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(value);
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') value = JSON.parse(value);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function chatCloud(config: CloudConfig, system: string, prompt: string, tools: ModelTool[] = [], maxTokens = 1536): Promise<ModelMessage> {
  const anthropic = config.provider === 'anthropic';
  const gemini = config.provider === 'gemini';
  const url = anthropic ? 'https://api.anthropic.com/v1/messages'
    : gemini ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';
  const user = { role: 'user', content: prompt };
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: {
      'Content-Type': 'application/json',
      ...(anthropic ? { 'x-api-key': config.key, 'anthropic-version': '2023-06-01' }
        : { Authorization: 'Bearer ' + config.key }),
    },
    body: JSON.stringify(anthropic ? {
      model: config.model, max_tokens: maxTokens, system, messages: [user],
      ...(tools.length ? { tools: tools.map(({ function: tool }) => ({
        name: tool.name, description: tool.description, input_schema: tool.parameters,
      })) } : {}),
    } : {
      model: config.model, [gemini ? 'max_tokens' : 'max_completion_tokens']: maxTokens,
      messages: [{ role: 'system', content: system }, user],
      ...(tools.length ? { tools } : {}),
    }),
  });
  if (!response.ok) throw new Error('Provider returned HTTP ' + response.status + '.');
  if (anthropic) {
    const data = await response.json() as {
      stop_reason?: string;
      content?: { type: string; text?: string; name?: string; input?: unknown }[];
    };
    if (data.stop_reason === 'max_tokens' || !Array.isArray(data.content)) throw new Error('Incomplete provider response.');
    return {
      content: data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      tool_calls: data.content.filter(block => block.type === 'tool_use').map(block => ({
        function: { name: block.name, arguments: parseArguments(block.input) },
      })),
    };
  }
  const data = await response.json() as { choices?: { finish_reason?: string; message?: {
    content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
  } }[] };
  const choice = data.choices?.[0];
  if (!choice?.message || choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') throw new Error('Incomplete provider response.');
  return {
    content: choice.message.content,
    tool_calls: choice.message.tool_calls?.map(call => ({
      function: { name: call.function?.name, arguments: parseArguments(call.function?.arguments) },
    })),
  };
}
