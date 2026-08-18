/**
 * ServerService — consolida toda a lógica de comunicação com servidores.
 *
 * Substitui as funções espalhadas em LlmService.ts (buildChatUrl,
 * getReasoningFormat, isLocalServer) e SettingsScreen.tsx (fetchModels,
 * buildModelsUrl) por versões baseadas em ServerEntry.
 *
 * Também adiciona suporte a Image Generation (endpoint diferente de chat).
 */

import {ServerEntry, ModelEntry} from '../types';

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

/**
 * Constrói a URL do endpoint /models para listar modelos disponíveis.
 */
export function buildModelsUrl(server: ServerEntry): {
  url: string;
  useHeader: boolean;
} {
  const clean = server.baseUrl.replace(/\/+$/, '');
  switch (server.format) {
    case 'gemini':
      return {url: `${clean}/models`, useHeader: true};
    // OpenRouter tem endpoint público mas com auth retorna pricing info
    // Demais formatos (openai, ollama, custom): /models padrão
    default:
      return {url: `${clean}/models`, useHeader: false};
  }
}

/**
 * Constrói a URL do endpoint /chat/completions.
 */
export function buildChatUrl(server: ServerEntry): string {
  const clean = server.baseUrl.replace(/\/+$/, '');
  if (server.format === 'gemini') {
    // Gemini tem endpoint OpenAI-compatível em /openai/chat/completions
    return `${clean}/openai/chat/completions`;
  }
  return `${clean}/chat/completions`;
}

/**
 * Constrói os headers de autenticação conforme o formato do servidor.
 *
 * Gemini: header x-goog-api-key (FIX de segurança — antes usava query param).
 * Demais: Bearer token (se houver API key).
 */
export function buildAuthHeaders(
  server: ServerEntry,
  apiKey: string,
): Record<string, string> {
  if (!apiKey) return {};
  if (server.format === 'gemini') {
    return {'x-goog-api-key': apiKey};
  }
  return {Authorization: `Bearer ${apiKey}`};
}

// ---------------------------------------------------------------------------
// Image Generation URL builders
// ---------------------------------------------------------------------------

/**
 * Constrói a URL do endpoint de geração de imagem.
 * Cada formato tem um endpoint diferente.
 */
export function buildImageGenUrl(server: ServerEntry): string {
  const clean = server.baseUrl.replace(/\/+$/, '');
  switch (server.format) {
    case 'gemini':
      // Gemini: POST /v1beta/models/<model>:generateContent
      // com responseModalities: ["IMAGE"] no generationConfig
      return `${clean}/models`; // chamador append /<model>:generateContent

    case 'pollinations':
      // Pollinations: GET https://image.pollinations.ai/prompt/<encoded_prompt>?params
      // A URL base já é o endpoint — só append o prompt encoded
      return clean;

    default: // openai, ollama, custom
      // OpenAI-compat: POST /v1/images/generations
      return `${clean}/images/generations`;
  }
}

/**
 * Constrói o payload para geração de imagem conforme o formato.
 */
export function buildImageGenPayload(
  server: ServerEntry,
  model: ModelEntry,
  prompt: string,
): Record<string, unknown> {
  switch (server.format) {
    case 'gemini':
      return {
        contents: [{parts: [{text: prompt}]}],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      };

    case 'pollinations':
      // Pollinations não tem POST — é GET com query params.
      // Payload é vazio; tudo vai na URL.
      return {};

    default: // openai, ollama, custom
      return {
        model: model.modelId,
        prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      };
  }
}

// ---------------------------------------------------------------------------
// Reasoning format
// ---------------------------------------------------------------------------

/**
 * Determina o valor de reasoning_format a enviar conforme o servidor.
 *
 * - llama.cpp / Ollama / LM Studio (local): NÃO envia (null).
 * - Groq / OpenRouter / NVIDIA (nuvem): 'parsed'.
 * - Gemini / HuggingFace / outros: NÃO envia (null).
 */
export function getReasoningFormat(server: ServerEntry): string | null {
  if (server.format === 'ollama' || isLocalServer(server.baseUrl)) return null;
  if (server.format === 'gemini') return null;
  const url = server.baseUrl.toLowerCase();
  if (
    url.includes('groq.com') ||
    url.includes('openrouter.ai') ||
    url.includes('nvidia.com')
  ) {
    return 'parsed';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detecta se a URL aponta para um servidor local (Ollama, LM Studio, llama.cpp)
 * rodando em localhost ou LAN.
 */
export function isLocalServer(baseUrl: string): boolean {
  if (!baseUrl) return true;
  const url = baseUrl.toLowerCase();
  return (
    url.includes('127.0.0.1') ||
    url.includes('localhost') ||
    url.includes('0.0.0.0') ||
    /^https?:\/\/192\.168\./.test(url) ||
    /^https?:\/\/10\./.test(url) ||
    /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./.test(url)
  );
}

/**
 * Valida uma URL de servidor.
 * - HTTP só permitido para servidores locais (localhost/LAN).
 * - HTTPS obrigatório para domínios externos.
 */
export function validateServerUrl(
  url: string,
): {valid: boolean; error?: string} {
  if (!url?.trim()) return {valid: false, error: 'URL vazia'};
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {valid: false, error: 'Protocolo deve ser http ou https'};
    }
    if (parsed.protocol === 'http:' && !isLocalAddress(parsed.hostname)) {
      return {
        valid: false,
        error: 'HTTP só permitido para servidores locais. Use HTTPS.',
      };
    }
    return {valid: true};
  } catch {
    return {valid: false, error: 'URL inválida'};
  }
}

function isLocalAddress(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)
  );
}

// ---------------------------------------------------------------------------
// Fetch models
// ---------------------------------------------------------------------------

/**
 * Faz fetch da lista de modelos disponíveis num servidor.
 * Retorna array de modelIds (strings).
 */
export async function fetchModels(
  server: ServerEntry,
  apiKey: string,
): Promise<string[]> {
  // FishAudio: não tem GET /models — retorna modelo fixo TTS
  if (server.format === 'fishaudio') {
    return ['s2.1-pro-free'];
  }

  const {url, useHeader} = buildModelsUrl(server);
  const headers: Record<string, string> = {};

  if (server.format === 'gemini' && apiKey) {
    headers['x-goog-api-key'] = apiKey;
  } else if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {method: 'GET', headers});
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const models = data?.data ?? data?.models ?? [];
  return models
    .map((m: any) => {
      const raw = m.id ?? m.name ?? '';
      if (typeof raw !== 'string') return '';
      return raw.replace(/^models\//, '');
    })
    .filter((s: string) => s.length > 0)
    .sort((a: string, b: string) =>
      a.localeCompare(b, undefined, {sensitivity: 'base'}),
    );
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface ServerPreset {
  name: string;
  url: string;
  icon: string;
  format: ServerEntry['format'];
  hasFreeModels: boolean;
  description: string;
}

export const SERVER_PRESETS: ServerPreset[] = [
  // --- Free tier generoso ---
  {
    name: 'Google AI Studio',
    url: 'https://generativelanguage.googleapis.com/v1beta',
    icon: 'auto-awesome',
    format: 'gemini',
    hasFreeModels: true,
    description: 'Gemini 2.0/2.5 Flash, Pro — free tier generoso',
  },
  {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1',
    icon: 'bolt',
    format: 'openai',
    hasFreeModels: true,
    description: 'LPU ultra-rápido. Llama, Mixtral, Whisper STT — free sem cartão',
  },
  {
    name: 'SambaNova',
    url: 'https://api.sambanova.ai/v1',
    icon: 'developer-board',
    format: 'openai',
    hasFreeModels: true,
    description: 'DeepSeek-V3.1, Llama — free tier OpenAI-compatível',
  },
  {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1',
    icon: 'route',
    format: 'openai',
    hasFreeModels: true,
    description: 'Agregador — 100s de modelos, vários com :free',
  },
  {
    name: 'AIHorde',
    url: 'https://oai.aihorde.net/v1',
    icon: 'groups',
    format: 'openai',
    hasFreeModels: true,
    description: 'Crowdsourced — tudo gratuito, modelos da comunidade',
  },
  {
    name: 'Ollama Cloud',
    url: 'https://ollama.com/v1',
    icon: 'cloud-queue',
    format: 'openai',
    hasFreeModels: true,
    description: 'gemma, gpt-oss, qwen3 — free tier cloud',
  },
  {
    name: 'HuggingFace',
    url: 'https://router.huggingface.co/v1',
    icon: 'hub',
    format: 'openai',
    hasFreeModels: true,
    description: 'Router HF — modelos open com free tier',
  },
  // --- Image Generation ---
  {
    name: 'Pollinations',
    url: 'https://image.pollinations.ai/prompt',
    icon: 'image',
    format: 'pollinations',
    hasFreeModels: true,
    description: 'Geração de imagem FREE — sem API key. Flux, GPT Image, etc',
  },
  // --- Local (sem API key) ---
  {
    name: 'Localhost',
    url: 'http://localhost:8080/v1',
    icon: 'dns',
    format: 'ollama',
    hasFreeModels: true,
    description: 'Servidor local — modelos GGUF na sua máquina',
  },
  // --- TTS-only ---
  {
    name: 'FishAudio',
    url: 'https://api.fish.audio/v1',
    icon: 'graphic-eq',
    format: 'fishaudio',
    hasFreeModels: true,
    description: 'TTS realista — 1000s de vozes da comunidade, modelo free s2.1-pro-free',
  },
];

export const CUSTOM_SERVER = '__custom__';
