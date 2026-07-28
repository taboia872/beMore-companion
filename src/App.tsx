import React, {useState, useEffect} from 'react';
import {StatusBar, View} from 'react-native';
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
        <SettingsScreen settings={settings} onChange={setSettings} />
      ) : (
        <ChatScreen
          settings={settings}
          onOpenSettings={() => setScreen('settings')}
        />
      )}
    </View>
  );
}
