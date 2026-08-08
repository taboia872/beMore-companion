import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { AppSettings } from '../types';

const STORAGE_KEY = '@bemore_settings';
// Legado — chave única global (pré-multi-server). Usado só para migration.
const APIKEY_KEYCHAIN_LEGACY = 'bemore-companion-llm-apikey';
const APIKEY_KEYCHAIN_ACCOUNT = 'apiKey';
// Prefixo para chaves per-servidor no Keychain: "bemore-apikey-<hostname>"
const APIKEY_PREFIX = 'bemore-apikey-';

/**
 * Extrai um identificador estável (hostname) da URL do servidor para
 * usar como chave no Keychain. Ex:
 *   "https://api.groq.com/openai/v1"     → "api.groq.com"
 *   "https://openrouter.ai/api/v1"        → "openrouter.ai"
 *   "http://192.168.0.10:11434/v1"        → "192.168.0.10:11434"
 *   "https://openrouter.ai/api/v1/"       → "openrouter.ai"  ( trailing / ignored )
 */
export function serverKey(baseUrl: string): string {
  try {
    const stripped = baseUrl.trim().replace(/\/+$/, '');
    // Tenta parsear como URL
    const match = stripped.match(/^https?:\/\/([^/]+)/i);
    if (match) return match[1].toLowerCase();
    // Fallback: usa a string inteira sem protocolo
    return stripped.replace(/^https?:\/\//i, '').toLowerCase();
  } catch {
    return baseUrl;
  }
}

/**
 * Settings defaults — apiKey vem vazia aqui; ela é lida separadamente do
 * Keychain (Keystore do Android) para nunca ser persistida em cleartext.
 * O campo apiKey em LlmConfig continua existindo no tipo para consumo
 * pela UI/serviços, mas NÃO é serializado em AsyncStorage.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  systemPrompt: 'You are a helpful assistant.',
  llm: {
    provider: 'localhost',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: 'llama3',
  },
  sttModelPath: '',
  streamingEnabled: true,
};

/**
 * Lê a apiKey de um servidor específico do Android Keystore.
 * Cada servidor tem sua própria entrada no Keychain, identificada pelo
 * hostname da URL (ver serverKey()). Permite trocar de servidor sem
 * re-digitar a chave — cada uma fica salva independentemente.
 */
export async function loadApiKeyForServer(baseUrl: string): Promise<string> {
  try {
    const key = APIKEY_PREFIX + serverKey(baseUrl);
    const creds = await Keychain.getInternetCredentials(key);
    if (creds && creds.password) {
      return creds.password;
    }
  } catch (e) {
    console.warn('[appSettings] Failed to read apiKey for server', baseUrl, e);
  }
  return '';
}

/**
 * Armazena a apiKey de um servidor específico no Android Keystore.
 * Se a key for vazia, remove a credencial existente (limpa).
 */
export async function saveApiKeyForServer(baseUrl: string, apiKey: string): Promise<void> {
  try {
    const key = APIKEY_PREFIX + serverKey(baseUrl);
    if (apiKey) {
      await Keychain.setInternetCredentials(key, APIKEY_KEYCHAIN_ACCOUNT, apiKey);
    } else {
      try {
        await Keychain.resetInternetCredentials({server: key});
      } catch {
        /* no-op — pode não existir */
      }
    }
  } catch (e) {
    console.warn('[appSettings] Failed to save apiKey for server', baseUrl, e);
  }
}

// -----------------------------------------------------------------------
// Migration: se existia uma chave única legada (pré-multi-server),
// move ela para o servidor atual e remove a entrada legada.
// -----------------------------------------------------------------------
async function migrateLegacyApiKey(currentBaseUrl: string): Promise<string> {
  try {
    const creds = await Keychain.getInternetCredentials(APIKEY_KEYCHAIN_LEGACY);
    if (creds && creds.password) {
      // Move para o servidor atual
      await saveApiKeyForServer(currentBaseUrl, creds.password);
      // Remove a entrada legada
      try {
        await Keychain.resetInternetCredentials({server: APIKEY_KEYCHAIN_LEGACY});
      } catch { /* no-op */ }
      return creds.password;
    }
  } catch {
    /* no-op */
  }
  return '';
}

/**
 * Carrega settings do AsyncStorage (sem apiKey) + apiKey do Keychain
 * (per-servidor). A apiKey NUNCA é persistida em AsyncStorage — só no Keystore.
 */
export async function loadSettings(): Promise<AppSettings> {
  let settings = {...DEFAULT_SETTINGS};
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migration transparente: se havia apiKey em cleartext no AsyncStorage,
      // move para o Keychain (per-servidor) e stripa do objeto.
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

  // Migration de chave legada (keychain único) → per-servidor.
  const url = settings.llm.baseUrl || DEFAULT_SETTINGS.llm.baseUrl;
  // Tenta carregar a key específica do servidor.
  const serverKey = await loadApiKeyForServer(url);
  if (serverKey) {
    settings.llm.apiKey = serverKey;
  } else {
    // Se não há key per-servidor, tenta migrar da entrada legada.
    const legacy = await migrateLegacyApiKey(url);
    settings.llm.apiKey = legacy;
  }
  return settings;
}

/**
 * Salva settings no AsyncStorage (SEM apiKey) + apiKey no Keychain (per-servidor).
 * A apiKey é extraída do objeto antes de serializar para garantir
 * que nunca vá para AsyncStorage.
 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    // Salva apiKey no Keychain associada ao servidor atual.
    const apiKey = settings.llm.apiKey ?? '';
    const url = settings.llm.baseUrl || DEFAULT_SETTINGS.llm.baseUrl;
    await saveApiKeyForServer(url, apiKey);
    // Clona settings SEM a apiKey antes de salvar em AsyncStorage.
    const toStore: AppSettings = {
      ...settings,
      llm: {...settings.llm, apiKey: ''},
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch (e) {
    console.warn('saveSettings error', e);
  }
}
