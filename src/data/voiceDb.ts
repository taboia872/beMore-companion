/**
 * voiceDb.ts — Cache de vozes do FishAudio no MMKV.
 *
 * As vozes do FishAudio são buscadas via GET /model (paginado, 50 por página).
 * Para evitar refazer o fetch a cada vez que o usuário abre as configurações,
 * guardamos as vozes já buscadas em MMKV, indexadas por serverId.
 *
 * Cada servidor FishAudio tem seu próprio conjunto de vozes paginadas.
 * O cache guarda:
 *   - `voices`: lista de FishAudioVoice já buscadas
 *   - `lastPage`: última página buscada (para saber qual buscar próxima)
 *
 * Como o FishAudio pode ter milhares de vozes, não carregamos tudo de uma vez:
 * o usuário carrega 50, e pode pedir mais 50 (próxima página) sob demanda.
 */

import {MMKV} from 'react-native-mmkv';
import 'react-native-get-random-values';
import {FishAudioVoice} from '../services/TtsService';

const storage = new MMKV();

// Chave MMKV: @bemore_fish_voices_<serverId>
const voiceKeyPrefix = '@bemore_fish_voices_';

interface CachedVoiceData {
  voices: FishAudioVoice[];
  lastPage: number; // última página buscada (0 = nenhuma)
}

/** Lê o cache de vozes de um servidor FishAudio. */
export function getFishVoices(serverId: string): FishAudioVoice[] {
  const key = voiceKeyPrefix + serverId;
  const raw = storage.getString(key);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as CachedVoiceData;
    return data.voices ?? [];
  } catch (e) {
    console.warn('[voiceDb] Failed to parse fish voices', e);
    return [];
  }
}

/** Lê a última página buscada para um servidor (0 = nenhuma). */
export function getFishVoicesLastPage(serverId: string): number {
  const key = voiceKeyPrefix + serverId;
  const raw = storage.getString(key);
  if (!raw) return 0;
  try {
    const data = JSON.parse(raw) as CachedVoiceData;
    return data.lastPage ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Adiciona vozes ao cache de um servidor (append).
 * Atualiza lastPage para a página informada.
 * Se uma voz com o mesmo id já existe, não duplica.
 */
export function appendFishVoices(
  serverId: string,
  newVoices: FishAudioVoice[],
  page: number,
): FishAudioVoice[] {
  const existing = getFishVoices(serverId);
  const existingIds = new Set(existing.map(v => v.id));
  const merged = [...existing];
  for (const v of newVoices) {
    if (!existingIds.has(v.id)) {
      merged.push(v);
    }
  }
  const data: CachedVoiceData = {
    voices: merged,
    lastPage: page,
  };
  storage.set(voiceKeyPrefix + serverId, JSON.stringify(data));
  return merged;
}

/**
 * Substitui completamente o cache de vozes de um servidor.
 * Usado quando o usuário pede um refresh (limpa e refaz).
 */
export function setFishVoices(
  serverId: string,
  voices: FishAudioVoice[],
  page: number,
): void {
  const data: CachedVoiceData = {
    voices,
    lastPage: page,
  };
  storage.set(voiceKeyPrefix + serverId, JSON.stringify(data));
}

/** Limpa o cache de vozes de um servidor. */
export function clearFishVoices(serverId: string): void {
  storage.delete(voiceKeyPrefix + serverId);
}
