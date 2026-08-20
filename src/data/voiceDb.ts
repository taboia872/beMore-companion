/**
 * voiceDb.ts — Cache de vozes do FishAudio no MMKV + favoritos.
 *
 * As vozes do FishAudio são buscadas via GET /model (paginado, até 100 por página).
 * Para evitar refazer o fetch a cada vez que o usuário abre as configurações,
 * guardamos as vozes já buscadas em MMKV, indexadas por serverId.
 *
 * Cada servidor FishAudio tem seu próprio conjunto de vozes paginadas.
 * O cache guarda:
 *   - `voices`: lista de FishAudioVoice já buscadas
 *   - `lastPage`: última página buscada (para saber qual buscar próxima)
 *   - `favoriteVoiceIds`: set de IDs de vozes favoritadas pelo usuário
 *
 * Como o FishAudio pode ter milhares de vozes, não carregamos tudo de uma vez:
 * o usuário carrega 100, e pode pedir mais 100 (próxima página) sob demanda.
 *
 * O seletor de voz TTS (card Voz TTS) mostra apenas as vozes favoritadas,
 * equivalente ao seletor de modelo que só mostra favoritos. As vozes podem
 * ser favoritadas/desfavoritadas direto no card de Servidores.
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
  total: number; // total de vozes disponíveis (do último fetch)
  favoriteIds: string[]; // IDs das vozes favoritadas
}

function readCache(serverId: string): CachedVoiceData {
  const key = voiceKeyPrefix + serverId;
  const raw = storage.getString(key);
  if (!raw) return {voices: [], lastPage: 0, total: 0, favoriteIds: []};
  try {
    const data = JSON.parse(raw) as Partial<CachedVoiceData>;
    return {
      voices: data.voices ?? [],
      lastPage: data.lastPage ?? 0,
      total: data.total ?? 0,
      favoriteIds: data.favoriteIds ?? [],
    };
  } catch (e) {
    console.warn('[voiceDb] Failed to parse fish voices', e);
    return {voices: [], lastPage: 0, total: 0, favoriteIds: []};
  }
}

function writeCache(serverId: string, data: CachedVoiceData): void {
  storage.set(voiceKeyPrefix + serverId, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Vozes (cache)
// ---------------------------------------------------------------------------

/** Lê todas as vozes em cache de um servidor FishAudio. */
export function getFishVoices(serverId: string): FishAudioVoice[] {
  return readCache(serverId).voices;
}

/** Lê a última página buscada para um servidor (0 = nenhuma). */
export function getFishVoicesLastPage(serverId: string): number {
  return readCache(serverId).lastPage;
}

/** Lê o total de vozes disponíveis (do último fetch). */
export function getFishVoicesTotal(serverId: string): number {
  return readCache(serverId).total;
}

/**
 * Adiciona vozes ao cache de um servidor (append, sem duplicar).
 * Atualiza lastPage e total. Retorna a lista completa mesclada.
 */
export function appendFishVoices(
  serverId: string,
  newVoices: FishAudioVoice[],
  page: number,
  total: number,
): FishAudioVoice[] {
  const data = readCache(serverId);
  const existingIds = new Set(data.voices.map(v => v.id));
  const merged = [...data.voices];
  for (const v of newVoices) {
    if (!existingIds.has(v.id)) {
      merged.push(v);
    }
  }
  data.voices = merged;
  data.lastPage = page;
  data.total = total;
  writeCache(serverId, data);
  return merged;
}

/** Substitui o cache completo de vozes (usado em refresh). */
export function setFishVoices(
  serverId: string,
  voices: FishAudioVoice[],
  page: number,
  total: number,
): void {
  const data = readCache(serverId);
  data.voices = voices;
  data.lastPage = page;
  data.total = total;
  writeCache(serverId, data);
}

/** Limpa o cache de vozes de um servidor (mantém favoritos). */
export function clearFishVoices(serverId: string): void {
  const data = readCache(serverId);
  // Mantém favoriteIds, limpa vozes e paginação
  writeCache(serverId, {
    voices: [],
    lastPage: 0,
    total: 0,
    favoriteIds: data.favoriteIds,
  });
}

// ---------------------------------------------------------------------------
// Favoritos de vozes
// ---------------------------------------------------------------------------

/** Retorna os IDs das vozes favoritadas de um servidor. */
export function getFavoriteVoiceIds(serverId: string): string[] {
  return readCache(serverId).favoriteIds;
}

/** Retorna as vozes favoritas (objetos completos) de um servidor. */
export function getFavoriteVoices(serverId: string): FishAudioVoice[] {
  const data = readCache(serverId);
  const favSet = new Set(data.favoriteIds);
  return data.voices.filter(v => favSet.has(v.id));
}

/** Verifica se uma voz é favorita. */
export function isVoiceFavorite(serverId: string, voiceId: string): boolean {
  return readCache(serverId).favoriteIds.includes(voiceId);
}

/** Alterna o favorito de uma voz. */
export function toggleVoiceFavorite(serverId: string, voiceId: string): boolean {
  const data = readCache(serverId);
  const idx = data.favoriteIds.indexOf(voiceId);
  if (idx >= 0) {
    data.favoriteIds.splice(idx, 1);
    writeCache(serverId, data);
    return false; // não é mais favorito
  }
  data.favoriteIds.push(voiceId);
  writeCache(serverId, data);
  return true; // virou favorito
}
