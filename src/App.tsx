import React, {useState, useEffect, useCallback} from 'react';
import {StatusBar, View, BackHandler} from 'react-native';
import {AppSettings, AppSettingsV2, Message, ServerEntry, ModelEntry} from './types';
import {loadSettingsV2, migrateToV2, patchSettingsV2} from './data/appSettings';
import {getAllServers, getServer} from './data/serverDb';
import {getModel} from './data/modelDb';
import {loadApiKey} from './data/keychainDb';
import {ChatScreen} from './screens/ChatScreen';
import {SettingsScreen} from './screens/SettingsScreen';
import {OnboardingScreen} from './screens/OnboardingScreen';
import {getTheme} from './utils/theme';

export default function App() {
  // 'settings' vira overlay — ChatScreen permanece MONTADO por baixo, então
  // estado interno (streaming, thinkingMode, input, abortController) sobrevive
  // a abrir/fechar settings. Antes era render condicional `? : ` que desmontava
  // o Chat e destruia esse estado a cada troca de aba (bug do "botão de enviar
  // resetando pra mic quando volto do settings").
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsV2, setSettingsV2] = useState<AppSettingsV2 | null>(null);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  // servidor/modelo ativo resolvidos do V2 (para construir AppSettings legado)
  const [activeServer, setActiveServer] = useState<ServerEntry | null>(null);
  const [activeModel, setActiveModel] = useState<ModelEntry | null>(null);
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    (async () => {
      // Tenta migrar settings legado → V2 (roda uma vez, idempotente)
      const v2 = await migrateToV2();
      setSettingsV2(v2);

      // Verifica se precisa onboarding: não migrou OU não tem servidores
      const servers = getAllServers();
      if (!v2.migrated || servers.length === 0) {
        setNeedsOnboarding(true);
        return;
      }

      // resolve servidor e modelo ativos do V2
      const {server, model, apiKey: key} = await resolveActiveFromV2(v2);

      // Carrega settings legado (ainda usado por ChatScreen/SettingsScreen)
      // construído a partir do V2 (ponte de compatibilidade)
      const legacy = buildLegacyFromV2(v2, server, model, key);
      setSettings(legacy);
    })();
  }, []);

  /**
   * Resolve servidor e modelo ativos do V2, carrega API key do Keychain.
   * Retorna a apiKey para uso imediato (sem esperar re-render).
   */
  const resolveActiveFromV2 = async (
    v2: AppSettingsV2,
  ): Promise<{server: ServerEntry | null; model: ModelEntry | null; apiKey: string}> => {
    const server = v2.activeServerId ? getServer(v2.activeServerId) : null;
    const model = v2.activeModelId ? getModel(v2.activeModelId) : null;
    setActiveServer(server);
    setActiveModel(model);

    let key = '';
    if (server && server.apiKeyCount > 0) {
      key = await loadApiKey(server.id, server.activeKeyIndex);
    }
    setApiKey(key);
    return {server, model, apiKey: key};
  };

  /**
   * Constrói AppSettings legado a partir de AppSettingsV2 + ServerEntry + ModelEntry.
   * Esta é a ponte de compatibilidade — permite que ChatScreen/SettingsScreen
   * funcionem sem refatoração, lendo do novo sistema V2.
   */
  const buildLegacyFromV2 = (
    v2: AppSettingsV2,
    server: ServerEntry | null,
    model: ModelEntry | null,
    key?: string,
  ): AppSettings => {
    // Resolve STT override: modelo e servidor
    const sttModel = v2.activeSttModelId ? getModel(v2.activeSttModelId) : null;
    const sttServer = v2.sttServerId ? getServer(v2.sttServerId) : null;

    // Resolve TTS override: modelo e servidor
    const ttsModel = v2.activeTtsModelId ? getModel(v2.activeTtsModelId) : null;
    const ttsServer = v2.ttsServerId ? getServer(v2.ttsServerId) : null;

    return {
      systemPrompt: v2.systemPrompt,
      theme: v2.theme,
      sttMode: v2.sttMode,
      sttModelPath: v2.sttModelPath,
      sttOnlineModel: sttModel?.modelId ?? '',
      sttServerOverride: sttServer?.baseUrl ?? '',
      ttsOnlineModel: ttsModel?.modelId ?? '',
      ttsServerOverride: ttsServer?.baseUrl ?? '',
      ttsVoice: v2.ttsVoice,
      ttsAutoPlay: v2.ttsAutoPlay,
      streamingEnabled: v2.streamingEnabled,
      llm: {
        provider: 'localhost',
        baseUrl: server?.baseUrl ?? '',
        apiKey: key ?? apiKey,
        model: model?.modelId ?? '',
        serverFormat: server?.format,
      },
    };
  };

  // Intercepta o botão "Voltar" físico do Android: se settings aberto, fecha
  // o overlay; caso contrario deixa o sistema fazer (nada / sair).
  useEffect(() => {
    const handler = () => {
      if (settingsOpen) {
        setSettingsOpen(false);
        return true; // consome o back
      }
      return false; // deixa o SO decidir
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => sub.remove();
  }, [settingsOpen]);

  const updateMessages = useCallback(
    (updater: (prev: Message[]) => Message[]) => {
      setMessages(prev => updater(prev));
    },
    [],
  );

  // Onboarding: primeira abertura sem servidores
  if (needsOnboarding) {
    return (
      <OnboardingScreen
        onConclude={() => {
          setNeedsOnboarding(false);
          // Recarrega settings V2 + resolve ativos
          const v2 = loadSettingsV2();
          setSettingsV2(v2);
          resolveActiveFromV2(v2).then(({server, model, apiKey: key}) => {
            const legacy = buildLegacyFromV2(v2, server, model, key);
            setSettings(legacy);
          });
        }}
      />
    );
  }

  if (!settings) {
    return <View style={{flex: 1, backgroundColor: '#0d1117'}} />;
  }

  const appTheme = getTheme(settings.theme);

  return (
    <View style={{flex: 1, backgroundColor: appTheme.bg}}>
      <StatusBar
        backgroundColor={appTheme.bg}
        barStyle={appTheme.statusBar}
        translucent={false}
      />
      {/* Chat SEMPRE montado — estado persiste entre overlay abas. */}
      <ChatScreen
        settings={settings}
        messages={messages}
        setMessages={updateMessages}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {/* Settings renderizado como overlay absolute por cima do chat.
          Quando fechado, renderiza null (não ocupa memória visual). */}
      {settingsOpen && (
        <SettingsScreen
          settingsV2={settingsV2!}
          onChangeV2={(patch: Partial<AppSettingsV2>) => {
            // Aplica patch ao V2 (MMKV) e atualiza estado
            const updated = patchSettingsV2(patch);
            setSettingsV2(updated);
            // Se mudou servidor ou modelo ativo, recarrega apiKey e reconstrói legacy
            if (patch.activeServerId !== undefined || patch.activeModelId !== undefined) {
              const s = updated.activeServerId ? getServer(updated.activeServerId) : null;
              const m = updated.activeModelId ? getModel(updated.activeModelId) : null;
              loadApiKey(s?.id ?? '', s?.activeKeyIndex ?? 0).then(k => {
                setApiKey(k);
                const legacy = buildLegacyFromV2(updated, s, m, k);
                setSettings(legacy);
              });
            } else {
              // Só mudou settings gerais (theme, prompt, etc) — reconstrói legacy
              const s = updated.activeServerId ? getServer(updated.activeServerId) : null;
              const m = updated.activeModelId ? getModel(updated.activeModelId) : null;
              const legacy = buildLegacyFromV2(updated, s, m);
              setSettings(legacy);
            }
          }}
          onClose={() => {
            setSettingsOpen(false);
            // Após fechar settings, recarrega V2 e reconstrói legacy
            const v2 = loadSettingsV2();
            setSettingsV2(v2);
            resolveActiveFromV2(v2).then(({server, model, apiKey: key}) => {
              const legacy = buildLegacyFromV2(v2, server, model, key);
              setSettings(legacy);
            });
          }}
        />
      )}
    </View>
  );
}
