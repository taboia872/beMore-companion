import { LlmConfig, Message } from '../types';

export async function generateResponse(
  messages: Message[],
  config: LlmConfig,
): Promise<string> {
  if (config.provider === 'localhost') {
    return fetchNetwork(messages, config);
  }
  return fetchLocalModel(messages, config);
}

async function fetchNetwork(messages: Message[], config: LlmConfig): Promise<string> {
  if (!config.baseUrl) throw new Error('URL do servidor não configurada');

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey && {Authorization: `Bearer ${config.apiKey}`}),
    },
    body: JSON.stringify({
      model: config.model || 'local-model',
      messages: messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function fetchLocalModel(messages: Message[], config: LlmConfig): Promise<string> {
  // Integração com llama.rn 0.9.0 — implementado quando baixar modelo GGUF
  if (!config.localModelPath) throw new Error('Nenhum modelo local baixado');
  throw new Error('Local model ainda não implementado');
}
