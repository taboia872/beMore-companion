import React, {useState, useEffect, useCallback} from 'react';
import {StatusBar, View, BackHandler} from 'react-native';
import {AppSettings, AppSettingsV2, Message} from './types';
import {loadSettings, loadSettingsV2, migrateToV2} from './data/appSettings';
import {getAllServers} from './data/serverDb';
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

  useEffect(() => {
    (async () => {
      // Tenta migrar settings legado → V2 (roda uma vez, idempotente)
      const v2 = await migrateToV2();
      setSettingsV2(v2);

      // Carrega settings legado (ainda usado por ChatScreen/SettingsScreen)
      const legacy = await loadSettings();
      setSettings(legacy);

      // Verifica se precisa onboarding: não migrou OU não tem servidores
      const servers = getAllServers();
      if (!v2.migrated || servers.length === 0) {
        setNeedsOnboarding(true);
      }
    })();
  }, []);

  // Intercepta o botão "Voltar" físico do Android: se settings aberto, fecha
  // o overlay; caso contrario deixa o sistema fazer (nada / sair). Sem isso,
  // o Android finaliza a activity porque não há back-stack interno na app.
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
          // Recarrega settings após onboarding
          const v2 = loadSettingsV2();
          setSettingsV2(v2);
          loadSettings().then(setSettings);
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
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </View>
  );
}
