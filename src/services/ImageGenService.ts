/**
 * ImageGenService — geração de imagem via API.
 *
 * Suporta 3 formatos de servidor:
 * - 'openai' (OpenAI-compat): POST /v1/images/generations → b64_json
 * - 'gemini': POST /v1beta/models/<model>:generateContent → inlineData.base64
 * - 'pollinations': GET /prompt/<encoded>?params → PNG direto no body
 *
 * Retorna um objeto com a imagem em base64 (pronto para exibir em <Image>).
 */

import {ServerEntry, ModelEntry} from '../types';
import {buildImageGenUrl, buildImageGenPayload, buildAuthHeaders} from './ServerService';

export interface ImageGenResult {
  /** Imagem em base64 (sem o prefixo data:image/...) pronta para usar em <Image source={{uri: `data:image/png;base64,${base64}`}}> */
  base64: string;
  /** MIME type retornado pela API */
  mimeType: string;
}

/**
 * Gera uma imagem a partir de um prompt de texto.
 *
 * @param server   Servidor cadastrado (determina formato/endpoint)
 * @param model    Modelo de image generation (determina o modelId)
 * @param apiKey   API key (obtida via KeyRotation.getKeyForRequest)
 * @param prompt   Texto descritivo da imagem desejada
 * @returns ImageGenResult com a imagem em base64
 */
export async function generateImage(
  server: ServerEntry,
  model: ModelEntry,
  apiKey: string,
  prompt: string,
): Promise<ImageGenResult> {
  switch (server.format) {
    case 'pollinations':
      return generatePollinations(server, model, prompt);
    case 'gemini':
      return generateGemini(server, model, apiKey, prompt);
    default:
      return generateOpenAI(server, model, apiKey, prompt);
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compat (Groq, OpenRouter, etc)
// ---------------------------------------------------------------------------

async function generateOpenAI(
  server: ServerEntry,
  model: ModelEntry,
  apiKey: string,
  prompt: string,
): Promise<ImageGenResult> {
  const url = buildImageGenUrl(server);
  const payload = buildImageGenPayload(server, model, prompt);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildAuthHeaders(server, apiKey),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Image gen failed: HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();

  // OpenAI retorna { data: [{ b64_json: "..." }] } ou { data: [{ url: "..." }] }
  const image = data?.data?.[0];
  if (image?.b64_json) {
    return {base64: image.b64_json, mimeType: 'image/png'};
  }
  if (image?.url) {
    // Se a API retorna URL em vez de base64, fazemos fetch da imagem
    const imgRes = await fetch(image.url);
    const blob = await imgRes.blob();
    const base64 = await blobToBase64(blob);
    return {base64, mimeType: blob.type || 'image/png'};
  }

  throw new Error('Image gen: resposta sem b64_json ou url');
}

// ---------------------------------------------------------------------------
// Gemini (generateContent com responseModalities: IMAGE)
// ---------------------------------------------------------------------------

async function generateGemini(
  server: ServerEntry,
  model: ModelEntry,
  apiKey: string,
  prompt: string,
): Promise<ImageGenResult> {
  const clean = server.baseUrl.replace(/\/+$/, '');
  // Gemini image gen: POST /v1beta/models/<modelId>:generateContent
  const url = `${clean}/models/${model.modelId}:generateContent`;
  const payload = buildImageGenPayload(server, model, prompt);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey, // Gemini usa header, não Bearer
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini image gen failed: HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();

  // Gemini inlineData.base64 no candidates[0].content.parts
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return {
        base64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || 'image/png',
      };
    }
  }

  throw new Error('Gemini image gen: resposta sem inlineData');
}

// ---------------------------------------------------------------------------
// Pollinations (GET, sem API key, sem POST)
// ---------------------------------------------------------------------------

async function generatePollinations(
  server: ServerEntry,
  model: ModelEntry,
  prompt: string,
): Promise<ImageGenResult> {
  // Pollinations: GET https://image.pollinations.ai/prompt/<encoded_prompt>?model=<model>&width=1024&height=1024&nologo=true
  const encoded = encodeURIComponent(prompt);
  const params = new URLSearchParams({
    model: model.modelId || 'flux',
    width: '1024',
    height: '1024',
    nologo: 'true',
  });
  const url = `${server.baseUrl}/${encoded}?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Pollinations failed: HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  // Pollinations retorna a imagem PNG diretamente no body (não JSON)
  const blob = await res.blob();
  const base64 = await blobToBase64(blob);
  return {base64, mimeType: blob.type || 'image/png'};
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

/**
 * Converte um Blob para base64 (usando FileReader alternativa).
 * No React Native, fetch retorna blob que pode ser convertido.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Remove o prefixo data:image/png;base64,
      const base64 = result.split(',')[1] ?? result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
