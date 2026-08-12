/**
 * Multi-key storage no Android Keystore (react-native-keychain).
 *
 * Cada servidor pode ter N API keys, armazenadas individualmente no Keychain.
 * A chave do Keychain é: bemore-apikey-<serverId>-<keyIndex>
 *
 * Substitui as funções de appSettings.ts (loadApiKeyForServer/saveApiKeyForServer)
 * que usavam hostname como chave — agora usamos serverId (UUID) que é estável
 * mesmo se o usuário renomear ou trocar a URL do servidor.
 */

import * as Keychain from 'react-native-keychain';
import 'react-native-get-random-values';

const KEY_PREFIX = 'bemore-apikey-';
const KEYCHAIN_ACCOUNT = 'apiKey';

/**
 * Constrói a chave do Keychain para uma key específica de um servidor.
 */
function keychainKey(serverId: string, keyIndex: number): string {
  return `${KEY_PREFIX}${serverId}-${keyIndex}`;
}

/**
 * Lê uma API key específica do Keychain.
 * Retorna string vazia se não existir ou se houver erro.
 */
export async function loadApiKey(
  serverId: string,
  keyIndex: number,
): Promise<string> {
  try {
    const key = keychainKey(serverId, keyIndex);
    const creds = await Keychain.getInternetCredentials(key);
    if (creds && creds.password) {
      return creds.password;
    }
  } catch (e) {
    console.warn('[keychainDb] Failed to read apiKey', serverId, keyIndex, e);
  }
  return '';
}

/**
 * Armazena uma API key no Keychain.
 * Se apiKey for vazia, remove a credencial existente (limpa).
 */
export async function saveApiKey(
  serverId: string,
  keyIndex: number,
  apiKey: string,
): Promise<void> {
  try {
    const key = keychainKey(serverId, keyIndex);
    if (apiKey) {
      await Keychain.setInternetCredentials(key, KEYCHAIN_ACCOUNT, apiKey);
    } else {
      try {
        await Keychain.resetInternetCredentials({server: key});
      } catch {
        /* no-op — pode não existir */
      }
    }
  } catch (e) {
    console.warn('[keychainDb] Failed to save apiKey', serverId, keyIndex, e);
  }
}

/**
 * Remove uma API key específica do Keychain.
 */
export async function resetApiKey(
  serverId: string,
  keyIndex: number,
): Promise<void> {
  try {
    await Keychain.resetInternetCredentials({
      server: keychainKey(serverId, keyIndex),
    });
  } catch {
    /* no-op */
  }
}

/**
 * Remove TODAS as API keys de um servidor (usado ao deletar o servidor).
 * Itera de 0 até apiKeyCount - 1 e remove cada uma.
 */
export async function resetAllApiKeys(
  serverId: string,
  apiKeyCount: number,
): Promise<void> {
  for (let i = 0; i < apiKeyCount; i++) {
    await resetApiKey(serverId, i);
  }
}

// ---------------------------------------------------------------------------
// Migration — move keys do formato legado (hostname-based) para o novo
// formato (serverId-based).
// ---------------------------------------------------------------------------

const APIKEY_PREFIX_LEGACY = 'bemore-apikey-';

/**
 * Migra uma key legada (keyed por hostname) para o novo formato (keyed por serverId).
 * Lê a key legada do Keychain, salva no novo formato, e remove a legada.
 */
export async function migrateLegacyApiKey(
  legacyHostname: string,
  newServerId: string,
): Promise<string> {
  try {
    const legacyKey = APIKEY_PREFIX_LEGACY + legacyHostname;
    const creds = await Keychain.getInternetCredentials(legacyKey);
    if (creds && creds.password) {
      // Salva no novo formato
      await saveApiKey(newServerId, 0, creds.password);
      // Remove a legada
      try {
        await Keychain.resetInternetCredentials({server: legacyKey});
      } catch {
        /* no-op */
      }
      return creds.password;
    }
  } catch {
    /* no-op */
  }
  return '';
}

/**
 * Migra a key legada global (pré-multi-server, single key).
 */
export async function migrateGlobalLegacyApiKey(
  newServerId: string,
): Promise<string> {
  try {
    const LEGACY_GLOBAL = 'bemore-companion-llm-apikey';
    const creds = await Keychain.getInternetCredentials(LEGACY_GLOBAL);
    if (creds && creds.password) {
      await saveApiKey(newServerId, 0, creds.password);
      try {
        await Keychain.resetInternetCredentials({server: LEGACY_GLOBAL});
      } catch {
        /* no-op */
      }
      return creds.password;
    }
  } catch {
    /* no-op */
  }
  return '';
}
