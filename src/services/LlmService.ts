import { LlmConfig, Message } from '../types';

/**
 * Filtra mensagens marcadas como erro (isError) do contexto enviado ao LLM.
 * Mensagens de erro são feedback visual local — não devem virar prompt.
 */
function sanitizeContext(messages: Message[]): Message[] {
  return messages.filter(m => !m.isError);
}

export async function generateResponse(
  messages: Message[],
  config: LlmConfig,
): Promise<string> {
  const cleanMessages = sanitizeContext(messages);
  if (config.provider === 'localhost') {
    return fetchNetwork(cleanMessages, config);
  }
  return fetchLocalModel(cleanMessages, config);
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
  // Integração com llama.rn — implementado quando baixar modelo GGUF
  if (!config.localModelPath) throw new Error('Nenhum modelo local baixado');
  throw new Error('Local model ainda não implementado');
}
