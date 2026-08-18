/**
 * KeyRotation — lógica de rotação de API keys quando um servidor tem múltiplas.
 *
 * Estratégias:
 * - 'single':      Sempre usa a key ativa (activeKeyIndex)
 * - 'round-robin': Alterna a cada requisição: 0 → 1 → 2 → 0 → 1 → ...
 * - 'failover':    Usa a key ativa; se 429/401, marca exhausted (cooldown 60s)
 *                  e avança para a próxima não-exhausted.
 *
 * O cooldown é em memória (Map) — não persistido. Reseta ao reiniciar o app.
 * Isso é intencional: as keys se recuperam sozinhas quando o rate limit passa.
 */

import {ServerEntry} from '../types';
import {loadApiKey} from '../data/keychainDb';
import {saveServer} from '../data/serverDb';

// Map<`${serverId}-${keyIndex}`, timestamp de quando foi exhausted>
const exhaustedKeys = new Map<string, number>();

const COOLDOWN_MS = 60_000; // 60 segundos

const DEFAULT_COOLDOWN_MS = 60_000; // 60 segundos (1 min)

/**
 * Retorna a API key a usar para a próxima requisição ao servidor.
 *
 * Em 'round-robin', atualiza activeKeyIndex no serverDb (side effect).
 * Em 'failover', pula keys em cooldown.
 */
export async function getKeyForRequest(
  server: ServerEntry,
): Promise<string> {
  switch (server.keyRotation) {
    case 'single':
      return loadApiKey(server.id, server.activeKeyIndex);

    case 'round-robin': {
      // Alterna a cada chamada
      const next = (server.activeKeyIndex + 1) % server.apiKeyCount;
      saveServer({...server, activeKeyIndex: next});
      return loadApiKey(server.id, next);
    }

    case 'failover': {
      // Procura primeira key não-exhausted a partir do índice ativo
      for (let i = 0; i < server.apiKeyCount; i++) {
        const idx = (server.activeKeyIndex + i) % server.apiKeyCount;
        if (!isKeyExhausted(server.id, idx, getCooldownMs(server))) {
          if (idx !== server.activeKeyIndex) {
            saveServer({...server, activeKeyIndex: idx});
          }
          return loadApiKey(server.id, idx);
        }
      }
      throw new Error(
        'Todas as API keys deste servidor estão em cooldown (rate limit). ' +
        'Aguarde alguns segundos ou adicione mais keys.',
      );
    }
  }
}

/** Retorna o cooldown em ms para um servidor (default 60s = 1 min). */
function getCooldownMs(server: ServerEntry): number {
  const minutes = server.cooldownMinutes ?? 1;
  return Math.max(1, minutes) * 60_000;
}

/**
 * Verifica se uma key está em cooldown (exhausted).
 */
export function isKeyExhausted(
  serverId: string,
  keyIndex: number,
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
): boolean {
  const key = `${serverId}-${keyIndex}`;
  const at = exhaustedKeys.get(key);
  if (!at) return false;
  // Se passou o cooldown, limpa e retorna false (recuperou)
  if (Date.now() - at > COOLDOWN_MS) {
    exhaustedKeys.delete(key);
    return false;
  }
  return true;
}

/**
 * Marca uma key como exhausted (chamar quando a API retorna 429 ou 401).
 * A key fica em cooldown por COOLDOWN_MS (60s).
 */
export function markKeyExhausted(
  serverId: string,
  keyIndex: number,
): void {
  exhaustedKeys.set(`${serverId}-${keyIndex}`, Date.now());
}

/**
 * Limpa todo o cooldown de um servidor (todas as keys recuperam imediatamente).
 * Útil para chamar quando o usuário troca manualmente de key.
 */
export function clearServerCooldown(serverId: string): void {
  for (const key of Array.from(exhaustedKeys.keys())) {
    if (key.startsWith(`${serverId}-`)) {
      exhaustedKeys.delete(key);
    }
  }
}

/**
 * Retorna quantas keys de um servidor estão em cooldown.
 * Útil para UI (mostrar "2/3 keys em cooldown").
 */
export function getExhaustedCount(
  server: ServerEntry,
): number {
  let count = 0;
  for (let i = 0; i < server.apiKeyCount; i++) {
    if (isKeyExhausted(server.id, i)) count++;
  }
  return count;
}

/**
 * Verifica se um erro HTTP indica rate limit (para ativar failover).
 */
export function isRateLimitError(status: number): boolean {
  return status === 429 || status === 401;
}
