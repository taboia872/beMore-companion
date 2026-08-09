/**
 * SttOnlineService — transcrição de áudio via API online (Groq, OpenAI, etc).
 *
 * Usa o endpoint OpenAI-compatível POST /audio/transcriptions com
 * multipart/form-data (file + model). Funciona com:
 *   - Groq: https://api.groq.com/openai/v1/audio/transcriptions
 *   - OpenAI: https://api.openai.com/v1/audio/transcriptions
 *   - Qualquer servidor que implemente o endpoint compatível
 *
 * No React Native, FormData com {uri, type, name} é processado nativamente
 * como multipart/form-data pelo fetch — não precisa de biblioteca extra.
 */

import {Platform} from 'react-native';

export interface SttOnlineParams {
  /** URL base do servidor (ex: https://api.groq.com/openai/v1) */
  baseUrl: string;
  /** API key (Bearer token) */
  apiKey: string;
  /** Nome do modelo (ex: whisper-large-v3, whisper-large-v3-turbo) */
  model: string;
  /** Caminho do arquivo .wav no device */
  filePath: string;
  /** Idioma opcional (ex: 'pt', 'en'). Se omitido, auto-detect. */
  language?: string;
}

export interface SttOnlineResult {
  text: string;
}

/**
 * Verifica se o STT online está disponível (qualquer plataforma com fetch).
 * No Android, o fetch com FormData+uri é suportado nativamente pelo RN.
 */
export function isSttOnlineAvailable(): boolean {
  return typeof fetch === 'function';
}

/**
 * Constrói a URL completa do endpoint de transcrição.
 * Aceita baseUrl com ou sem trailing slash.
 */
function buildTranscriptionUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  return `${clean}/audio/transcriptions`;
}

/**
 * Transcreve um arquivo de áudio via API online (Groq/OpenAI-compatível).
 *
 * @returns o texto transcrito, ou string vazia se nada foi reconhecido
 * @throws Error com mensagem amigável em PT-BR
 */
export async function transcribeAudioOnline(
  params: SttOnlineParams,
): Promise<string> {
  const {baseUrl, apiKey, model, filePath, language} = params;

  if (!baseUrl) {
    throw new Error('Servidor STT não configurado. Defina nas configurações.');
  }
  if (!model) {
    throw new Error('Modelo STT não selecionado. Escolha um modelo nas configurações.');
  }
  if (!filePath) {
    throw new Error('Nenhum arquivo de áudio para transcrever.');
  }

  const url = buildTranscriptionUrl(baseUrl);

  // FormData no React Native: {uri, name, type} → multipart nativo
  const formData = new FormData();
  formData.append('file', {
    uri: Platform.OS === 'android' ? `file://${filePath}` : filePath,
    type: 'audio/wav',
    name: 'recording.wav',
  } as any);
  formData.append('model', model);
  if (language) {
    formData.append('language', language);
  }
  // response_format: json (default) — retorna {"text": "..."}
  formData.append('response_format', 'json');

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  // NÃO setar Content-Type manualmente — o fetch define o boundary do
  // multipart automaticamente quando o body é FormData.

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.includes('Network request') || msg.includes('network')) {
      throw new Error('Sem internet. Verifique a conexão.');
    }
    throw new Error(`Falha de rede: ${msg}`);
  }

  if (!response.ok) {
    let errDetail = '';
    try {
      const errBody = await response.text();
      // Tenta extrator mensagem de erro do JSON
      try {
        const errJson = JSON.parse(errBody);
        errDetail = errJson?.error?.message ?? errJson?.message ?? errBody.slice(0, 200);
      } catch {
        errDetail = errBody.slice(0, 200);
      }
    } catch {
      // ignore
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('API Key inválida para STT. Verifique nas configurações.');
    }
    if (response.status === 404) {
      throw new Error(`Modelo STT "${model}" não encontrado neste servidor.`);
    }
    if (response.status === 429) {
      throw new Error('Muitas requisições. Aguarde um momento e tente novamente.');
    }
    if (response.status >= 500) {
      throw new Error(`Erro no servidor (${response.status}). Tente novamente.`);
    }
    throw new Error(`Erro ${response.status}: ${errDetail}`);
  }

  // Resposta: {"text": "transcrição..."}
  const data = await response.json();
  const text: string = data?.text ?? '';
  return text.trim();
}
