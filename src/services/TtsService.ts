/**
 * TtsService — síntese de voz (Text-to-Speech) via API online.
 *
 * Suporta dois backends:
 *
 * 1. OpenAI-compatível (Groq, OpenAI, etc):
 *    POST /audio/speech com {model, input, voice} → MP3 binário.
 *
 * 2. Google AI Studio (Gemini):
 *    POST /models/{model}:generateContent?key=API_KEY
 *    Body: {contents, generationConfig:{responseModalities:["AUDIO"],
 *           speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName}}}}}
 *    → base64 PCM L16 24kHz mono (raw). Precisa header WAV.
 *
 * Fluxo:
 *   1. Detectar backend pela URL (generativelanguage.googleapis.com = Gemini)
 *   2. POST com formato apropriado
 *   3. XHR responseType='base64' (extensão RN) para obter bytes
 *   4. Salvar em arquivo temporário (MP3 ou WAV) no cacheDir (via RNFS)
 *   5. Tocar com react-native-sound
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
  /** API key (Bearer token para OpenAI-compat, ?key= para Gemini) */
  apiKey: string;
  /** Nome do modelo (ex: tts-1, gemini-2.5-flash-preview-tts) */
  model: string;
  /** Texto a sintetizar */
  input: string;
  /** Voz — ex: alloy/nova (OpenAI) ou Kore/Charon (Gemini) */
  voice?: string;
}

/**
 * Detecta se a URL é do Google AI Studio (Gemini).
 */
function isGemini(baseUrl: string): boolean {
  return baseUrl.includes('generativelanguage.googleapis.com');
}

/**
 * Constrói a URL completa do endpoint de síntese.
 * OpenAI-compat: {baseUrl}/audio/speech
 * Gemini: {baseUrl}/models/{model}:generateContent?key={apiKey}
 */
function buildSpeechUrl(baseUrl: string, model: string, apiKey: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (isGemini(clean)) {
    // Gemini: ?key= na query string
    const key = apiKey ? `?key=${encodeURIComponent(apiKey)}` : '';
    return `${clean}/models/${model}:generateContent${key}`;
  }
  return `${clean}/audio/speech`;
}

// Instância ativa do Sound — apenas uma reprodução por vez.
let activeSound: Sound | null = null;

/**
 * Vozes predefinidas do Gemini TTS.
 * Referência: https://ai.google.dev/gemini-api/docs/speech-generation
 */
const GEMINI_VOICES = [
  'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam',
  'Aoede', 'Autonoe', 'Charon', 'Despina', 'Enceladus',
  'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Leda',
  'Orus', 'Puck', 'Pulcherrima', 'Rasalgethi', 'Sadachbia',
  'Sadbetanus', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr',
  'Zubenelgenubi',
] as const;

/**
 * Converte um nome de voz para o formato aceito pelo Gemini.
 * Se a voz não estiver na lista, usa 'Kore' (padrão).
 */
function normalizeGeminiVoice(voice?: string): string {
  if (!voice || !voice.trim()) return 'Kore';
  const v = voice.trim();
  // Match case-insensitive contra a lista conhecida.
  const found = GEMINI_VOICES.find(g => g.toLowerCase() === v.toLowerCase());
  return found ?? 'Kore';
}

/**
 * Constrói um arquivo WAV completo (header + PCM) e salva no disco.
 *
 * Gemini TTS retorna audio/L16;rate=24000 — PCM 16-bit signed little-endian,
 * 24000 Hz, mono. Precisamos envolver em WAV para react-native-sound tocar.
 *
 * Em vez de manipular strings base64 (concatenação de base64 quebra por
 * padding '='), escrevemos o header WAVdireto no arquivo com RNFS e então
 * concatenamos o PCM decodificado em um segundo passo.
 *
 * @param pcmBase64 PCM 16-bit 24kHz mono em base64
 * @param sampleRate Taxa de amostragem (default 24000 para Gemini)
 * @returns Caminho do arquivo WAV criado
 */
async function saveWavFile(pcmBase64: string, sampleRate = 24000): Promise<string> {
  // Tamanho do PCM em bytes (base64 → bytes: 4 chars = 3 bytes, com padding).
  const cleanB64 = pcmBase64.replace(/=+$/, '');
  const pcmByteLength = Math.floor(cleanB64.length * 3 / 4);

  // Header WAV = 44 bytes.
  const headerSize = 44;
  const header = new Uint8Array(headerSize);
  const dv = new DataView(header.buffer);

  // RIFF chunk descriptor
  dv.setUint8(0, 0x52);  // 'R'
  dv.setUint8(1, 0x49);  // 'I'
  dv.setUint8(2, 0x46);  // 'F'
  dv.setUint8(3, 0x46);  // 'F'
  dv.setUint32(4, 36 + pcmByteLength, true); // chunkSize
  dv.setUint8(8, 0x57);  // 'W'
  dv.setUint8(9, 0x41);  // 'A'
  dv.setUint8(10, 0x56); // 'V'
  dv.setUint8(11, 0x45); // 'E'

  // fmt sub-chunk
  dv.setUint8(12, 0x66); // 'f'
  dv.setUint8(13, 0x6d); // 'm'
  dv.setUint8(14, 0x74); // 't'
  dv.setUint8(15, 0x20); // ' '
  dv.setUint32(16, 16, true);   // subchunk1Size = 16
  dv.setUint16(20, 1, true);    // audioFormat = 1 (PCM)
  dv.setUint16(22, 1, true);    // numChannels = 1 (mono)
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byteRate
  dv.setUint16(32, 2, true);    // blockAlign = 2 (16-bit mono)
  dv.setUint16(34, 16, true);   // bitsPerSample = 16

  // data sub-chunk
  dv.setUint8(36, 0x64); // 'd'
  dv.setUint8(37, 0x61); // 'a'
  dv.setUint8(38, 0x74); // 't'
  dv.setUint8(39, 0x61); // 'a'
  dv.setUint32(40, pcmByteLength, true);

  // Converter header para base64 (44 bytes → 60 chars base64 com padding).
  const headerB64 = uint8ToBase64(header);

  const fileName = `tts_${Date.now()}.wav`;
  const audioPath = `${RNFS.CachesDirectoryPath}/${fileName}`;

  // Escreve o header primeiro, depois anexa o PCM.
  // RNFS.writeFile sobrescreve; RNFS.appendFile adiciona ao final.
  await RNFS.writeFile(audioPath, headerB64, 'base64');
  await RNFS.appendFile(audioPath, pcmBase64, 'base64');

  return audioPath;
}

/**
 * Converte Uint8Array para string base64.
 * Implementação manual — leve para 44 bytes.
 */
function uint8ToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;

    const triplet = (b0 << 16) | (b1 << 8) | b2;

    result += chars[(triplet >> 18) & 0x3f];
    result += chars[(triplet >> 12) & 0x3f];
    result += i + 1 < bytes.length ? chars[(triplet >> 6) & 0x3f] : '=';
    result += i + 2 < bytes.length ? chars[triplet & 0x3f] : '=';
  }
  return result;
}

/**
 * Sintetiza texto em áudio via API online e toca o resultado.
 *
 * Detecta automaticamente o backend:
 * - Google AI Studio (Gemini): generateContent com responseModalities AUDIO
 * - Outros (OpenAI-compat): /audio/speech com MP3
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

  const gemini = isGemini(baseUrl);
  const url = buildSpeechUrl(baseUrl, model, apiKey);

  // Body difere entre Gemini e OpenAI-compat.
  const body = gemini
    ? JSON.stringify({
        contents: [{parts: [{text: truncatedInput}]}],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {voiceName: normalizeGeminiVoice(voice)},
            },
          },
        },
      })
    : JSON.stringify({
        model,
        input: truncatedInput,
        voice: voice || 'alloy',
        response_format: 'mp3',
      });

  return new Promise<void>((resolve, reject) => {
    // XHR: Gemini retorna JSON (responseType='text'), OpenAI-compat
    // retorna MP3 binário (responseType='base64' — extensão RN).
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    // Gemini: responseType='text' para ler JSON diretamente.
    // OpenAI-compat: responseType='base64' para obter MP3 binário.
    xhr.responseType = (gemini ? 'text' : 'base64') as any;
    xhr.setRequestHeader('Content-Type', 'application/json');
    // Gemini usa ?key= na URL, não Bearer. OpenAI-compat usa Bearer.
    if (!gemini && apiKey) {
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

      // Sucesso — processar áudio.
      try {
        let audioPath: string;

        if (gemini) {
          // Gemini retorna JSON (responseType='text') com PCM base64
          // dentro de candidates[0].content.parts[0].inlineData.data.
          // O PCM é L16 24kHz mono — envelopamos em WAV e salvamos no disco.
          const jsonStr: string = (xhr.response as string) || xhr.responseText || '';
          if (!jsonStr) {
            reject(new Error('Gemini TTS retornou resposta vazia.'));
            return;
          }
          const parsed = JSON.parse(jsonStr);
          const pcmB64 =
            parsed?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ?? '';
          if (!pcmB64) {
            reject(new Error('Gemini TTS respondeu sem áudio (inlineData.data vazio).'));
            return;
          }
          // Constrói WAV (header + PCM) e salva no cacheDir.
          audioPath = await saveWavFile(pcmB64, 24000);
        } else {
          // OpenAI-compat: resposta é MP3 binário em base64.
          const mp3B64: string = xhr.response || '';
          if (!mp3B64) {
            reject(new Error('Servidor TTS retornou áudio vazio.'));
            return;
          }
          const fileName = `tts_${Date.now()}.mp3`;
          audioPath = `${RNFS.CachesDirectoryPath}/${fileName}`;
          await RNFS.writeFile(audioPath, mp3B64, 'base64');
        }

        // Tocar o arquivo.
        await playAudioFile(audioPath);
        // Limpar arquivo após tocar.
        try { await RNFS.unlink(audioPath); } catch { /* no-op */ }
        resolve();
      } catch (e) {
        reject(new Error('Falha ao salvar/tocar áudio TTS: ' + (e as Error)?.message));
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
