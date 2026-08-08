import React, {useState, useRef, useEffect} from 'react';
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

/**
 * Nome do ícone do checkbox de streaming conforme estado ligado/desligado.
 * as const em cada último p/ satisfazer tipagem estrita do prop name do <Icon>
 * (v13 scoped exige union MaterialIconsIconName; ternary nao aceita as const).
 */
function streamingCheckboxIcon(on: boolean) {
  if (on) return 'check-box' as const;
  return 'check-box-outline-blank' as const;
}

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onClose: () => void;
}

interface RemoteModel {
  id: string;
}

/**
 * Presets de servidores online compatíveis com OpenAI API.
 * O usuário seleciona um da lista e a URL é preenchida automaticamente.
 * A última opção "Personalizado" abre um campo de texto livre.
 */
interface ServerPreset {
  name: string;
  url: string;
  /** Nome do ícone MaterialIconsIconName p/ o botão do dropdown. */
  icon: string;
  /** Se true, o servidor oferece modelos gratuitos (filtro relevante no modal). */
  hasFreeModels?: boolean;
}

const SERVER_PRESETS: ServerPreset[] = [
  {name: 'Google AI Studio', url: 'https://generativelanguage.googleapis.com/v1beta/openai/', icon: 'auto-awesome', hasFreeModels: true},
  {name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', icon: 'route', hasFreeModels: true},
  {name: 'Ollama Cloud', url: 'https://ollama.com/v1', icon: 'cloud-queue'},
  {name: 'HuggingFace', url: 'https://router.huggingface.co/v1', icon: 'pets', hasFreeModels: true},
  {name: 'Groq', url: 'https://api.groq.com/openai/v1', icon: 'bolt', hasFreeModels: true},
  {name: 'NVIDIA', url: 'https://integrate.api.nvidia.com/v1', icon: 'memory', hasFreeModels: true},
  {name: 'AIHorde', url: 'https://oai.aihorde.net', icon: 'groups', hasFreeModels: true},
];

// Valor especial que identifica a opção "Personalizado" no dropdown.
const CUSTOM_SERVER = '__custom__';

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

export function SettingsScreen({settings, onChange, onClose}: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);

  const [fetchingModels, setFetchingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [showModelsModal, setShowModelsModal] = useState(false);
  // Filtro de modelos no modal: 'all' | 'free' | 'paid'
  const [modelFilter, setModelFilter] = useState<'all' | 'free' | 'paid'>('all');

  // Dropdown de servidor: qual preset está selecionado, ou CUSTOM_SERVER.
  // Derivado da URL atual — se a URL match um preset, seleciona ele; senão, custom.
  const [serverDropdownOpen, setServerDropdownOpen] = useState(false);

  // Detecta qual preset corresponde à URL atual (match de substring case-insensitive).
  // Se nenhum match, é "Personalizado".
  const detectPreset = (url: string): string => {
    if (!url?.trim()) return SERVER_PRESETS[0].url; // default: primeiro preset
    const lower = url.toLowerCase().replace(/\/$/, '');
    for (const p of SERVER_PRESETS) {
      if (lower === p.url.toLowerCase().replace(/\/$/, '')) return p.url;
    }
    return CUSTOM_SERVER;
  };

  const selectedPreset = detectPreset(draft.llm.baseUrl);

  const selectPreset = (presetUrl: string) => {
    if (presetUrl === CUSTOM_SERVER) {
      // Se mudando para personalizado, limpa a URL p/ o usuário digitar.
      // Mas se já era custom e apenas re-selecionando, mantém.
      if (selectedPreset !== CUSTOM_SERVER) {
        updateLlm({baseUrl: ''});
      }
    } else {
      updateLlm({baseUrl: presetUrl});
    }
    setServerDropdownOpen(false);
  };

  // Nome amigável do servidor selecionado p/ exibir no botão do dropdown.
  const selectedServerName = (): string => {
    if (selectedPreset === CUSTOM_SERVER) return 'Personalizado';
    const preset = SERVER_PRESETS.find(p => p.url === selectedPreset);
    return preset?.name ?? 'Personalizado';
  };

  // Ícone do servidor selecionado p/ exibir no botão do dropdown.
  const selectedServerIcon = (): string => {
    if (selectedPreset === CUSTOM_SERVER) return 'edit';
    const preset = SERVER_PRESETS.find(p => p.url === selectedPreset);
    return preset?.icon ?? 'dns';
  };


  // Toast — balão temporizado que aparece no topo e some sozinho.
  // Substitui o Alert.alert('Salvo', ...) por algo menos intrusivo.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const updateLlm = (patch: Partial<AppSettings['llm']>) =>
    setDraft(d => ({...d, llm: {...d.llm, ...patch}}));

  const save = async () => {
    try {
      await saveSettings(draft);
      onChange(draft);
      showToast('Configurações salvas');
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
    setModelFilter('all'); // reset filtro ao buscar novos modelos
    try {
      const baseUrl = draft.llm.baseUrl.replace(/\/$/, '');

      // Detecta provedores que têm endpoint público de listagem de modelos
      // com metadados de pricing (paid/free). Para esses, usar o endpoint
      // expandido. Para outros, /models padrão OpenAI-compatível.
      let url: string;
      if (baseUrl.includes('openrouter.ai')) {
        url = 'https://openrouter.ai/api/v1/models';
      } else if (baseUrl.includes('generativelanguage.googleapis.com')) {
        url = 'https://generativelanguage.googleapis.com/v1beta/models';
      } else if (baseUrl.includes('huggingface.co')) {
        url = 'https://huggingface.co/api/models?inference=warm&limit=100';
      } else {
        url = `${baseUrl}/models`;
      }

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

  /**
   * Detecta se um modelo é gratuito. Convenções:
   * - OpenRouter: modelos gratuitos têm `:free` no id (ex: "meta-llama/llama-3.2-3b:free")
   * - Google AI Studio: modelos Gemini são gratuitos (tier free)
   * - Groq: todos gratuitos
   * - AIHorde: todos gratuitos (comunidade)
   * - HuggingFace: assume pago (precisa API key, modelos paid)
   * - Outros: assume pago a menos que tenha `:free`
   */
  const isFreeModel = (id: string): boolean => {
    const lower = id.toLowerCase();
    // OpenRouter: convenção :free no id
    if (lower.endsWith(':free')) return true;
    // Google AI Studio: todos os gemini-* são free tier
    if (lower.startsWith('gemini-') || lower.startsWith('models/gemini-')) return true;
    // AIHorde: todos gratuitos
    if (selectedPreset === SERVER_PRESETS.find(p => p.name === 'AIHorde')?.url) return true;
    return false;
  };

  // Modelos filtrados conforme seleção do filtro no modal
  const filteredModels = availableModels.filter(id => {
    if (modelFilter === 'all') return true;
    if (modelFilter === 'free') return isFreeModel(id);
    // 'paid' = tudo que não é free
    return !isFreeModel(id);
  });

  // Conta quantos grátis e pagos existem para exibir nos botões
  const freeCount = availableModels.filter(isFreeModel).length;
  const paidCount = availableModels.length - freeCount;

  return (
    <View style={s.overlay}>
      <StatusBar
        backgroundColor="#0d1117"
        barStyle="light-content"
        translucent={false}
      />
      <SafeAreaView style={s.safe}>

      <View style={s.header}>
        <TouchableOpacity onPress={onClose} style={s.backBtn}>
          <Icon name="arrow-back" size={24} color="#e6edf3" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Configurações</Text>
      </View>

      {/* Toast — balão temporizado que aparece no topo e some em 2.5s */}
      {toast && (
        <View style={s.toastWrap} pointerEvents="none">
          <View style={s.toast}>
            <Icon name="check-circle" size={18} color="#3fb950" />
            <Text style={s.toastText}>{toast}</Text>
          </View>
        </View>
      )}

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
              {/* Dropdown de servidor — presets + opção Personalizado */}
              <Text style={s.label}>Servidor</Text>
              <TouchableOpacity
                style={s.dropdownBtn}
                onPress={() => setServerDropdownOpen(v => !v)}>
                <Icon
                  name={selectedServerIcon() as any}
                  size={20}
                  color="#58a6ff"
                />
                <Text style={s.dropdownBtnText} numberOfLines={1}>
                  {selectedServerName()}
                </Text>
                <Icon
                  name={serverDropdownOpen ? 'expand-less' : 'expand-more'}
                  size={22}
                  color="#8b949e"
                />
              </TouchableOpacity>

              {/* Lista de opções do dropdown */}
              {serverDropdownOpen && (
                <View style={s.dropdownList}>
                  {SERVER_PRESETS.map(preset => (
                    <TouchableOpacity
                      key={preset.url}
                      style={[
                        s.dropdownItem,
                        selectedPreset === preset.url && s.dropdownItemActive,
                      ]}
                      onPress={() => selectPreset(preset.url)}>
                      <Icon
                        name={preset.icon as any}
                        size={18}
                        color={selectedPreset === preset.url ? '#58a6ff' : '#8b949e'}
                      />
                      <Text
                        style={[
                          s.dropdownItemText,
                          selectedPreset === preset.url && s.dropdownItemTextActive,
                        ]}
                        numberOfLines={1}>
                        {preset.name}
                      </Text>
                      {preset.hasFreeModels && (
                        <View style={s.freeBadge}>
                          <Text style={s.freeBadgeText}>FREE</Text>
                        </View>
                      )}
                      {selectedPreset === preset.url && (
                        <Icon name="check" size={18} color="#3fb950" />
                      )}
                    </TouchableOpacity>
                  ))}
                  {/* Opção Personalizado */}
                  <TouchableOpacity
                    style={[
                      s.dropdownItem,
                      selectedPreset === CUSTOM_SERVER && s.dropdownItemActive,
                    ]}
                    onPress={() => selectPreset(CUSTOM_SERVER)}>
                    <Icon
                      name="edit"
                      size={18}
                      color={selectedPreset === CUSTOM_SERVER ? '#58a6ff' : '#8b949e'}
                    />
                    <Text
                      style={[
                        s.dropdownItemText,
                        selectedPreset === CUSTOM_SERVER && s.dropdownItemTextActive,
                      ]}
                      numberOfLines={1}>
                      Personalizado
                    </Text>
                    {selectedPreset === CUSTOM_SERVER && (
                      <Icon name="check" size={18} color="#3fb950" />
                    )}
                  </TouchableOpacity>
                </View>
              )}

              {/* Campo de URL — só visível quando Personalizado */}
              {selectedPreset === CUSTOM_SERVER && (
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
                </>
              )}

              {/* URL do preset selecionado (read-only, informativo) */}
              {selectedPreset !== CUSTOM_SERVER && (
                <Text style={s.urlDisplay} numberOfLines={2}>
                  {selectedPreset}
                </Text>
              )}

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

        {/* Card: Streaming — toggle persistente de respostas em tempo real */}
        <Card title="Streaming de Respostas" icon="stream">
          <TouchableOpacity
            style={s.toggleRow}
            onPress={() =>
              setDraft(d => ({...d, streamingEnabled: !d.streamingEnabled}))
            }>
            <Text style={s.toggleLabel}>
              Receber respostas em tempo real
            </Text>
            <Icon
              name={streamingCheckboxIcon(draft.streamingEnabled === true)}
              size={24}
              color={draft.streamingEnabled === true ? '#3fb950' : '#8b949e'}
            />
          </TouchableOpacity>
          <Text style={s.hint}>
            Quando ativo, os tokens aparecem conforme chegam (SSE). Desative se
            seu servidor não suporta streaming ou prefere aguardar a resposta
            completa de uma vez.
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
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Modelos disponíveis</Text>
              <TouchableOpacity onPress={() => setShowModelsModal(false)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="close" size={22} color="#8b949e" />
              </TouchableOpacity>
            </View>

            {/* Filtro: Todos | Gratuitos | Pagos */}
            <View style={s.filterRow}>
              <TouchableOpacity
                style={[s.filterBtn, modelFilter === 'all' && s.filterBtnActive]}
                onPress={() => setModelFilter('all')}>
                <Text style={[s.filterBtnText, modelFilter === 'all' && s.filterBtnTextActive]}>
                  Todos ({availableModels.length})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.filterBtn, modelFilter === 'free' && s.filterBtnFreeActive]}
                onPress={() => setModelFilter('free')}>
                <Icon name="volunteer-activism" size={14} color={modelFilter === 'free' ? '#fff' : '#3fb950'} />
                <Text style={[s.filterBtnText, modelFilter === 'free' && s.filterBtnTextActive]}>
                  Grátis ({freeCount})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.filterBtn, modelFilter === 'paid' && s.filterBtnPaidActive]}
                onPress={() => setModelFilter('paid')}>
                <Icon name="paid" size={14} color={modelFilter === 'paid' ? '#fff' : '#d29922'} />
                <Text style={[s.filterBtnText, modelFilter === 'paid' && s.filterBtnTextActive]}>
                  Pagos ({paidCount})
                </Text>
              </TouchableOpacity>
            </View>

            <FlatList
              data={filteredModels}
              keyExtractor={(item, idx) => `${item}-${idx}`}
              renderItem={({item}) => (
                <TouchableOpacity
                  style={s.modelItem}
                  onPress={() => pickModel(item)}>
                  <Icon name="memory" size={20} color={isFreeModel(item) ? '#3fb950' : '#58a6ff'} />
                  <Text style={s.modelItemText} numberOfLines={1}>
                    {shortModelName(item)}
                  </Text>
                  {isFreeModel(item) && (
                    <View style={s.freeBadge}>
                      <Text style={s.freeBadgeText}>FREE</Text>
                    </View>
                  )}
                  {item === draft.llm.model && (
                    <Icon name="check" size={20} color="#3fb950" />
                  )}
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={s.emptyText}>
                  {modelFilter === 'free' ? 'Nenhum modelo gratuito encontrado.' : 'Nenhum modelo pago encontrado.'}
                </Text>
              }
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
    </View>
  );
}

const s = StyleSheet.create({
  // Overlay absolute fullscreen — cobre o ChatScreen por baixo (que continua
  // montado, preservando o estado). Animação de entrada pode ser adicionada
  // depois via Animated.
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#0d1117',
    zIndex: 10,
  },
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
  /* Dropdown de servidor */
  dropdownBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0d1117',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#21262d',
  },
  dropdownBtnText: {
    flex: 1,
    color: '#e6edf3',
    fontSize: 15,
    fontWeight: '600',
  },
  dropdownList: {
    marginTop: 4,
    backgroundColor: '#0d1117',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#21262d',
    overflow: 'hidden',
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#161b22',
  },
  dropdownItemActive: {
    backgroundColor: '#161b22',
  },
  dropdownItemText: {
    flex: 1,
    color: '#e6edf3',
    fontSize: 14,
  },
  dropdownItemTextActive: {
    color: '#58a6ff',
    fontWeight: '600',
  },
  urlDisplay: {
    fontSize: 11,
    color: '#6e7681',
    marginTop: 6,
    fontFamily: 'monospace',
  },
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
  /* Toast — balão temporizado no topo */
  toastWrap: {
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 100,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#238636',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  toastText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
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
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  filterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#0d1117',
    borderWidth: 1,
    borderColor: '#21262d',
  },
  filterBtnActive: {
    backgroundColor: '#1f6feb',
    borderColor: '#1f6feb',
  },
  filterBtnFreeActive: {
    backgroundColor: '#238636',
    borderColor: '#238636',
  },
  filterBtnPaidActive: {
    backgroundColor: '#9e6a03',
    borderColor: '#9e6a03',
  },
  filterBtnText: {
    color: '#8b949e',
    fontSize: 12,
    fontWeight: '600',
  },
  filterBtnTextActive: {
    color: '#fff',
  },
  freeBadge: {
    backgroundColor: '#238636',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  freeBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  emptyText: {
    color: '#8b949e',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 24,
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
