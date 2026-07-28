import React, {useState} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  SafeAreaView,
  StatusBar,
  ActivityIndicator,
  Modal,
  FlatList,
} from 'react-native';
import Icon from '@react-native-vector-icons/material-icons';
import {AppSettings, LlmProvider} from '../types';
import {saveSettings} from '../data/appSettings';
import {shortModelName} from '../utils/modelName';

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onBack: () => void;
}

interface RemoteModel {
  id: string;
}

export function SettingsScreen({settings, onChange, onBack}: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);

  // Estado do fetch de modelos
  const [fetchingModels, setFetchingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [showModelsModal, setShowModelsModal] = useState(false);

  const updateLlm = (patch: Partial<AppSettings['llm']>) =>
    setDraft({...draft, llm: {...draft.llm, ...patch}});

  const save = async () => {
    try {
      await saveSettings(draft);
      onChange(draft);
      Alert.alert('Salvo', 'Configurações salvas.');
    } catch (e) {
      Alert.alert('Erro ao salvar', (e as Error).message ?? String(e));
    }
  };

  /**
   * Busca modelos disponíveis no servidor (endpoint /models — OpenAI, Ollama, LM Studio, llama.cpp).
   * URL base precisa estar preenchida. Em caso de erro, exibe mensagem.
   */
  const fetchModels = async () => {
    if (!draft.llm.baseUrl?.trim()) {
      Alert.alert('URL vazia', 'Preencha a URL do servidor antes de buscar modelos.');
      return;
    }
    setFetchingModels(true);
    try {
      const url = `${draft.llm.baseUrl.replace(/\/$/, '')}/models`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...(draft.llm.apiKey && {Authorization: `Bearer ${draft.llm.apiKey}`}),
        },
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }
      const data = await response.json();
      const models: RemoteModel[] = data?.data ?? data?.models ?? [];
      const ids = models
        .map(m => m.id)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) {
        Alert.alert('Vazio', 'Servidor respondeu, mas nenhum modelo encontrado.');
        return;
      }
      setAvailableModels(ids);
      setShowModelsModal(true);
    } catch (e) {
      Alert.alert('Falha ao buscar', (e as Error).message ?? String(e));
    } finally {
      setFetchingModels(false);
    }
  };

  const pickModel = (id: string) => {
    updateLlm({model: id});
    setShowModelsModal(false);
  };

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar
        backgroundColor="#0d1117"
        barStyle="light-content"
        translucent={false}
      />

      {/* Cabeçalho com botão voltar */}
      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={s.backBtn}>
          <Icon name="arrow-back" size={24} color="#e6edf3" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Configurações</Text>
      </View>

      <ScrollView contentContainerStyle={s.container}>
        {/* Seção LLM */}
        <Text style={s.section}>LLM</Text>
        <View style={s.row}>
          <TouchableOpacity
            style={[s.tab, draft.llm.provider === 'localhost' && s.tabActive]}
            onPress={() => updateLlm({provider: 'localhost' as LlmProvider})}>
            <Icon
              name="dns"
              size={18}
              color={draft.llm.provider === 'localhost' ? '#fff' : '#8b949e'}
            />
            <Text
              style={[
                s.tabText,
                draft.llm.provider === 'localhost' && s.tabTextActive,
              ]}>
              Localhost
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tab, draft.llm.provider === 'local' && s.tabActive]}
            onPress={() => updateLlm({provider: 'local' as LlmProvider})}>
            <Icon
              name="smartphone"
              size={18}
              color={draft.llm.provider === 'local' ? '#fff' : '#8b949e'}
            />
            <Text
              style={[s.tabText, draft.llm.provider === 'local' && s.tabTextActive]}>
              No dispositivo
            </Text>
          </TouchableOpacity>
        </View>

        {draft.llm.provider === 'localhost' ? (
          <>
            <Text style={s.label}>URL do servidor</Text>
            <TextInput
              style={s.input}
              value={draft.llm.baseUrl}
              placeholder="http://192.168.0.10:11434/v1"
              placeholderTextColor="#aab2bc"
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
              placeholderTextColor="#aab2bc"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              onChangeText={v => updateLlm({apiKey: v})}
            />

            <Text style={s.label}>Modelo</Text>
            <View style={s.modelRow}>
              <TextInput
                style={[s.input, s.modelInput]}
                value={draft.llm.model}
                placeholder="llama3, qwen2.5, etc"
                placeholderTextColor="#aab2bc"
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={v => updateLlm({model: v})}
              />
              <TouchableOpacity
                style={s.fetchBtn}
                onPress={fetchModels}
                disabled={fetchingModels}>
                {fetchingModels ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Icon name="search" size={20} color="#fff" />
                )}
              </TouchableOpacity>
            </View>
            <Text style={s.hint}>
              Toque no ícone de busca para listar modelos disponíveis no servidor.
            </Text>
          </>
        ) : (
          <>
            <Text style={s.hint}>
              Modelo GGUF no dispositivo (llama.rn). Download na tela principal.
            </Text>
            <Text style={s.label}>Caminho do modelo</Text>
            <TextInput
              style={s.input}
              value={draft.llm.localModelPath ?? ''}
              placeholder="/data/.../models/model.gguf"
              placeholderTextColor="#aab2bc"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={v => updateLlm({localModelPath: v})}
            />
          </>
        )}

        {/* Seção STT */}
        <Text style={s.section}>STT (Whisper)</Text>
        <Text style={s.hint}>
          Caminho do modelo Whisper para transcrição de voz on-device. Deixe vazio
          para desativar. Ex: ggml-tiny.bin (~75 MB).
        </Text>
        <TextInput
          style={s.input}
          value={draft.sttModelPath ?? ''}
          placeholder="/data/data/com.bemore.companion/files/models/ggml-tiny.bin"
          placeholderTextColor="#aab2bc"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={v => setDraft({...draft, sttModelPath: v})}
        />

        {/* System prompt */}
        <Text style={s.section}>System Prompt</Text>
        <TextInput
          style={[s.input, s.textarea]}
          value={draft.systemPrompt}
          multiline
          numberOfLines={4}
          onChangeText={v => setDraft({...draft, systemPrompt: v})}
        />

        {/* Botao salvar */}
        <TouchableOpacity style={s.saveBtn} onPress={save}>
          <Icon name="check" size={20} color="#fff" />
          <Text style={s.saveBtnText}>Salvar</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Modal com lista de modelos encontrados */}
      <Modal visible={showModelsModal} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Modelos disponíveis</Text>
            <FlatList
              data={availableModels}
              keyExtractor={(item, idx) => `${item}-${idx}`}
              renderItem={({item}) => (
                <TouchableOpacity
                  style={s.modelItem}
                  onPress={() => pickModel(item)}>
                  <Icon name="memory" size={20} color="#58a6ff" />
                  <Text style={s.modelItemText} numberOfLines={1}>{shortModelName(item)}</Text>
                  {item === draft.llm.model && (
                    <Icon name="check" size={20} color="#3fb950" />
                  )}
                </TouchableOpacity>
              )}
              style={{maxHeight: 320}}
            />
            <TouchableOpacity
              style={s.modalCloseBtn}
              onPress={() => setShowModelsModal(false)}>
              <Text style={s.modalCloseText}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
    backgroundColor: '#0d1117',
  },
  backBtn: {
    padding: 8,
    marginRight: 8,
  },
  headerTitle: {
    color: '#e6edf3',
    fontSize: 20,
    fontWeight: '700',
  },
  container: {padding: 24, paddingBottom: 60},
  section: {
    fontSize: 13,
    fontWeight: '700',
    color: '#8b949e',
    marginTop: 24,
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  row: {flexDirection: 'row', gap: 8},
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#161b22',
  },
  tabActive: {backgroundColor: '#1f6feb'},
  tabText: {color: '#8b949e', fontWeight: '600', fontSize: 14},
  tabTextActive: {color: '#fff'},
  label: {fontSize: 13, color: '#8b949e', marginBottom: 6, marginTop: 16},
  input: {
    backgroundColor: '#161b22',
    color: '#e6edf3',
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
  },
  textarea: {minHeight: 96, textAlignVertical: 'top'},
  hint: {fontSize: 12, color: '#8b949e', marginTop: 6},
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modelInput: {flex: 1},
  fetchBtn: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: '#238636',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#238636',
    paddingVertical: 14,
    borderRadius: 10,
    marginTop: 32,
  },
  saveBtnText: {color: '#fff', fontWeight: '700', fontSize: 16},
  /* Modal */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    backgroundColor: '#161b22',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#21262d',
  },
  modalTitle: {
    color: '#e6edf3',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  modelItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
  },
  modelItemText: {
    flex: 1,
    color: '#e6edf3',
    fontSize: 15,
  },
  modalCloseBtn: {
    marginTop: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCloseText: {
    color: '#58a6ff',
    fontWeight: '600',
    fontSize: 15,
  },
});
