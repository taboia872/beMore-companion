/**
 * useServerManager — hook central que resolve AppSettingsV2 + MMKV catalogs
 * em objetos prontos para a UI (ChatScreen, SettingsScreen).
 *
 * Substitui o fluxo legado onde App.tsx passava `AppSettings` (AsyncStorage)
 * para as telas. Agora a fonte de verdade é AppSettingsV2 (MMKV) + os
 * catálogos de servidores e modelos (também MMKV).
 *
 * O hook lê sincronamente (MMKV é sync) e retorna tudo que a UI precisa:
 * - settingsV2: AppSettingsV2 completo
 * - activeServer: ServerEntry resolvido de activeServerId
 * - activeModel: ModelEntry resolvido de activeModelId
 * - apiKey: API key lida do Keychain (async, pode ser '' no primeiro render)
 * - servers: lista de todos os servidores cadastrados
 * - models: modelos do servidor ativo
 * - updateV2: helper para patch SettingsV2
 */

import {useState, useEffect, useCallback} from 'react';
import {AppSettingsV2, ServerEntry, ModelEntry} from '../types';
import {
  loadSettingsV2,
  patchSettingsV2 as patchV2,
} from '../data/appSettings';
import {getAllServers, getServer} from '../data/serverDb';
import {
  getAllModels,
  getModelsByServer,
  getModel,
  getFavoriteModels,
} from '../data/modelDb';
import {loadApiKey} from '../data/keychainDb';
import {ServerEntry as _SE} from '../types';

export interface ServerManagerState {
  settingsV2: AppSettingsV2;
  activeServer: ServerEntry | null;
  activeModel: ModelEntry | null;
  apiKey: string;
  servers: ServerEntry[];
  models: ModelEntry[]; // modelos do servidor ativo
  favoriteModels: ModelEntry[]; // favoritos globais (todos os servidores)
  // STT/TTS overrides
  sttServer: ServerEntry | null;
  sttModel: ModelEntry | null;
  ttsServer: ServerEntry | null;
  ttsModel: ModelEntry | null;
}

export function useServerManager(): ServerManagerState & {
  updateV2: (patch: Partial<AppSettingsV2>) => void;
  refresh: () => void;
} {
  const [version, setVersion] = useState(0);
  const [apiKey, setApiKey] = useState('');

  // Lê tudo do MMKV (síncrono)
  const settingsV2 = loadSettingsV2();
  const servers = getAllServers();

  // Resolve servidor ativo
  const activeServer = settingsV2.activeServerId
    ? getServer(settingsV2.activeServerId)
    : null;

  // Resolve modelo ativo
  const activeModel = settingsV2.activeModelId
    ? getModel(settingsV2.activeModelId)
    : null;

  // Modelos do servidor ativo
  const models = activeServer ? getModelsByServer(activeServer.id) : [];

  // Favoritos globais
  const favoriteModels = getFavoriteModels();

  // STT overrides
  const sttServer = settingsV2.sttServerId
    ? getServer(settingsV2.sttServerId)
    : null;
  const sttModel = settingsV2.activeSttModelId
    ? getModel(settingsV2.activeSttModelId)
    : null;

  // TTS overrides
  const ttsServer = settingsV2.ttsServerId
    ? getServer(settingsV2.ttsServerId)
    : null;
  const ttsModel = settingsV2.activeTtsModelId
    ? getModel(settingsV2.activeTtsModelId)
    : null;

  // Carrega API key do servidor ativo (async — Keychain)
  useEffect(() => {
    let cancelled = false;
    if (activeServer && activeServer.apiKeyCount > 0) {
      loadApiKey(activeServer.id, activeServer.activeKeyIndex).then(key => {
        if (!cancelled) setApiKey(key);
      });
    } else {
      setApiKey('');
    }
    return () => {
      cancelled = true;
    };
  }, [activeServer?.id, activeServer?.activeKeyIndex, activeServer?.apiKeyCount, version]);

  const updateV2 = useCallback((patch: Partial<AppSettingsV2>) => {
    patchV2(patch);
    setVersion(v => v + 1); // força re-render
  }, []);

  const refresh = useCallback(() => {
    setVersion(v => v + 1);
  }, []);

  return {
    settingsV2,
    activeServer,
    activeModel,
    apiKey,
    servers,
    models,
    favoriteModels,
    sttServer,
    sttModel,
    ttsServer,
    ttsModel,
    updateV2,
    refresh,
  };
}
