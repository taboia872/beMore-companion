/**
 * CRUD de ModelEntry no MMKV.
 *
 * Os modelos são armazenados como um array JSON numa única chave do MMKV.
 * Cada modelo tem FK serverId → ServerEntry.id.
 */

import {MMKV} from 'react-native-mmkv';
import 'react-native-get-random-values';
import {ModelEntry} from '../types';
import {uuidv4} from '../utils/uuid';
import {
  isVisionModel,
  isSttModel,
  isTtsModel,
  isAnyToAnyModel,
} from '../utils/modelCapabilities';

const storage = new MMKV();
const MODELS_KEY = '@bemore_models';

/**
 * Detecta se um modelId é de geração de imagem.
 * Padrões conhecidos: modelos de image gen emOpenAI-compat e Gemini.
 */
function isImageGenModel(id: string): boolean {
  const lower = id.toLowerCase();
  const IMAGE_GEN_PATTERNS = [
    'dall-e',          // openai/dall-e-3 (deprecated), gpt-image
    'gpt-image',       // gpt-image-2 (OpenAI)
    'imagen',          // Google Imagen
    'image-gen',       // genérico
    'flux',            // black-forest-labs/flux
    'sdxl',            // stability/sdxl
    'stable-diffusion', // stable-diffusion
    'sd3',             // stable-diffusion-3
    'sd-',             // sd-1.5, sd-xl, etc
    'kolors',          // kwai-kolors
    'playground',      // playground-v2.5
    'gemini-3.1-flash-image',  // Gemini image gen
    'gemini-3-pro-image',
    'gemini-flash-image',
    'gemini-pro-image',
    'nano-banana',     // Gemini Nano Banana
  ];
  return IMAGE_GEN_PATTERNS.some(p => lower.includes(p));
}

/**
 * Lê todos os modelos cadastrados.
 */
export function getAllModels(): ModelEntry[] {
  const raw = storage.getString(MODELS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ModelEntry[];
  } catch (e) {
    console.warn('[modelDb] Failed to parse models', e);
    return [];
  }
}

/**
 * Busca um modelo pelo ID do registro (ModelEntry.id, não modelId).
 */
export function getModel(id: string): ModelEntry | null {
  return getAllModels().find(m => m.id === id) ?? null;
}

/**
 * Busca um modelo pelo modelId (API id) dentro de um servidor específico.
 */
export function getModelByServerAndModelId(
  serverId: string,
  modelId: string,
): ModelEntry | null {
  return (
    getAllModels().find(m => m.serverId === serverId && m.modelId === modelId) ??
    null
  );
}

/**
 * Retorna todos os modelos de um servidor.
 */
export function getModelsByServer(serverId: string): ModelEntry[] {
  return getAllModels().filter(m => m.serverId === serverId);
}

/**
 * Retorna todos os modelos visíveis (não-hidden).
 */
export function getVisibleModels(): ModelEntry[] {
  return getAllModels().filter(m => !m.isHidden);
}

/**
 * Retorna todos os modelos favoritos e visíveis.
 */
export function getFavoriteModels(): ModelEntry[] {
  return getAllModels().filter(m => m.isFavorite && !m.isHidden);
}

/**
 * Cria ou atualiza um modelo.
 */
export function saveModel(model: ModelEntry): void {
  const models = getAllModels();
  const idx = models.findIndex(m => m.id === model.id);
  if (idx >= 0) {
    models[idx] = model;
  } else {
    models.push(model);
  }
  storage.set(MODELS_KEY, JSON.stringify(models));
}

/**
 * Atualiza campos parciais de um modelo (merge).
 */
export function patchModel(id: string, patch: Partial<ModelEntry>): void {
  const model = getModel(id);
  if (!model) return;
  saveModel({...model, ...patch});
}

/**
 * Deleta um modelo pelo ID do registro.
 */
export function deleteModel(id: string): void {
  const models = getAllModels().filter(m => m.id !== id);
  storage.set(MODELS_KEY, JSON.stringify(models));
}

/**
 * Deleta TODOS os modelos de um servidor (cascade delete).
 */
export function deleteModelsByServer(serverId: string): void {
  const models = getAllModels().filter(m => m.serverId !== serverId);
  storage.set(MODELS_KEY, JSON.stringify(models));
}

/**
 * Sincroniza a lista de modelos de um servidor com o resultado de um fetch.
 *
 * - Novos modelIds (não estavam no catálogo) → cria ModelEntry com
 *   badges auto-detectadas.
 * - Existentes → atualiza lastFetchedAt.
 * - ModelIds que sumiram da API → marca isHidden = true (soft delete,
 *   não deleta para preservar favoritos/config do usuário).
 *
 * Retorna { added: number, updated: number, hidden: number }.
 */
export function syncModelsFromFetch(
  serverId: string,
  fetchedIds: string[],
): {added: number; updated: number; hidden: number} {
  const existing = getModelsByServer(serverId);
  const existingMap = new Map(existing.map(m => [m.modelId, m]));
  const fetchedSet = new Set(fetchedIds);

  let added = 0;
  let updated = 0;
  let hidden = 0;

  // Novos: cria entries com badges auto-detectadas
  for (const modelId of fetchedIds) {
    if (!existingMap.has(modelId)) {
      const entry: ModelEntry = {
        id: uuidv4(),
        serverId,
        modelId,
        isVision: isVisionModel(modelId),
        isStt: isSttModel(modelId),
        isTts: isTtsModel(modelId),
        isAnyToAny: isAnyToAnyModel(modelId),
        isImageGen: isImageGenModel(modelId),
        isFavorite: false,
        isHidden: false,
        isUserHidden: false,
        lastFetchedAt: Date.now(),
      };
      saveModel(entry);
      added++;
    }
  }

  // Existentes: atualiza timestamp + verifica se precisa re-desocultar
  for (const m of existing) {
    if (fetchedSet.has(m.modelId)) {
      m.lastFetchedAt = Date.now();
      // Se estava hidden mas voltou a aparecer no fetch, re-desoculta
      if (m.isHidden) {
        m.isHidden = false;
      }
      saveModel(m);
      updated++;
    } else if (!m.isHidden) {
      // Sumiu da API: marca hidden
      m.isHidden = true;
      saveModel(m);
      hidden++;
    }
  }

  return {added, updated, hidden};
}
