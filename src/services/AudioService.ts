import {NativeModules, Platform} from 'react-native';

/**
 * Ponte para o módulo nativo PcmRecorderModule (Kotlin).
 *
 * O Kotlin grava áudio via AudioRecord (16kHz mono PCM) e salva um .wav
 * com header RIFF válido num path que informamos por chamada JS.
 *
 * Os caminhos precisam estar dentro do sandbox do app (DocumentDirectoryPath
 * ou CacheDirectoryPath) — fora disso o Android bloqueia escrita.
 */
export interface AudioService {
  startRecording(filePath: string): Promise<string>;
  stopRecording(): Promise<string>;
}

interface PcmRecorderNative {
  startRecording(path: string): Promise<string>;
  stopRecording(): Promise<string>;
}

const PcmRecorder: PcmRecorderNative | undefined =
  Platform.OS === 'android' ? (NativeModules.PcmRecorder as PcmRecorderNative) : undefined;

/**
 * Verifica se o módulo nativo está disponível (Android + empacotado).
 * Em iOS ou em ambientes sem o módulo, retorna false.
 */
export function isPcmRecorderAvailable(): boolean {
  return PcmRecorder !== undefined && PcmRecorder !== null;
}

export const audioService: AudioService = {
  /**
   * Inicia gravação de áudio e salva em `filePath`.
   * Retorna o caminho confirmado pelo nativo em caso de sucesso.
   */
  async startRecording(filePath: string): Promise<string> {
    if (!PcmRecorder) {
      throw new Error('PcmRecorder nativo indisponível (plataforma não suportada)');
    }
    return PcmRecorder.startRecording(filePath);
  },

  /**
   * Para a gravação ativa e finaliza o arquivo .wav.
   * Retorna "stopped" em caso de sucesso.
   */
  async stopRecording(): Promise<string> {
    if (!PcmRecorder) {
      throw new Error('PcmRecorder nativo indisponível (plataforma não suportada)');
    }
    return PcmRecorder.stopRecording();
  },
};
