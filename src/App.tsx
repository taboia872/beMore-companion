import React, {useState, useEffect} from 'react';
import {AppSettings} from './types';
import {loadSettings} from './data/appSettings';
import {ChatScreen} from './screens/ChatScreen';
import {SettingsScreen} from './screens/SettingsScreen';

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
