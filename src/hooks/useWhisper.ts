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
import {AppSettings, AppSettingsV2} from '../types';
import {getServer} from '../data/serverDb';
import {getModel} from '../data/modelDb';
import {loadApiKey} from '../data/keychainDb';

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
   *
   * @param settingsV2 Configurações V2 — usada para resolver o servidor STT
   *                   e sua API key (que pode ser diferente do servidor LLM).
   */
  transcribe: (wavPath: string, settings: AppSettings, settingsV2: AppSettingsV2) => Promise<string | null>;
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
    async (wavPath: string, settings: AppSettings, settingsV2: AppSettingsV2): Promise<string | null> => {
      const mode = settings.sttMode ?? 'online';

      if (mode === 'online') {
        return transcribeOnline(wavPath, settings, settingsV2, setStatus, setErrorMessage, setLastTranscript);
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
  settingsV2: AppSettingsV2,
  setStatus: (s: WhisperStatus) => void,
  setErrorMessage: (e: string | null) => void,
  setLastTranscript: (t: string | null) => void,
): Promise<string | null> {
  // Resolve modelo STT do V2 (mais confiável que settings.sttOnlineModel)
  const sttModel = settingsV2.activeSttModelId
    ? getModel(settingsV2.activeSttModelId)
    : null;
  const model = sttModel?.modelId ?? settings.sttOnlineModel ?? '';
  if (!model) {
    setStatus('error');
    setErrorMessage('Modelo STT não selecionado. Escolha um nas configurações.');
    return null;
  }
  if (!isSttOnlineAvailable()) {
    setStatus('error');
    setErrorMessage('STT online indisponível nesta plataforma.');
    return null;
  }

  // Resolve baseUrl e apiKey do servidor STT usando V2:
  // - sttServerId explícito, senão cai para o activeServerId (chat server)
  // - apiKey do Keychain (V2 — keyed by serverId+keyIndex)
  const sttServerId = settingsV2.sttServerId ?? settingsV2.activeServerId;
  const sttServer = sttServerId ? getServer(sttServerId) : null;
  const baseUrl = sttServer?.baseUrl ?? settings.llm.baseUrl ?? '';

  let apiKey = '';
  if (sttServer && sttServer.apiKeyCount > 0) {
    apiKey = await loadApiKey(sttServer.id, sttServer.activeKeyIndex);
  }
  // Fallback: se STT == servidor de chat, usa a apiKey legada do settings
  if (!apiKey && settingsV2.sttServerId === null) {
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
