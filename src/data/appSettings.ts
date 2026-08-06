import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { AppSettings } from '../types';

const STORAGE_KEY = '@bemore_settings';
const APIKEY_KEYCHAIN_SERVER = 'bemore-companion-llm-apikey';
const APIKEY_KEYCHAIN_ACCOUNT = 'apiKey';

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
 * Lê a apiKey do Android Keystore via react-native-keychain.
 * Retorna string vazia se não houver credencial armazenada.
 */
async function loadApiKey(): Promise<string> {
  try {
    const creds = await Keychain.getInternetCredentials(
      APIKEY_KEYCHAIN_SERVER,
    );
    if (creds && creds.password) {
      return creds.password;
    }
  } catch (e) {
    console.warn('[appSettings] Failed to read apiKey from Keychain', e);
  }
  return '';
}

/**
 * Armazena a apiKey no Android Keystore. Se a key for vazia, remove a
 * credencial existente (limpa).
 */
async function saveApiKey(apiKey: string): Promise<void> {
  try {
    if (apiKey) {
      await Keychain.setInternetCredentials(
        APIKEY_KEYCHAIN_SERVER,
        APIKEY_KEYCHAIN_ACCOUNT,
        apiKey,
      );
    } else {
      // Limpa a credencial quando apiKey é vazia.
      try {
        await Keychain.resetInternetCredentials(APIKEY_KEYCHAIN_SERVER);
      } catch {
        /* no-op — pode não existir */
      }
    }
  } catch (e) {
    console.warn('[appSettings] Failed to save apiKey to Keychain', e);
  }
}

/**
 * Carrega settings do AsyncStorage (sem apiKey) + apiKey do Keychain.
 * AapiKey NUNCA é persistida em AsyncStorage — só no Keystore.
 */
export async function loadSettings(): Promise<AppSettings> {
  let settings = {...DEFAULT_SETTINGS};
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      // Parseia tudo, mas remove apiKey do snapshot salto (migration
      // transparente: se havia apiKey em cleartext, ela é lida aqui
      // p/ uso mas não persiste de volta).
      const parsed = JSON.parse(raw);
      // Cópia rasa, sem propagation da apiKey do JSON p/ settings
      const savedApiKey = parsed?.llm?.apiKey ?? '';
      if (savedApiKey) {
        // Migration: havia apiKey em cleartext — move para Keychain.
        await saveApiKey(savedApiKey);
      }
      // Strip apiKey do objeto salvo antes de mesclar (não persiste de volta).
      if (parsed?.llm) {
        parsed.llm.apiKey = '';
      }
      settings = {...DEFAULT_SETTINGS, ...parsed};
    }
  } catch (e) {
    console.warn('loadSettings error', e);
  }
  // Sempre lê a apiKey do Keychain por último (autoridade final).
  settings.llm.apiKey = await loadApiKey();
  return settings;
}

/**
 * Salva settings no AsyncStorage (SEM apiKey) + apiKey no Keychain.
 * A apiKey é extraída do objeto antes de serializar para garantir
 * que nunca vá para AsyncStorage.
 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    // Salva apiKey no Keychain (separado do resto das settings).
    const apiKey = settings.llm.apiKey ?? '';
    await saveApiKey(apiKey);
    // Clona settings SEM a apiKey antes de salvar em AsyncStorage.
    // A apiKey nunca deve ser serializada em texto plano no disco.
    const toStore: AppSettings = {
      ...settings,
      llm: {...settings.llm, apiKey: ''},
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch (e) {
    console.warn('saveSettings error', e);
  }
}
