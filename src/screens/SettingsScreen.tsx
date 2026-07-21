import React, {useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import {AppSettings, LlmProvider} from '../types';
import {saveSettings} from '../data/appSettings';

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
}

export function SettingsScreen({settings, onChange}: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);

  const updateLlm = (patch: Partial<AppSettings['llm']>) =>
    setDraft({...draft, llm: {...draft.llm, ...patch}});

  const save = async () => {
    await saveSettings(draft);
    onChange(draft);
    Alert.alert('Salvo', 'Configurações salvas.');
  };

  return (
    <ScrollView contentContainerStyle={s.container}>
      <Text style={s.title}>Configurações</Text>

      <Text style={s.section}>LLM</Text>
      <View style={s.row}>
        <TouchableOpacity
          style={[s.tab, draft.llm.provider === 'localhost' && s.tabActive]}
          onPress={() => updateLlm({provider: 'localhost' as LlmProvider})}>
          <Text style={s.tabText}>Localhost</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tab, draft.llm.provider === 'local' && s.tabActive]}
          onPress={() => updateLlm({provider: 'local' as LlmProvider})}>
          <Text style={s.tabText}>Local (Device)</Text>
        </TouchableOpacity>
      </View>

      {draft.llm.provider === 'localhost' ? (
        <>
          <Text style={s.label}>URL do servidor</Text>
          <TextInput
            style={s.input}
            value={draft.llm.baseUrl}
            placeholder="http://192.168.0.10:11434/v1"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={v => updateLlm({baseUrl: v})}
          />
          <Text style={s.hint}>Ollama, LM Studio, llama.cpp server, etc.</Text>

          <Text style={s.label}>API Key (opcional)</Text>
          <TextInput
            style={s.input}
            value={draft.llm.apiKey}
            placeholder="Bearer token"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            onChangeText={v => updateLlm({apiKey: v})}
          />

          <Text style={s.label}>Modelo</Text>
          <TextInput
            style={s.input}
            value={draft.llm.model}
            placeholder="llama3, qwen2.5, etc"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={v => updateLlm({model: v})}
          />
        </>
      ) : (
        <>
          <Text style={s.hint}>
            Modelo GGUF no device (llama.rn). Download na tela principal.
          </Text>
          <Text style={s.label}>Caminho do modelo</Text>
          <TextInput
            style={s.input}
            value={draft.llm.localModelPath ?? ''}
            placeholder="/data/.../models/model.gguf"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={v => updateLlm({localModelPath: v})}
          />
        </>
      )}

      <Text style={s.section}>System Prompt</Text>
      <TextInput
        style={[s.input, s.textarea]}
        value={draft.systemPrompt}
        multiline
        numberOfLines={4}
        onChangeText={v => setDraft({...draft, systemPrompt: v})}
      />

      <TouchableOpacity style={s.btn} onPress={save}>
        <Text style={s.btnText}>Salvar</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: {padding: 24, paddingBottom: 60},
  title: {fontSize: 24, fontWeight: 'bold', color: '#fff', marginBottom: 24},
  section: {
    fontSize: 14,
    fontWeight: '700',
    color: '#8b949e',
    marginTop: 24,
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  row: {flexDirection: 'row', gap: 8},
  tab: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#161b22',
    alignItems: 'center',
  },
  tabActive: {backgroundColor: '#1f6feb'},
  tabText: {color: '#fff', fontWeight: '600'},
  label: {fontSize: 13, color: '#8b949e', marginBottom: 6, marginTop: 16},
  input: {
    backgroundColor: '#161b22',
    color: '#fff',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
  },
  textarea: {minHeight: 96, textAlignVertical: 'top'},
  hint: {fontSize: 12, color: '#6e7681', marginTop: 6},
  btn: {
    backgroundColor: '#238636',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 32,
  },
  btnText: {color: '#fff', fontWeight: '700', fontSize: 16},
});
