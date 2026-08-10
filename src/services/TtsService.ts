/**
 * TtsService — síntese de voz (Text-to-Speech) via API online.
 *
 * Usa o endpoint OpenAI-compatível POST /audio/speech que recebe
 * {model, input, voice} e retorna áudio binário (MP3).
 *
 * Fluxo:
 *   1. POST /audio/speech com texto + modelo + voz
 *   2. Resposta é áudio binário (MP3) — XHR com responseType='base64'
 *      (extensão RN) para obter os bytes como base64
 *   3. Salvar em arquivo temporário no cacheDir (via RNFS)
 *   4. Tocar com react-native-sound
 *
 * Suporta servidor independente (ttsServerOverride) com sua própria
 * API key no Keychain, permitindo usar um provedor diferente do LLM.
 */

import {Platform} from 'react-native';
import RNFS from 'react-native-fs';
import Sound from 'react-native-sound';

export interface TtsParams {
  /** URL base do servidor (ex: https://api.groq.com/openai/v1) */
  baseUrl: string;
  /** API key (Bearer token) */
  apiKey: string;
  /** Nome do modelo (ex: tts-1, tts-1-hd) */
  model: string;
  /** Texto a sintetizar */
  input: string;
  /** Voz (ex: alloy, nova, shimmer, echo, fable, onyx) */
  voice?: string;
}

/**
 * Constrói a URL completa do endpoint de síntese.
 */
function buildSpeechUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  return `${clean}/audio/speech`;
}

// Instância ativa do Sound — apenas uma reprodução por vez.
let activeSound: Sound | null = null;

/**
 * Sintetiza texto em áudio via API online e toca o resultado.
 *
 * @returns Promise que resolve quando o áudio termina de tocar
 * @throws Error com mensagem amigável em PT-BR
 */
export function speakText(params: TtsParams): Promise<void> {
  const {baseUrl, apiKey, model, input, voice} = params;

  if (!baseUrl) {
    return Promise.reject(new Error('Servidor TTS não configurado. Defina nas configurações.'));
  }
  if (!model) {
    return Promise.reject(new Error('Modelo TTS não selecionado. Escolha um modelo nas configurações.'));
  }
  if (!input || !input.trim()) {
    return Promise.reject(new Error('Sem texto para sintetizar.'));
  }

  // Limita texto para nao exceder limites da API (~4096 chars).
  const truncatedInput = input.length > 4000 ? input.slice(0, 4000) : input;

  const url = buildSpeechUrl(baseUrl);
  const body = JSON.stringify({
    model,
    input: truncatedInput,
    voice: voice || 'alloy',
    response_format: 'mp3',
  });

  return new Promise<void>((resolve, reject) => {
    // XHR com responseType='base64' — extensao do RN para obter
    // dados binários como string base64. Mais confiavel que
    // fetch+blob+FileReader no Android.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'base64' as any;
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (apiKey) {
      xhr.setRequestHeader('Authorization', `Bearer ${apiKey}`);
    }

    xhr.onreadystatechange = async () => {
      if (xhr.readyState !== 4) return;

      // Status 0 = sem rede ou abortado.
      if (xhr.status === 0 || xhr.status === undefined) {
        reject(new Error('Sem internet ou servidor TTS indisponível.'));
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        // Com responseType base64, a resposta de erro também vem codificada.
        // Não confiamos em atob (não existe no Hermes sem remote debugging).
        // Mostramos o status HTTP + uma mensagem genérica.
        if (xhr.status === 401 || xhr.status === 403) {
          reject(new Error('API Key inválida para TTS. Verifique nas configurações.'));
          return;
        }
        if (xhr.status === 404) {
          reject(new Error(`Modelo TTS "${model}" não encontrado neste servidor.`));
          return;
        }
        if (xhr.status === 429) {
          reject(new Error('Muitas requisições TTS. Aguarde um momento.'));
          return;
        }
        reject(new Error(`Erro TTS: servidor respondeu ${xhr.status}.`));
        return;
      }

      // Sucesso — xhr.response contem o MP3 como base64.
      const base64Data: string = xhr.response || '';
      if (!base64Data) {
        reject(new Error('Servidor TTS retornou áudio vazio.'));
        return;
      }

      // Salvar no cacheDir e tocar.
      try {
        const fileName = `tts_${Date.now()}.mp3`;
        const audioPath = `${RNFS.CachesDirectoryPath}/${fileName}`;
        await RNFS.writeFile(audioPath, base64Data, 'base64');
        await playAudioFile(audioPath);
        // Limpar arquivo após tocar.
        try { await RNFS.unlink(audioPath); } catch { /* no-op */ }
        resolve();
      } catch (e) {
        reject(new Error('Falha ao salvar/tonar áudio TTS.'));
      }
    };

    xhr.onerror = () => {
      reject(new Error('Falha de rede ao conectar com servidor TTS.'));
    };

    xhr.send(body);
  });
}

/**
 * Toca um arquivo de áudio local.
 * Para qualquer reprodução anterior antes de iniciar a nova.
 */
function playAudioFile(path: string): Promise<void> {
  return new Promise((resolve) => {
    // Para reprodução anterior se existir.
    if (activeSound) {
      activeSound.stop();
      activeSound.release();
      activeSound = null;
    }

    // Sound precisa de categoria 'Playback' para respeitar mute/silencioso.
    Sound.setCategory('Playback');

    const sound = new Sound(path, '', (error) => {
      if (error) {
        console.warn('[TTS] Erro ao carregar áudio:', error);
        resolve();
        return;
      }
      activeSound = sound;
      sound.play((success) => {
        sound.release();
        if (activeSound === sound) activeSound = null;
        resolve();
      });
    });
  });
}

/**
 * Para a reprodução de TTS ativa, se houver.
 */
export function stopSpeaking(): void {
  if (activeSound) {
    activeSound.stop();
    activeSound.release();
    activeSound = null;
  }
}

/**
 * Verifica se há TTS tocando no momento.
 */
export function isSpeaking(): boolean {
  return activeSound !== null;
}
