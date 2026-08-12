/**
 * appSettings.ts — Migration + settings V2 (MMKV).
 *
 * Este arquivo gerencia a transição de AppSettings (legado, AsyncStorage +
 * LlmConfig solteira) para AppSettingsV2 (MMKV + ServerEntry/ModelEntry).
 *
 * Durante a transição (Phases 1-4), ambas as APIs coexistem:
 * - loadSettings() / saveSettings() — legado (AppSettings)
 * - loadSettingsV2() / saveSettingsV2() — novo (AppSettingsV2)
 *
 * A migration roda automaticamente na primeira abertura após o update:
 * 1. Lê AppSettings legado do AsyncStorage
 * 2. Cria ServerEntry + ModelEntry a partir do LlmConfig antigo
 * 3. Migra API keys do Keychain legado (hostname-based) para serverId-based
 * 4. Salva AppSettingsV2 em MMKV
 * 5. Marca migrated = true
 *
 * Após a Phase 5, o legado será removido e só loadSettingsV2/saveSettingsV2
 * permanecerão.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {createMMKV} from 'react-native-mmkv';
import 'react-native-get-random-values';
import {AppSettings, AppSettingsV2, ServerEntry, ServerFormat} from '../types';
import {getServer, saveServer, createServer} from './serverDb';
import {saveModel, syncModelsFromFetch} from './modelDb';
import {
  migrateLegacyApiKey,
  migrateGlobalLegacyApiKey,
  loadApiKey,
} from './keychainDb';
import {SERVER_PRESETS} from '../services/ServerService';

// MMKV storage instance (compartilhado com serverDb/modelDb pelo mesmo ID)
const storage = createMMKV({id: 'bemore-storage'});

// Chaves de storage
const SETTINGS_V2_KEY = '@bemore_settings_v2';
const LEGACY_SETTINGS_KEY = '@bemore_settings';

// ---------------------------------------------------------------------------
// Legacy API (mantida para compatibilidade durante a transição)
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: AppSettings = {
  systemPrompt: 'You are a helpful assistant.',
  llm: {
    provider: 'localhost',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: 'llama3',
  },
  theme: 'dark',
  sttMode: 'on-device',
  sttModelPath: '',
  sttOnlineModel: '',
  sttServerOverride: '',
  ttsOnlineModel: '',
  ttsServerOverride: '',
  ttsVoice: 'alloy',
  ttsAutoPlay: false,
  streamingEnabled: true,
};

// --- Funções legadas de Keychain (hostname-based) ---
// Mantidas para a migration ler as keys antigas.

const APIKEY_PREFIX_LEGACY = 'bemore-apikey-';
import * as Keychain from 'react-native-keychain';

export function serverKey(baseUrl: string): string {
  try {
    const stripped = baseUrl.trim().replace(/\/+$/, '');
    const match = stripped.match(/^https?:\/\/([^/]+)/i);
    if (match) return match[1].toLowerCase();
    return stripped.replace(/^https?:\/\//i, '').toLowerCase();
  } catch {
    return baseUrl;
  }
}

export async function loadApiKeyForServer(baseUrl: string): Promise<string> {
  try {
    const key = APIKEY_PREFIX_LEGACY + serverKey(baseUrl);
    const creds = await Keychain.getInternetCredentials(key);
    if (creds && creds.password) return creds.password;
  } catch (e) {
    console.warn('[appSettings] Legacy loadApiKeyForServer', e);
  }
  return '';
}

export async function saveApiKeyForServer(
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  try {
    const key = APIKEY_PREFIX_LEGACY + serverKey(baseUrl);
    if (apiKey) {
      await Keychain.setInternetCredentials(key, 'apiKey', apiKey);
    } else {
      try {
        await Keychain.resetInternetCredentials({server: key});
      } catch { /* no-op */ }
    }
  } catch (e) {
    console.warn('[appSettings] Legacy saveApiKeyForServer', e);
  }
}

// --- loadSettings / saveSettings legados ---
// Mantidos exatamente como antes para não quebrar o app atual.
// A migration lê via loadSettings() e depois escreve V2 via saveSettingsV2().

export async function loadSettings(): Promise<AppSettings> {
  let settings = {...DEFAULT_SETTINGS};
  try {
    const raw = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const savedApiKey = parsed?.llm?.apiKey ?? '';
      if (savedApiKey) {
        const url = parsed?.llm?.baseUrl ?? DEFAULT_SETTINGS.llm.baseUrl;
        await saveApiKeyForServer(url, savedApiKey);
        parsed.llm.apiKey = '';
      }
      settings = {...DEFAULT_SETTINGS, ...parsed};
    }
  } catch (e) {
    console.warn('loadSettings error', e);
  }

  const url = settings.llm.baseUrl || DEFAULT_SETTINGS.llm.baseUrl;
  const sk = await loadApiKeyForServer(url);
  if (sk) {
    settings.llm.apiKey = sk;
  } else {
    // Tenta migration legada global (pré-multi-server)
    try {
      const LEGACY_GLOBAL = 'bemore-companion-llm-apikey';
      const creds = await Keychain.getInternetCredentials(LEGACY_GLOBAL);
      if (creds && creds.password) {
        await saveApiKeyForServer(url, creds.password);
        try {
          await Keychain.resetInternetCredentials({server: LEGACY_GLOBAL});
        } catch { /* no-op */ }
        settings.llm.apiKey = creds.password;
      }
    } catch { /* no-op */ }
  }
  return settings;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    const apiKey = settings.llm.apiKey ?? '';
    const url = settings.llm.baseUrl || DEFAULT_SETTINGS.llm.baseUrl;
    await saveApiKeyForServer(url, apiKey);
    const toStore: AppSettings = {
      ...settings,
      llm: {...settings.llm, apiKey: ''},
    };
    await AsyncStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(toStore));
  } catch (e) {
    console.warn('saveSettings error', e);
  }
}

// ---------------------------------------------------------------------------
// V2 API — AppSettingsV2 em MMKV
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS_V2: AppSettingsV2 = {
  activeServerId: null,
  activeModelId: null,
  activeSttModelId: null,
  activeTtsModelId: null,
  activeImageGenModelId: null,
  sttServerId: null,
  ttsServerId: null,
  imageGenServerId: null,
  systemPrompt: 'You are a helpful assistant.',
  theme: 'dark',
  sttMode: 'on-device',
  sttModelPath: '',
  ttsVoice: 'alloy',
  ttsAutoPlay: false,
  streamingEnabled: true,
  migrated: false,
};

/**
 * Lê settings V2 do MMKV. Síncrono (sem await).
 */
export function loadSettingsV2(): AppSettingsV2 {
  const raw = storage.getString(SETTINGS_V2_KEY);
  if (!raw) return {...DEFAULT_SETTINGS_V2};
  try {
    return {...DEFAULT_SETTINGS_V2, ...JSON.parse(raw)} as AppSettingsV2;
  } catch (e) {
    console.warn('[appSettings] Failed to parse settings V2', e);
    return {...DEFAULT_SETTINGS_V2};
  }
}

/**
 * Salva settings V2 no MMKV. Síncrono (sem await).
 */
export function saveSettingsV2(settings: AppSettingsV2): void {
  storage.set(SETTINGS_V2_KEY, JSON.stringify(settings));
}

/**
 * Atualiza campos parciais de settings V2 (merge).
 */
export function patchSettingsV2(patch: Partial<AppSettingsV2>): AppSettingsV2 {
  const current = loadSettingsV2();
  const updated = {...current, ...patch};
  saveSettingsV2(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Migration: legado → V2
// ---------------------------------------------------------------------------

/**
 * Detecta o formato do servidor a partir da URL (heurística).
 */
function detectFormat(baseUrl: string): ServerFormat {
  const url = baseUrl.toLowerCase();
  if (url.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('0.0.0.0')) return 'ollama';
  if (url.includes('pollinations.ai')) return 'pollinations';
  return 'openai';
}

/**
 * Encontra o ícone do preset que matcha a URL, ou retorna 'dns' como fallback.
 */
function findPresetIcon(baseUrl: string): string {
  const lower = baseUrl.toLowerCase().replace(/\/+$/, '');
  for (const preset of SERVER_PRESETS) {
    const presetHost = preset.url.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    const urlHost = lower.replace(/^https?:\/\//, '').split('/')[0];
    if (urlHost === presetHost) return preset.icon;
  }
  return 'dns';
}

/**
 * Verifica se a URL tem free models baseado nos presets.
 */
function findPresetFreeModels(baseUrl: string): boolean {
  const lower = baseUrl.toLowerCase().replace(/\/+$/, '');
  for (const preset of SERVER_PRESETS) {
    const presetHost = preset.url.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    const urlHost = lower.replace(/^https?:\/\//, '').split('/')[0];
    if (urlHost === presetHost) return preset.hasFreeModels;
  }
  return false;
}

/**
 * Executa a migration de AppSettings (legado) para AppSettingsV2 (MMKV).
 *
 * Deve ser chamada uma única vez, na primeira abertura após o update.
 * Se já migrou (settingsV2.migrated === true), não faz nada.
 *
 * @returns AppSettingsV2 após migration (ou o que já existia)
 */
export async function migrateToV2(): Promise<AppSettingsV2> {
  // Verifica se já migrou
  const existing = loadSettingsV2();
  if (existing.migrated) return existing;

  // Lê settings legado do AsyncStorage
  let legacy: AppSettings | null = null;
  try {
    const raw = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
    if (raw) {
      legacy = {...DEFAULT_SETTINGS, ...JSON.parse(raw)};
    }
  } catch (e) {
    console.warn('[migration] Failed to read legacy settings', e);
  }

  const settings: AppSettingsV2 = {
    ...DEFAULT_SETTINGS_V2,
    migrated: true,
  };

  if (legacy) {
    // Migra config geral
    settings.systemPrompt = legacy.systemPrompt;
    settings.theme = legacy.theme ?? 'dark';
    settings.sttMode = legacy.sttMode ?? 'on-device';
    settings.sttModelPath = legacy.sttModelPath ?? '';
    settings.ttsVoice = legacy.ttsVoice ?? 'alloy';
    settings.ttsAutoPlay = legacy.ttsAutoPlay ?? false;
    settings.streamingEnabled = legacy.streamingEnabled ?? true;

    // Migra servidor LLM principal
    if (legacy.llm?.baseUrl?.trim()) {
      const baseUrl = legacy.llm.baseUrl;
      const format = detectFormat(baseUrl);
      const hostname = serverKey(baseUrl);

      // Cria ServerEntry para o servidor LLM principal
      const server = createServer({
        name: hostname || 'Servidor migrado',
        baseUrl,
        format,
        icon: findPresetIcon(baseUrl),
        hasFreeModels: findPresetFreeModels(baseUrl),
        apiKeyCount: 1,
        keyRotation: 'single',
        activeKeyIndex: 0,
      });

      // Migra a API key do formato legado (hostname-based) para serverId-based
      let apiKey = '';
      const legacyKey = APIKEY_PREFIX_LEGACY + hostname;
      try {
        const creds = await Keychain.getInternetCredentials(legacyKey);
        if (creds && creds.password) {
          apiKey = creds.password;
          // Salva no novo formato
          const {saveApiKey} = require('./keychainDb');
          await saveApiKey(server.id, 0, apiKey);
          // Remove a legada
          try {
            await Keychain.resetInternetCredentials({server: legacyKey});
          } catch { /* no-op */ }
        }
      } catch { /* no-op */ }

      // Se não achou no hostname-based, tenta a global (pré-multi-server)
      if (!apiKey) {
        apiKey = await migrateGlobalLegacyApiKey(server.id);
      }

      // Cria ModelEntry para o modelo ativo
      if (legacy.llm.model) {
        settings.activeServerId = server.id;
        // syncModelsFromFetch adicionaria o modelo, mas como não fizemos fetch,
        // criamos manualmente um ModelEntry único:
        const {isVisionModel, isSttModel, isTtsModel, isAnyToAnyModel} =
          require('../utils/modelCapabilities');
        const modelEntry = {
          id: crypto.randomUUID(),
          serverId: server.id,
          modelId: legacy.llm.model,
          isVision: isVisionModel(legacy.llm.model),
          isStt: isSttModel(legacy.llm.model),
          isTts: isTtsModel(legacy.llm.model),
          isAnyToAny: isAnyToAnyModel(legacy.llm.model),
          isImageGen: false,
          isFavorite: true, // modelo ativo vira favorito
          isHidden: false,
          lastFetchedAt: Date.now(),
        };
        saveModel(modelEntry);
        settings.activeModelId = modelEntry.id;
      }
    }

    // Migra STT server override (se existir)
    if (legacy.sttServerOverride?.trim()) {
      const baseUrl = legacy.sttServerOverride;
      const format = detectFormat(baseUrl);
      const hostname = serverKey(baseUrl);
      const sttServer = createServer({
        name: `STT: ${hostname}`,
        baseUrl,
        format,
        icon: findPresetIcon(baseUrl),
        hasFreeModels: findPresetFreeModels(baseUrl),
        apiKeyCount: 1,
        keyRotation: 'single',
        activeKeyIndex: 0,
      });
      // Migra API key do STT override
      await migrateLegacyApiKey(hostname, sttServer.id);
      settings.sttServerId = sttServer.id;
    }

    // Migra TTS server override (se existir)
    if (legacy.ttsServerOverride?.trim()) {
      const baseUrl = legacy.ttsServerOverride;
      const format = detectFormat(baseUrl);
      const hostname = serverKey(baseUrl);
      const ttsServer = createServer({
        name: `TTS: ${hostname}`,
        baseUrl,
        format,
        icon: findPresetIcon(baseUrl),
        hasFreeModels: findPresetFreeModels(baseUrl),
        apiKeyCount: 1,
        keyRotation: 'single',
        activeKeyIndex: 0,
      });
      await migrateLegacyApiKey(hostname, ttsServer.id);
      settings.ttsServerId = ttsServer.id;
    }
  }

  // Salva V2 em MMKV
  saveSettingsV2(settings);

  // NÃO limpa AsyncStorage ainda — manter como backup por 1 versão.
  // Será limpo na Phase 5.

  return settings;
}

/**
 * Verifica se a migration já foi feita.
 */
export function isMigrated(): boolean {
  return loadSettingsV2().migrated;
}
