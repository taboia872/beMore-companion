import {useState, useCallback} from 'react';
import {
  isSttAvailable,
  transcribeAudio,
  releaseStt,
} from '../services/SttService';

export type WhisperStatus =
  | 'idle'
  | 'transcribing'
  | 'done'
  | 'error';

export interface UseWhisper {
  status: WhisperStatus;
  errorMessage: string | null;
  lastTranscript: string | null;
  transcribe: (wavPath: string, modelPath: string) => Promise<string | null>;
  reset: () => void;
  releaseModel: () => void;
}

/**
 * Hook para transcrição on-device via whisper.rn.
 * - Não carrega o modelo no startup; só quando `transcribe` é chamado.
 * - ModelPath deve vir de Settings (sttModelPath) — se vazio, erro amigável.
 * - Se whisper.rn não estiver instalado/disponível, erro amigável (não crash).
 */
export function useWhisper(): UseWhisper {
  const [status, setStatus] = useState<WhisperStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);

  const transcribe = useCallback(
    async (wavPath: string, modelPath: string): Promise<string | null> => {
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
