import React, {useState, useEffect, useCallback} from 'react';
import {StatusBar, View, BackHandler} from 'react-native';
import {AppSettings, Message} from './types';
import {loadSettings} from './data/appSettings';
import {ChatScreen} from './screens/ChatScreen';
import {SettingsScreen} from './screens/SettingsScreen';

export default function App() {
  // 'settings' vira overlay — ChatScreen permanece MONTADO por baixo, então
  // estado interno (streaming, thinkingMode, input, abortController) sobrevive
  // a abrir/fechar settings. Antes era render condicional `? : ` que desmontava
  // o Chat e destruia esse estado a cada troca de aba (bug do "botão de enviar
  // resetando pra mic quando volto do settings").
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    loadSettings().then(setSettings);
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

  if (!settings) {
    return <View style={{flex: 1, backgroundColor: '#0d1117'}} />;
  }

  return (
    <View style={{flex: 1, backgroundColor: '#0d1117'}}>
      <StatusBar
        backgroundColor="#0d1117"
        barStyle="light-content"
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
