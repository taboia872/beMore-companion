import React, {useState, useEffect} from 'react';
import {AppSettings} from './src/types';
import {loadSettings} from './src/data/appSettings';
import {ChatScreen} from './src/screens/ChatScreen';
import {SettingsScreen} from './src/screens/SettingsScreen';

type Screen = 'chat' | 'settings';

export default function App() {
  const [screen, setScreen] = useState<Screen>('chat');
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  if (!settings) return null;

  if (screen === 'settings') {
    return (
      <SettingsScreen
        settings={settings}
        onChange={setSettings}
      />
    );
  }

  return (
    <ChatScreen
      settings={settings}
      onOpenSettings={() => setScreen('settings')}
    />
  );
}
