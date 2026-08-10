/**
 * Heurísticas para detectar capacidades de modelos (vision, STT, TTS, any-to-any)
 * a partir do id do modelo.
 *
 * A API OpenAI-compatível não expõe capabilities nos /models — só o id.
 * Por isso, a detecção é por padrões de nome conhecidos. Falso-positivos
 * aceitáveis (melhor pecar por otimismo — o usuário descobre rapidamente se
 * o modelo não suporta: a API retorna erro).
 */

export type ModelCapability = 'vision' | 'stt' | 'tts' | 'anyToAny';

export interface ModelCapabilities {
  vision: boolean;
  stt: boolean;
  tts: boolean;
  anyToAny: boolean;
}

// ---------------------------------------------------------------------------
// Vision — mesma lista que modelVision.ts (mantida aqui para centralizar)
// ---------------------------------------------------------------------------
const VISION_PATTERNS: string[] = [
  'gpt-4o', 'gpt-4-vision', 'gpt-4-turbo',
  'gemini-1.5', 'gemini-2.0', 'gemini-2.5', 'gemini-pro-vision', 'gemini-experimental',
  'llama-3.2-11b', 'llama-3.2-90b', 'llama-3.2-vision', 'llama-4',
  'qwen2-vl', 'qwen2.5-vl', 'qwen2vl', 'qwen-vl', 'qvq', 'qwen3.6',
  'internvl', 'intern-vl', 'deepseek-vl',
  'llava', 'moondream', 'bunny-vision', 'smolvlm', 'smolvlm2', 'smol-vlm',
  'pixtral', 'cogvlm', 'cogagent',
  'idefics2', 'idefics3', 'idefics-2', 'idefics-3',
  'phi-3.5-vision', 'phi-3-vision', 'phi-4-vision', 'phi4-vision',
  'molmo', '-vision', '-vl-',
  'openchat-vision', 'kosmos', 'florence',
  'aya-vision', 'aya-23-vision',
  'glm-4v', 'glm-4.1v', 'glm4v',
  'skywork-vision', 'olmoe-vision', '-vision', 'neva', 'gpt-5',
];

// ---------------------------------------------------------------------------
// STT (Speech-to-Text / transcription) — modelos de áudio para texto
// ---------------------------------------------------------------------------
const STT_PATTERNS: string[] = [
  'whisper', // whisper-large-v3, whisper-large-v3-turbo, whisper-1, etc
  'distil-whisper', // distil-whisper-large-v3-en (Groq)
  'canary', // nvidia/canary-1b (STT+translation)
  'parakeet', // nvidia/parakeet-ctcmodels (STT)
  'seamless', // meta/seamless-m4t (STT + translation)
  'speech-to-text',
  'asr',
  'transcribe',
  'voxtral', // Mistral Voxtral (STT + understanding)
];

// ---------------------------------------------------------------------------
// TTS (Text-to-Speech / synthesis) — modelos de texto para áudio
// ---------------------------------------------------------------------------
const TTS_PATTERNS: string[] = [
  'tts', // openai/tts-1, openai/tts-1-hd, eleven-turbo, etc
  'speech-synthesis',
  'bark', // suno/bark (TTS)
  'xtts', // coqui/xtts
  'polly',
  'speech-t5',
  'auro', // auro-0.1 (TTS) — festiv
  'styletts',
  'voice',
  'soniox',
  'orca', // elevenlabs/orca
  'lacqo',
  'kokoro', // kokoro-tts
  'fish-speech',
  'f5-tts',
  'e2-tts',
  'speech',
  // Gemini TTS (também any-to-any) — modelos de áudio que fazem synthesis
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
  'gemini-flash-latest-tts',
  'gemini-2.5-flash-tts',
  'gemini-2.5-pro-tts',
];

// ---------------------------------------------------------------------------
// Any-to-Any — modelos multimodais que aceitam E produzem áudio/texto/imagem
// ---------------------------------------------------------------------------
const ANY_TO_ANY_PATTERNS: string[] = [
  'gpt-4o-audio', // openai/gpt-4o-audio-preview (audio in/out)
  'gpt-4o-mini-audio',
  'gemini-2.5-flash-audio',
  'gemini-2.5-pro-audio',
  'seamless-m4t', // meta seamless (STT + TTS + translation)
  'qwen2-audio', // qwen2-audio-instruct
  'qwen-audio',
  'voxtral', // Mistral Voxtral
  'kyutai', // kyutai moshi (full duplex audio)
  'moshi',
  'speech-guard',
];

function matchesAny(id: string, patterns: string[]): boolean {
  const lower = id.toLowerCase();
  return patterns.some(p => lower.includes(p));
}

/**
 * Verifica se um modelo (pelo id) provavelmente suporta visão (image input).
 * Mantida por compatibilidade — delega para getModelCapabilities.
 */
export function isVisionModel(id: string): boolean {
  if (!id) return false;
  return matchesAny(id, VISION_PATTERNS);
}

/**
 * Verifica se um modelo é de STT (speech-to-text / transcription).
 */
export function isSttModel(id: string): boolean {
  if (!id) return false;
  return matchesAny(id, STT_PATTERNS);
}

/**
 * Verifica se um modelo é de TTS (text-to-speech / synthesis).
 */
export function isTtsModel(id: string): boolean {
  if (!id) return false;
  // "tts" é substring de outros patterns? Sim, mas os patterns TTS
  // são específicos o suficiente. Removemos matches onde "tts" aparece
  // em contexto não-TTS (nenhum caso conhecido até agora).
  return matchesAny(id, TTS_PATTERNS);
}

/**
 * Verifica se um modelo é any-to-any (multi-modal I/O: audio+text+image).
 */
export function isAnyToAnyModel(id: string): boolean {
  if (!id) return false;
  return matchesAny(id, ANY_TO_ANY_PATTERNS);
}

/**
 * Retorna todas as capacidades detectadas de um modelo.
 */
export function getModelCapabilities(id: string): ModelCapabilities {
  if (!id) return {vision: false, stt: false, tts: false, anyToAny: false};
  return {
    vision: isVisionModel(id),
    stt: isSttModel(id),
    tts: isTtsModel(id),
    anyToAny: isAnyToAnyModel(id),
  };
}

/**
 * Retorna a lista de badges a exibir para um modelo.
 * Ordenação: anyToAny > STT > TTS > VISÃO (prioridade visual).
 */
export function getModelBadges(id: string): Array<{
  type: ModelCapability;
  label: string;
}> {
  const caps = getModelCapabilities(id);
  const badges: Array<{type: ModelCapability; label: string}> = [];
  if (caps.anyToAny) badges.push({type: 'anyToAny', label: 'ANY→ANY'});
  if (caps.stt) badges.push({type: 'stt', label: 'STT'});
  if (caps.tts) badges.push({type: 'tts', label: 'TTS'});
  if (caps.vision) badges.push({type: 'vision', label: 'VISÃO'});
  return badges;
}
