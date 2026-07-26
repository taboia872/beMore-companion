import {Platform} from 'react-native';

/**
 * SttService — wrap do whisper.rn para transcrição on-device.
 *
 * whisper.rn (mybigday, v0.7.2) roda OpenAI Whisper em whisper.cpp.
 * Fluxo: initWhisper({filePath}) carrega modelo GGUF -> transcribe(wavPath)
 * devolve texto reconhecido.
 *
 * Carregamento é lazy: só chama initWhisper quando o usuário realmente
 * for transcrever pela primeira vez. Context fica em ref no useWhisper.
 */

// Import dinâmico para não quebrar typecheck em ambientes sem whisper.rn instalado.
// Module é resolvido em runtime no device.
let WhisperModule: any = null;
try {
  // whisper.rn exporta initWhisper como named export
  WhisperModule = require('whisper.rn');
} catch (e) {
  if (__DEV__) {
    console.warn('[SttService] whisper.rn não instalado — STT indisponível.');
  }
}

export interface TranscribeOptions {
  language?: string;  // 'pt', 'en', 'auto' (default)
  flash_attn?: boolean;
}

export interface TranscribeResult {
  result: string;     // texto reconhecido
  segments?: Array<{text: string; t0: number; t1: number}>;
}

export interface SttContext {
  transcribe: (filePath: string, options?: TranscribeOptions) => Promise<TranscribeResult>;
  release: () => void;
}

let activeContext: SttContext | null = null;
let activeModelPath: string | null = null;

export function isSttAvailable(): boolean {
  return WhisperModule !== null && WhisperModule !== undefined && Platform.OS === 'android';
}

/**
 * Carrega (ou reutiliza) um contexto Whisper para o modelo em `modelPath`.
 * Se já houver contexto ativo para o mesmo path, reutiliza sem recarregar.
 */
export async function initStt(
  modelPath: string,
): Promise<SttContext> {
  if (!isSttAvailable()) {
    throw new Error('whisper.rn indisponível — biblioteca não instalada ou plataforma não suportada');
  }
  if (!modelPath) {
    throw new Error('Caminho do modelo Whisper não configurado. Defina em Settings.');
  }
  if (activeContext && activeModelPath === modelPath) {
    return activeContext;
  }
  if (activeContext) {
    activeContext.release();
    activeContext = null;
    activeModelPath = null;
  }
  const ctx: SttContext = await WhisperModule.initWhisper({filePath: modelPath});
  activeContext = ctx;
  activeModelPath = modelPath;
  return ctx;
}

/**
 * Transcreve um arquivo .wav em texto via Whisper carregado.
 */
export async function transcribeAudio(
  modelPath: string,
  wavPath: string,
  options: TranscribeOptions = {},
): Promise<string> {
  const ctx = await initStt(modelPath);
  const opts = {
    language: options.language ?? 'auto',
    flash_attn: options.flash_attn ?? false,
  };
  const out = await ctx.transcribe(wavPath, opts);
  return out.result ?? '';
}

/**
 * Libera o contexto ativo (libera RAM do modelo Whisper carregado).
 */
export function releaseStt(): void {
  if (activeContext) {
    try {
      activeContext.release();
    } catch (e) {
      // silencioso — pode já ter sido liberado
    }
    activeContext = null;
    activeModelPath = null;
  }
}
