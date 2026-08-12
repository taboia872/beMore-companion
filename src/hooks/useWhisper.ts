import {useState, useCallback} from 'react';
import {
  isSttAvailable,
  transcribeAudio,
  releaseStt,
} from '../services/SttService';
import {
  isSttOnlineAvailable,
  transcribeAudioOnline,
} from '../services/SttOnlineService';
import {AppSettings} from '../types';
import {loadApiKeyForServer} from '../data/appSettings';

export type WhisperStatus =
  | 'idle'
  | 'transcribing'
  | 'done'
  | 'error';

export interface UseWhisper {
  status: WhisperStatus;
  errorMessage: string | null;
  lastTranscript: string | null;
  /**
   * Transcreve áudio. O modo (on-device vs online) é determinado por
   * settings.sttMode.
   * - on-device: usa whisper.rn com sttModelPath
   * - online: usa API de transcrição (Groq/OpenAI-compat) com sttOnlineModel
   *   e reutiliza baseUrl+apiKey do LLM (ou sttServerOverride se definido)
   */
  transcribe: (wavPath: string, settings: AppSettings) => Promise<string | null>;
  reset: () => void;
  releaseModel: () => void;
}

/**
 * Hook para transcrição de voz (STT).
 * Suporta dois modos:
 * - on-device: whisper.rn com modelo GGUF local (sttModelPath)
 * - online: API de transcrição (Groq/OpenAI-compat) com sttOnlineModel
 *
 * O modo é determinado por settings.sttMode — o caller não precisa saber
 * qual backend está sendo usado.
 */
export function useWhisper(): UseWhisper {
  const [status, setStatus] = useState<WhisperStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);

  const transcribe = useCallback(
    async (wavPath: string, settings: AppSettings): Promise<string | null> => {
      const mode = settings.sttMode ?? 'on-device';

      if (mode === 'online') {
        return transcribeOnline(wavPath, settings, setStatus, setErrorMessage, setLastTranscript);
      }
      return transcribeOnDevice(wavPath, settings, setStatus, setErrorMessage, setLastTranscript);
    },
    [],
  );

  const reset = useCallback(() => {
    setStatus('idle');
    setErrorMessage(null);
    setLastTranscript(null);
  }, []);

  const releaseModel = useCallback(() => {
    releaseStt();
    setStatus('idle');
    setLastTranscript(null);
  }, []);

  return {status, errorMessage, lastTranscript, transcribe, reset, releaseModel};
}

// ---------------------------------------------------------------------------
// Transcrição on-device (whisper.rn)
// ---------------------------------------------------------------------------
async function transcribeOnDevice(
  wavPath: string,
  settings: AppSettings,
  setStatus: (s: WhisperStatus) => void,
  setErrorMessage: (e: string | null) => void,
  setLastTranscript: (t: string | null) => void,
): Promise<string | null> {
  const modelPath = settings.sttModelPath ?? '';
  if (!modelPath) {
    setStatus('error');
    setErrorMessage('Modelo Whisper não configurado. Abra Settings e defina o caminho do STT.');
    return null;
  }
  if (!isSttAvailable()) {
    setStatus('error');
    setErrorMessage('whisper.rn indisponível — app precisa ser reconstruído com STT habilitado.');
    return null;
  }
  setStatus('transcribing');
  setErrorMessage(null);
  try {
    const text = await transcribeAudio(modelPath, wavPath, {language: 'auto'});
    setLastTranscript(text);
    setStatus('done');
    return text;
  } catch (e) {
    setStatus('error');
    setErrorMessage((e as Error)?.message ?? String(e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transcrição online (Groq/OpenAI-compat: POST /audio/transcriptions)
// ---------------------------------------------------------------------------
async function transcribeOnline(
  wavPath: string,
  settings: AppSettings,
  setStatus: (s: WhisperStatus) => void,
  setErrorMessage: (e: string | null) => void,
  setLastTranscript: (t: string | null) => void,
): Promise<string | null> {
  const model = settings.sttOnlineModel ?? '';
  if (!model) {
    setStatus('error');
    setErrorMessage('Modelo STT online não selecionado. Escolha um nas configurações.');
    return null;
  }
  if (!isSttOnlineAvailable()) {
    setStatus('error');
    setErrorMessage('STT online indisponível nesta plataforma.');
    return null;
  }

  // Determina baseUrl e apiKey:
  // - Se sttServerOverride está definido, usa ele (com apiKey do Keychain daquele hostname)
  // - Senão, reutiliza baseUrl+apiKey do servidor LLM atual
  let baseUrl: string;
  let apiKey: string;
  if (settings.sttServerOverride && settings.sttServerOverride.trim()) {
    baseUrl = settings.sttServerOverride.trim();
    apiKey = await loadApiKeyForServer(baseUrl);
  } else {
    baseUrl = settings.llm.baseUrl;
    apiKey = settings.llm.apiKey ?? '';
  }

  if (!baseUrl) {
    setStatus('error');
    setErrorMessage('Servidor STT não configurado. Defina nas configurações.');
    return null;
  }

  setStatus('transcribing');
  setErrorMessage(null);
  try {
    const text = await transcribeAudioOnline({
      baseUrl,
      apiKey,
      model,
      filePath: wavPath,
      language: undefined, // auto-detect
    });
    setLastTranscript(text);
    setStatus('done');
    return text;
  } catch (e) {
    setStatus('error');
    setErrorMessage((e as Error)?.message ?? String(e));
    return null;
  }
}
