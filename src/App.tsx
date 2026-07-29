import React, {useState, useEffect, useCallback} from 'react';
import {StatusBar, View} from 'react-native';
import {AppSettings, Message} from './types';
import {loadSettings} from './data/appSettings';
import {ChatScreen} from './screens/ChatScreen';
import {SettingsScreen} from './screens/SettingsScreen';

type Screen = 'chat' | 'settings';

export default function App() {
  const [screen, setScreen] = useState<Screen>('chat');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // Estado das mensagens vive no App — sobrevive a trocas de aba e navegação.
  // É o padrão React "lift state up": o componente que precisa persistir entre
  // trocas de tela não pode viver dentro de um irmão desmontável.
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

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
      {screen === 'settings' ? (
        <SettingsScreen
          settings={settings}
          onChange={setSettings}
          onBack={() => setScreen('chat')}
        />
      ) : (
        <ChatScreen
          settings={settings}
          messages={messages}
          setMessages={updateMessages}
          onOpenSettings={() => setScreen('settings')}
        />
      )}
    </View>
  );
}
