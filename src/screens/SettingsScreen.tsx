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

interface CardProps {
  title: string;
  icon: string; // MaterialIconsIconName válido
  children: React.ReactNode;
}

/** Container visual p/ agrupar uma seção de configurações (item 6). */
function Card({title, icon, children}: CardProps) {
  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <Icon name={icon as any} size={18} color="#58a6ff" />
        <Text style={s.cardTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

export function SettingsScreen({settings, onChange, onBack}: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);

  const [fetchingModels, setFetchingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [showModelsModal, setShowModelsModal] = useState(false);

  const updateLlm = (patch: Partial<AppSettings['llm']>) =>
    setDraft(d => ({...d, llm: {...d.llm, ...patch}}));

  const save = async () => {
    try {
      await saveSettings(draft);
      onChange(draft);
      Alert.alert('Salvo', 'Configurações salvas.');
    } catch (e) {
      Alert.alert('Erro ao salvar', (e as Error).message ?? String(e));
    }
  };

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

      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={s.backBtn}>
          <Icon name="arrow-back" size={24} color="#e6edf3" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Configurações</Text>
      </View>

      <ScrollView contentContainerStyle={s.container}>
        {/* Card: Provedor + dados conforme tipo (item 6 — agrupado) */}
        <Card title="Modelo de Linguagem" icon="memory">
          {/* Tabs Online / Local — texto encurtado (item 6) */}
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
                Online
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
                style={[
                  s.tabText,
                  draft.llm.provider === 'local' && s.tabTextActive,
                ]}>
                Local
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
        </Card>

        {/* Card: Voz (STT) — item 6 container próprio */}
        <Card title="Voz (STT — Whisper)" icon="mic">
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
        </Card>

        {/* Card: Prompt do Sistema — item 6 container próprio */}
        <Card title="Prompt do Sistema" icon="edit">
          <TextInput
            style={[s.input, s.textarea]}
            value={draft.systemPrompt}
            multiline
            numberOfLines={4}
            onChangeText={v => setDraft({...draft, systemPrompt: v})}
          />
          <Text style={s.hint}>
            Instruções base que definem o comportamento do assistant. Aplicadas ao
            início de toda conversa.
          </Text>
        </Card>

        {/* Card: Modo Thinking — persistência do toggle do item 7 */}
        <Card title="Modo Thinking" icon="psychology">
          <TouchableOpacity
            style={s.toggleRow}
            onPress={() =>
              setDraft(d => ({...d, thinkingEnabled: !d.thinkingEnabled}))
            }>
            <Text style={s.toggleLabel}>
              Ativar modo "pensar" por padrão
            </Text>
            <Icon
              name={draft.thinkingEnabled ? 'check-box' as const : 'check-box-outline-blank' as const}
              size={24}
              color={draft.thinkingEnabled ? '#3fb950' : '#8b949e'}
            />
          </TouchableOpacity>
          <Text style={s.hint}>
            Quando ativo, o botão de thinking no chat começa ligado. Você ainda pode
            alternar durante a conversa.
          </Text>
        </Card>

        {/* Botão salvar */}
        <TouchableOpacity style={s.saveBtn} onPress={save}>
          <Icon name="check" size={20} color="#fff" />
          <Text style={s.saveBtnText}>Salvar</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Modal de seleção de modelos */}
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
                  <Text style={s.modelItemText} numberOfLines={1}>
                    {shortModelName(item)}
                  </Text>
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
  container: {padding: 16, paddingBottom: 60, gap: 14},
  /* Card — container que agrupa uma seção (item 6) */
  card: {
    backgroundColor: '#161b22',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#21262d',
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  cardTitle: {
    color: '#e6edf3',
    fontSize: 15,
    fontWeight: '700',
  },
  row: {flexDirection: 'row', gap: 8, marginBottom: 4},
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#0d1117',
  },
  tabActive: {backgroundColor: '#1f6feb'},
  tabText: {color: '#8b949e', fontWeight: '600', fontSize: 14},
  tabTextActive: {color: '#fff'},
  label: {fontSize: 13, color: '#8b949e', marginBottom: 6, marginTop: 14},
  input: {
    backgroundColor: '#0d1117',
    color: '#e6edf3',
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#21262d',
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
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  toggleLabel: {color: '#e6edf3', fontSize: 15, flex: 1, paddingRight: 12},
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#238636',
    paddingVertical: 14,
    borderRadius: 10,
    marginTop: 12,
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
