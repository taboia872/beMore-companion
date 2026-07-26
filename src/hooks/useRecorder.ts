import {useState, useRef, useCallback, useEffect} from 'react';
import {Platform, PermissionsAndroid} from 'react-native';
import {audioService, isPcmRecorderAvailable} from '../services/AudioService';

export type RecorderStatus =
  | 'idle'
  | 'recording'
  | 'processing'
  | 'error';

export interface UseRecorder {
  status: RecorderStatus;
  errorMessage: string | null;
  lastFilePath: string | null;
  start: () => Promise<void>;
  stop: () => Promise<string | null>;
  reset: () => void;
}

/**
 * Hook que controla o ciclo de vida do gravador PCM.
 * - Pede permissão runtime RECORD_AUDIO no Android antes de iniciar.
 * - Gera caminho único para o arquivo wav dentro do sandbox do app
 *   (CacheDirectoryPath — arquivos sumirão se o sistema precisar de espaço).
 * - Exibe status granular para a UI reagir.
 */
export function useRecorder(): UseRecorder {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastFilePath, setLastFilePath] = useState<string | null>(null);
  const fileNameCounter = useRef(0);

  useEffect(() => {
    // Avisa no log de dev se o módulo nativo não está acessível.
    // Usuário não precisa ver isso — surfaced só em erro real.
    if (!isPcmRecorderAvailable() && __DEV__) {
      console.warn(
        '[useRecorder] PcmRecorder nativo não disponível — app em plataforma sem módulo compilado.',
      );
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') {
      // iOS usa Info.plist (perms em runtime via AVCapture), não suportado nesta Phase.
      return false;
    }
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: 'Permissão de microfone',
        message: 'O Be More Companion precisa acessar o microfone para transcrição de voz.',
        buttonNeutral: 'Perguntar depois',
        buttonNegative: 'Cancelar',
        buttonPositive: 'Permitir',
      },
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  }, []);

  const start = useCallback(async () => {
    if (status === 'recording') return;
    setStatus('processing');
    setErrorMessage(null);
    try {
      const hasPermission = await requestPermission();
      if (!hasPermission) {
        setStatus('error');
        setErrorMessage('Permissão de microfone negada.');
        return;
      }
      if (!isPcmRecorderAvailable()) {
        setStatus('error');
        setErrorMessage('Gravador nativo indisponível nesta plataforma.');
        return;
      }
      // Caminho dentro do sandbox do app: tmp dir do RN (gerenciada pelo sistema).
      // Prefixo de cada app Android: /data/data/<pkg>/files ou cache.
      fileNameCounter.current += 1;
      const path = `/data/data/com.bemore.companion/files/recording_${Date.now()}_${fileNameCounter.current}.wav`;
      await audioService.startRecording(path);
      setLastFilePath(path);
      setStatus('recording');
    } catch (e) {
      setStatus('error');
      setErrorMessage((e as Error)?.message ?? String(e));
    }
  }, [status, requestPermission]);

  const stop = useCallback(async (): Promise<string | null> => {
    if (status !== 'recording') return null;
    setStatus('processing');
    setErrorMessage(null);
    try {
      await audioService.stopRecording();
      setStatus('idle');
      return lastFilePath;
    } catch (e) {
      setStatus('error');
      setErrorMessage((e as Error)?.message ?? String(e));
      return null;
    }
  }, [status, lastFilePath]);

  const reset = useCallback(() => {
    setStatus('idle');
    setErrorMessage(null);
    setLastFilePath(null);
  }, []);

  return {status, errorMessage, lastFilePath, start, stop, reset};
}
