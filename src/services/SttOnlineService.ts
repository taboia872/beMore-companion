/**
 * SttOnlineService — transcrição de áudio via API online (Groq, OpenAI, etc).
 *
 * Usa o endpoint OpenAI-compatível POST /audio/transcriptions com
 * multipart/form-data (file + model).
 *
 * No React Native, FormData com {uri, type, name} é processado nativamente
 * como multipart/form-data pelo fetch. O caminho do arquivo precisa do
 * prefixo file:// em ambas as plataformas (Android e iOS).
 */

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

/**
 * Verifica se o STT online está disponível (qualquer plataforma com fetch).
 */
export function isSttOnlineAvailable(): boolean {
  return typeof fetch === 'function';
}

/**
 * Constrói a URL completa do endpoint de transcrição.
 */
function buildTranscriptionUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  return `${clean}/audio/transcriptions`;
}

/**
 * Transcreve um arquivo de áudio via API online (Groq/OpenAI-compatível).
 *
 * Usa FormData com {uri, type, name} — o React Native processa isso
 * nativamente como multipart/form-data no fetch. No Android, o uri deve
 * ser o path absoluto sem prefixo file:// quando já começa com /.
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

  // No Android, o FormData precisa do prefixo file:// para ler arquivos
  // locais. Sem o prefixo, o fetch lança "Network request failed" (parece
  // erro de internet, mas na verdade é erro de leitura do arquivo).
  // No iOS, o prefixo file:// também é necessário.
  const fileUri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;

  const formData = new FormData();
  formData.append('file', {
    uri: fileUri,
    type: 'audio/wav',
    name: 'recording.wav',
  } as any);
  formData.append('model', model);
  if (language) {
    formData.append('language', language);
  }
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
      throw new Error('Sem internet ou arquivo de áudio inválido. Verifique a conexão.');
    }
    throw new Error(`Falha de rede: ${msg}`);
  }

  if (!response.ok) {
    let errDetail = '';
    try {
      const errBody = await response.text();
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

  const data = await response.json();
  const text: string = data?.text ?? '';
  return text.trim();
}
