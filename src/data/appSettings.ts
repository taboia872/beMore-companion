import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings } from '../types';

const STORAGE_KEY = '@bemore_settings';

export const DEFAULT_SETTINGS: AppSettings = {
  systemPrompt: 'You are a helpful assistant.',
  llm: {
    provider: 'localhost',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: 'llama3',
  },
  sttModelPath: '',  // vazio: STT desabilitado até usuário apontar para modelo Whisper
  thinkingEnabled: false,  // toggle do modo thinking no input do chat (item 7)
};

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) return {...DEFAULT_SETTINGS, ...JSON.parse(raw)};
  } catch (e) {
    console.warn('loadSettings error', e);
  }
  return DEFAULT_SETTINGS;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('saveSettings error', e);
  }
}
