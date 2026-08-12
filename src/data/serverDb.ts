/**
 * CRUD de ServerEntry no MMKV.
 *
 * Os servidores são armazenados como um array JSON numa única chave do MMKV.
 * MMKV é síncrono (sem await) — simplifica a UI.
 *
 * API keys NÃO são armazenadas aqui — ficam no Keychain (ver keychainDb.ts).
 */

import {createMMKV} from 'react-native-mmkv';
import 'react-native-get-random-values';
import {ServerEntry} from '../types';

// react-native-mmkv v4: MMKV é type-only, createMMKV é a factory.
const storage = createMMKV({id: 'bemore-storage'});
const SERVERS_KEY = '@bemore_servers';

/**
 * Lê todos os servidores cadastrados.
 */
export function getAllServers(): ServerEntry[] {
  const raw = storage.getString(SERVERS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ServerEntry[];
  } catch (e) {
    console.warn('[serverDb] Failed to parse servers', e);
    return [];
  }
}

/**
 * Busca um servidor pelo ID.
 */
export function getServer(id: string): ServerEntry | null {
  return getAllServers().find(s => s.id === id) ?? null;
}

/**
 * Cria ou atualiza um servidor.
 * Se o ID já existe, substitui. Se não, adiciona.
 * Atualiza updatedAt automaticamente.
 */
export function saveServer(server: ServerEntry): void {
  const servers = getAllServers();
  const idx = servers.findIndex(s => s.id === server.id);
  const updated: ServerEntry = {
    ...server,
    updatedAt: Date.now(),
  };
  if (idx >= 0) {
    servers[idx] = updated;
  } else {
    servers.push(updated);
  }
  storage.set(SERVERS_KEY, JSON.stringify(servers));
}

/**
 * Deleta um servidor pelo ID.
 * ATENÇÃO: Não deleta os ModelEntry nem as API keys — o chamador
 * deve fazer o cascade (ver deleteServerCascade em serverDbExtended ou
 * na tela ServerEditorScreen).
 */
export function deleteServer(id: string): void {
  const servers = getAllServers().filter(s => s.id !== id);
  storage.set(SERVERS_KEY, JSON.stringify(servers));
}

/**
 * Deleta um servidor E tudo que está vinculado a ele:
 * - Todos os ModelEntry com serverId === id (cascade)
 * - Todas as API keys do Keychain para este servidor
 *
 * Retorna false se o servidor não existir.
 */
export async function deleteServerCascade(
  id: string,
): Promise<boolean> {
  const server = getServer(id);
  if (!server) return false;

  // Cascade: deleta modelos
  const {deleteModelsByServer} = require('./modelDb');
  deleteModelsByServer(id);

  // Cascade: deleta API keys do Keychain
  const {resetAllApiKeys} = require('./keychainDb');
  await resetAllApiKeys(id, server.apiKeyCount);

  // Remove da lista
  deleteServer(id);
  return true;
}

/**
 * Atualiza campos parciais de um servidor (merge).
 */
export function patchServer(
  id: string,
  patch: Partial<ServerEntry>,
): void {
  const server = getServer(id);
  if (!server) return;
  saveServer({...server, ...patch});
}

/**
 * Cria um novo servidor com defaults sensíveis.
 * Retorna o servidor criado (com ID gerado).
 */
export function createServer(
  partial: Partial<ServerEntry> & Pick<ServerEntry, 'name' | 'baseUrl' | 'format'>,
): ServerEntry {
  const now = Date.now();
  const server: ServerEntry = {
    id: crypto.randomUUID(),
    name: partial.name,
    baseUrl: partial.baseUrl,
    format: partial.format,
    icon: partial.icon ?? 'dns',
    hasFreeModels: partial.hasFreeModels ?? false,
    apiKeyCount: partial.apiKeyCount ?? 0,
    keyRotation: partial.keyRotation ?? 'single',
    activeKeyIndex: partial.activeKeyIndex ?? 0,
    createdAt: now,
    updatedAt: now,
  };
  saveServer(server);
  return server;
}

/**
 * Conta quantos servidores estão cadastrados.
 */
export function getServerCount(): number {
  return getAllServers().length;
}
