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
import {saveSettings, loadApiKeyForServer, saveApiKeyForServer} from '../data/appSettings';
import {shortModelName} from '../utils/modelName';
import {getModelBadges, ModelCapability} from '../utils/modelCapabilities';
import {getTheme, ThemeColors} from '../utils/theme';

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
  id?: string;
  name?: string; // Google AI Studio usa "name" em vez de "id" (formato "models/gemini-2.0-flash")
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
  {name: 'Google AI Studio', url: 'https://generativelanguage.googleapis.com/v1beta', icon: 'auto-awesome', hasFreeModels: true},
  {name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', icon: 'route', hasFreeModels: true},
  {name: 'Ollama Cloud', url: 'https://ollama.com/v1', icon: 'cloud-queue', hasFreeModels: true},
  {name: 'Groq', url: 'https://api.groq.com/openai/v1', icon: 'bolt', hasFreeModels: true},
  {name: 'NVIDIA', url: 'https://integrate.api.nvidia.com/v1', icon: 'memory', hasFreeModels: true},
  {name: 'AIHorde', url: 'https://oai.aihorde.net/v1', icon: 'groups', hasFreeModels: true},
];

// Valor especial que identifica a opção "Personalizado" no dropdown.
const CUSTOM_SERVER = '__custom__';

interface CardProps {
  title: string;
  icon: string; // MaterialIconsIconName válido
  children: React.ReactNode;
  /** Se true, começa expandido (default: false). */
  defaultExpanded?: boolean;
  /** Tema ativo — indica as cores a usar no card. */
  theme: ThemeColors;
}

/**
 * Container visual p/ agrupar uma seção de configurações (item 6).
 * Agora com suporte a accordion: header clicável expande/colapsa o conteúdo.
 */
function Card({title, icon, children, defaultExpanded = false, theme}: CardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const cardStyles = getStyles(theme);
  return (
    <View style={cardStyles.card}>
      <TouchableOpacity
        style={cardStyles.cardHeader}
        activeOpacity={0.7}
        onPress={() => setExpanded(v => !v)}>
        <Icon name={icon as any} size={18} color={theme.accent} />
        <Text style={cardStyles.cardTitle}>{title}</Text>
        <Icon
          name={expanded ? 'expand-less' : 'expand-more'}
          size={22}
          color={theme.textSecondary}
          style={cardStyles.cardChevron}
        />
      </TouchableOpacity>
      {expanded && <View style={cardStyles.cardBody}>{children}</View>}
    </View>
  );
}

export function SettingsScreen({settings, onChange, onClose}: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);

  // Tema dinâmico (claro/escuro) — aplica a todas as cores desta tela.
  const theme = getTheme(settings.theme);
  const s = getStyles(theme);

  const [fetchingModels, setFetchingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  // Quando true, o modal de modelos está selecionando modelo STT (não LLM).
  const [sttPickerMode, setSttPickerMode] = useState(false);
  const [ttsPickerMode, setTtsPickerMode] = useState(false);
  const [showModelsModal, setShowModelsModal] = useState(false);
  // Filtro de modelos no modal: 'all' | 'free' | 'stt' | 'tts'
  const [modelFilter, setModelFilter] = useState<'all' | 'free' | 'stt' | 'tts'>('all');

  // Dropdown de servidor: qual preset está selecionado, ou CUSTOM_SERVER.
  // Derivado da URL atual — se a URL match um preset, seleciona ele; senão, custom.
  const [serverDropdownOpen, setServerDropdownOpen] = useState(false);

  // Detecta qual preset corresponde à URL atual (match de hostname).
  // Se a URL é vazia E o usuário ainda não escolheu nada, assume o primeiro
  // preset como default. Mas se o usuário limpou a URL ao selecionar
  // "Personalizado", retorna CUSTOM_SERVER (URL vazia = custom em branco).
  const detectPreset = (url: string): string => {
    if (!url?.trim()) {
      // URL vazia: se o draft já tem provider=localhost com URL vazia,
      // assumimos que é "Personalizado" (usuário limpou deliberadamente).
      return CUSTOM_SERVER;
    }
    const lower = url.toLowerCase().replace(/\/+$/, '');
    for (const p of SERVER_PRESETS) {
      // Compara por hostname (ex: api.groq.com) para tolerar paths diferentes
      const presetHost = p.url.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
      const urlHost = lower.replace(/^https?:\/\//, '').split('/')[0];
      if (urlHost === presetHost) return p.url;
    }
    return CUSTOM_SERVER;
  };

  const selectedPreset = detectPreset(draft.llm.baseUrl);

  const selectPreset = async (presetUrl: string) => {
    setServerDropdownOpen(false);

    if (presetUrl === CUSTOM_SERVER) {
      // Se mudando para personalizado, limpa a URL p/ o usuário digitar.
      // Mas se já era custom e apenas re-selecionando, mantém.
      if (selectedPreset !== CUSTOM_SERVER) {
        // Antes de trocar, salva a chave atual associada ao servidor atual.
        if (draft.llm.apiKey && draft.llm.baseUrl) {
          await saveApiKeyForServer(draft.llm.baseUrl, draft.llm.apiKey);
        }
        updateLlm({baseUrl: '', apiKey: ''});
      }
      return;
    }

    // Antes de trocar, salva a chave atual associada ao servidor atual.
    if (draft.llm.apiKey && draft.llm.baseUrl && draft.llm.baseUrl !== presetUrl) {
      await saveApiKeyForServer(draft.llm.baseUrl, draft.llm.apiKey);
    }

    // Troca para o novo servidor e carrega a chave salva (se existir).
    const savedKey = await loadApiKeyForServer(presetUrl);
    updateLlm({baseUrl: presetUrl, apiKey: savedKey});
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

  /**
   * Helper central p/ aplicar mudanças imediatamente. Atualiza o draft
   * local, propaga onChange (síncrono) e persiste em background via
   * saveSettings (sem await — não bloqueia a UI). Substitui o antigo
   * fluxo draft → save() com botão Salvar.
   */
  const update = (patch: Partial<AppSettings>) => {
    setDraft(prev => {
      const next: AppSettings = {
        ...prev,
        ...patch,
        llm: patch.llm ? {...prev.llm, ...patch.llm} : prev.llm,
      };
      onChange(next);
      saveSettings(next); // persistência em background (não precisa await)
      return next;
    });
  };

  /** Atalho p/ atualizar apenas campos de llm — mantém ergonomia do `updateLlm`. */
  const updateLlm = (patch: Partial<AppSettings['llm']>) =>
    setDraft(prev => {
      const next: AppSettings = {
        ...prev,
        llm: {...prev.llm, ...patch},
      };
      onChange(next);
      saveSettings(next);
      return next;
    });

  const fetchModels = async () => {
    if (!draft.llm.baseUrl?.trim()) {
      Alert.alert('URL vazia', 'Preencha a URL do servidor antes de buscar modelos.');
      return;
    }
    setFetchingModels(true);
    setModelFilter('all'); // reset filtro ao buscar novos modelos
    setSttPickerMode(false); // busca de modelos LLM, não STT
    setTtsPickerMode(false); // nem TTS
    try {
      const baseUrl = draft.llm.baseUrl.replace(/\/+$/, '');

      // Cada servidor pode ter um endpoint diferente para listar modelos.
      // Google AI Studio: API nativa v1beta/models com ?key=API_KEY (não Bearer)
      // OpenRouter: endpoint público com pricing info.
      // Demais: /models padrão OpenAI-compatível (Bearer auth).
      let url: string;
      let useQueryParamKey = false;
      if (baseUrl.includes('openrouter.ai')) {
        url = 'https://openrouter.ai/api/v1/models';
      } else if (baseUrl.includes('generativelanguage.googleapis.com')) {
        url = `${baseUrl}/models`;
        useQueryParamKey = true; // Gemini nativo usa ?key= em vez de Bearer
      } else {
        url = `${baseUrl}/models`;
      }

      const headers: Record<string, string> = {};
      if (draft.llm.apiKey && !useQueryParamKey) {
        headers['Authorization'] = `Bearer ${draft.llm.apiKey}`;
      }
      if (useQueryParamKey && draft.llm.apiKey) {
        url = `${url}?key=${encodeURIComponent(draft.llm.apiKey)}`;
      }
      const response = await fetch(url, {
        method: 'GET',
        headers,
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }
      const data = await response.json();
      const models: RemoteModel[] = data?.data ?? data?.models ?? [];
      const ids = models
        .map(m => {
          // Google AI Studio usa campo "name" (formato "models/gemini-2.0-flash")
          // em vez de "id". Removemos o prefixo "models/" para ficar limpo.
          const raw = m.id ?? m.name ?? '';
          if (typeof raw !== 'string') return '';
          return raw.replace(/^models\//, '');
        })
        .filter((id): id is string => id.length > 0);
      if (ids.length === 0) {
        Alert.alert('Vazio', 'Servidor respondeu, mas nenhum modelo encontrado.');
        return;
      }
      // Ordena alfabeticamente (case-insensitive).
      ids.sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
      setAvailableModels(ids);
      setShowModelsModal(true);
    } catch (e) {
      Alert.alert('Falha ao buscar', (e as Error).message ?? String(e));
    } finally {
      setFetchingModels(false);
    }
  };

  const pickModel = (id: string) => {
    if (ttsPickerMode) {
      update({ttsOnlineModel: id});
    } else if (sttPickerMode) {
      update({sttOnlineModel: id});
    } else {
      updateLlm({model: id});
    }
    setShowModelsModal(false);
    setSttPickerMode(false);
    setTtsPickerMode(false);
  };

  /**
   * Detecta se um modelo é gratuito. A detecção varia por servidor:
   * - OpenRouter: modelos gratuitos têm `:free` no id
   * - Google AI Studio: todos os gemini-* são free tier
   * - Groq: TODOS os modelos são gratuitos
   * - AIHorde: TODOS os modelos são gratuitos (crowdsourced)
   * - HuggingFace: assume pago (precisa de API key, modelos paid)
   * - NVIDIA: presume free tier (NVIDIA oferece free credits)
   * - Ollama Cloud: modelos free tier incluem gemma3:1b, gemma4:31b,
   *   gpt-oss:20b, gpt-oss:120b, nemotron-3-super:cloud, qwen3-vl:235b-cloud,
   *   qwen3-coder:480b-cloud (lista pode expandir — verificar ollama.com/search?c=cloud)
   * - Outros/llama.cpp: assume pago (modelos locais não têm noção de free)
   */
  const isFreeModel = (id: string): boolean => {
    const lower = id.toLowerCase();
    // OpenRouter: convenção :free no id
    if (lower.endsWith(':free')) return true;
    // Google AI Studio: todos os gemini-* são free tier
    if (lower.startsWith('gemini-') || lower.startsWith('models/gemini-')) return true;
    // Detecta pelo servidor selecionado
    const hostname = detectPreset(draft.llm.baseUrl);
    if (hostname === SERVER_PRESETS.find(p => p.name === 'Groq')?.url) return true;
    if (hostname === SERVER_PRESETS.find(p => p.name === 'AIHorde')?.url) return true;
    // Ollama Cloud: apenas modelos free tier
    if (hostname === SERVER_PRESETS.find(p => p.name === 'Ollama Cloud')?.url) {
      return [
        'gemma3:1b',
        'gemma4:31b',
        'gpt-oss:20b',
        'gpt-oss:120b',
        'nemotron-3-super:cloud',
        'qwen3-vl:235b-cloud',
        'qwen3-coder:480b-cloud',
      ].includes(lower);
    }
    return false;
  };

  // Modelos filtrados conforme seleção do filtro no modal
  const hasCapability = (id: string, cap: ModelCapability): boolean => {
    return getModelBadges(id).some(b => b.type === cap);
  };

  const filteredModels = availableModels.filter(id => {
    if (modelFilter === 'all') {
      // No modo STT picker, "Todos" mostra só modelos STT (pré-filtro)
      if (sttPickerMode) return hasCapability(id, 'stt');
      // No modo TTS picker, "Todos" mostra só modelos TTS (pré-filtro)
      if (ttsPickerMode) return hasCapability(id, 'tts');
      return true;
    }
    if (modelFilter === 'free') return isFreeModel(id);
    if (modelFilter === 'stt') return hasCapability(id, 'stt');
    if (modelFilter === 'tts') return hasCapability(id, 'tts');
    return true;
  });

  // Conta quantos grátis, STT, e TTS existem para exibir nos botões
  const freeCount = availableModels.filter(isFreeModel).length;
  const sttCount = availableModels.filter(id => hasCapability(id, 'stt')).length;
  const ttsCount = availableModels.filter(id => hasCapability(id, 'tts')).length;

  return (
    <View style={s.overlay}>
      <StatusBar
        backgroundColor={theme.bg}
        barStyle={theme.statusBar}
        translucent={false}
      />
      <SafeAreaView style={s.safe}>

      <View style={s.header}>
        <TouchableOpacity onPress={onClose} style={s.backBtn}>
          <Icon name="arrow-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Configurações</Text>
      </View>

      <ScrollView contentContainerStyle={s.container}>
        {/* Card: Provedor + dados conforme tipo (item 6 — agrupado) */}
        <Card title="Modelo de Linguagem" icon="memory" defaultExpanded={true} theme={theme}>
          {/* Tabs Online / Local — texto encurtado (item 6) */}
          <View style={s.row}>
            <TouchableOpacity
              style={[s.tab, draft.llm.provider === 'localhost' && s.tabActive]}
              onPress={() => updateLlm({provider: 'localhost' as LlmProvider})}>
              <Icon
                name="cloud-queue"
                size={18}
                color={draft.llm.provider === 'localhost' ? theme.accentText : theme.textSecondary}
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
                color={draft.llm.provider === 'local' ? theme.accentText : theme.textSecondary}
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
                  color={theme.accent}
                />
                <Text style={s.dropdownBtnText} numberOfLines={1}>
                  {selectedServerName()}
                </Text>
                <Icon
                  name={serverDropdownOpen ? 'expand-less' : 'expand-more'}
                  size={22}
                  color={theme.textSecondary}
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
                        color={selectedPreset === preset.url ? theme.accent : theme.textSecondary}
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
                      color={selectedPreset === CUSTOM_SERVER ? theme.accent : theme.textSecondary}
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
                    placeholderTextColor={theme.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={v => updateLlm({baseUrl: v})}
                  />
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
                placeholderTextColor={theme.textMuted}
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
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={v => updateLlm({model: v})}
                />
                <TouchableOpacity
                  style={s.fetchBtn}
                  onPress={fetchModels}
                  disabled={fetchingModels}>
                  {fetchingModels ? (
                    <ActivityIndicator size="small" color={theme.accentText} />
                  ) : (
                    <Icon name="search" size={20} color={theme.accentText} />
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
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={v => updateLlm({localModelPath: v})}
              />
            </>
          )}
        </Card>

        {/* Card: Voz (STT) — toggle online/on-device */}
        <Card title="Voz (STT)" icon="mic" theme={theme}>
          {/* Toggle: Online ↔ On-device (Online à esquerda, On-device à direita) */}
          <View style={s.row}>
            <TouchableOpacity
              style={[s.tab, draft.sttMode === 'online' && s.tabActive]}
              onPress={() => update({sttMode: 'online'})}>
              <Icon
                name="cloud-queue"
                size={18}
                color={draft.sttMode === 'online' ? theme.accentText : theme.textSecondary}
              />
              <Text
                style={[
                  s.tabText,
                  draft.sttMode === 'online' && s.tabTextActive,
                ]}>
                Online
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.tab, (draft.sttMode ?? 'on-device') === 'on-device' && s.tabActive]}
              onPress={() => update({sttMode: 'on-device'})}>
              <Icon
                name="smartphone"
                size={18}
                color={(draft.sttMode ?? 'on-device') === 'on-device' ? theme.accentText : theme.textSecondary}
              />
              <Text
                style={[
                  s.tabText,
                  (draft.sttMode ?? 'on-device') === 'on-device' && s.tabTextActive,
                ]}>
                On-device
              </Text>
            </TouchableOpacity>
          </View>

          {(draft.sttMode ?? 'on-device') === 'on-device' ? (
            <>
              <Text style={s.hint}>
                Modelo Whisper GGUF no dispositivo. Deixe vazio para desativar.
                Ex: ggml-tiny.bin (~75 MB).
              </Text>
              <Text style={s.label}>Caminho do modelo</Text>
              <TextInput
                style={s.input}
                value={draft.sttModelPath ?? ''}
                placeholder="/data/data/com.bemore.companion/files/models/ggml-tiny.bin"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={v => update({sttModelPath: v})}
              />
            </>
          ) : (
            <>
              <Text style={s.hint}>
                Transcrição via API online (Groq, OpenAI, etc). Usa o modelo
                selecionado abaixo com o servidor atual{draft.sttServerOverride?.trim() ? ' (override)' : ''}.
              </Text>
              <Text style={s.label}>Modelo STT online</Text>
              <View style={s.modelRow}>
                <TextInput
                  style={[s.input, s.modelInput]}
                  value={draft.sttOnlineModel ?? ''}
                  placeholder="whisper-large-v3, whisper-large-v3-turbo, etc"
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={v => update({sttOnlineModel: v})}
                />
                <TouchableOpacity
                  style={s.fetchBtn}
                  onPress={async () => {
                    // Usa o mesmo fetch de modelos do servidor LLM atual
                    if (!draft.llm.baseUrl?.trim() && !draft.sttServerOverride?.trim()) {
                      Alert.alert('URL vazia', 'Preencha a URL do servidor antes de buscar modelos.');
                      return;
                    }
                    setFetchingModels(true);
                    setModelFilter('all');
                    try {
                      const baseUrl = (draft.sttServerOverride?.trim() || draft.llm.baseUrl).replace(/\/+$/, '');
                      let url: string;
                      let useQueryParamKey = false;
                      if (baseUrl.includes('openrouter.ai')) {
                        url = 'https://openrouter.ai/api/v1/models';
                      } else if (baseUrl.includes('generativelanguage.googleapis.com')) {
                        url = `${baseUrl}/models`;
                        useQueryParamKey = true;
                      } else {
                        url = `${baseUrl}/models`;
                      }
                      const apiKey = draft.sttServerOverride?.trim()
                        ? await loadApiKeyForServer(draft.sttServerOverride.trim())
                        : draft.llm.apiKey ?? '';
                      const headers: Record<string, string> = {};
                      if (apiKey && !useQueryParamKey) {
                        headers['Authorization'] = `Bearer ${apiKey}`;
                      }
                      if (useQueryParamKey && apiKey) {
                        url = `${url}?key=${encodeURIComponent(apiKey)}`;
                      }
                      const response = await fetch(url, {
                        method: 'GET',
                        headers,
                      });
                      if (!response.ok) {
                        const errText = await response.text();
                        throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
                      }
                      const data = await response.json();
                      const models: RemoteModel[] = data?.data ?? data?.models ?? [];
                      const ids = models
                        .map(m => {
                          const raw = m.id ?? m.name ?? '';
                          if (typeof raw !== 'string') return '';
                          return raw.replace(/^models\//, '');
                        })
                        .filter((id): id is string => id.length > 0);
                      if (ids.length === 0) {
                        Alert.alert('Vazio', 'Servidor respondeu, mas nenhum modelo encontrado.');
                        return;
                      }
                      ids.sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
                      // Pré-filtra STT para focar em modelos de transcrição
                      setAvailableModels(ids);
                      setSttPickerMode(true);
                      setShowModelsModal(true);
                    } catch (e) {
                      Alert.alert('Falha ao buscar', (e as Error).message ?? String(e));
                    } finally {
                      setFetchingModels(false);
                    }
                  }}
                  disabled={fetchingModels}>
                  {fetchingModels ? (
                    <ActivityIndicator size="small" color={theme.accentText} />
                  ) : (
                    <Icon name="search" size={20} color={theme.accentText} />
                  )}
                </TouchableOpacity>
              </View>
              {draft.sttOnlineModel?.trim() && (
                <View style={s.sttModelSelected}>
                  <Icon name="check-circle" size={14} color="#f0883e" />
                  <Text style={s.sttModelSelectedText}>
                    {draft.sttOnlineModel}
                  </Text>
                </View>
              )}

              {/* Override de servidor STT (opcional) */}
              <Text style={s.label}>Servidor STT (opcional)</Text>
              <TextInput
                style={s.input}
                value={draft.sttServerOverride ?? ''}
                placeholder="Deixe vazio para usar o mesmo do chat"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={v => update({sttServerOverride: v})}
              />
              <Text style={s.hint}>
                Por padrão usa a URL+API Key do servidor de chat. Preencha
                para usar um servidor diferente só para STT (ex: Groq mesmo
                que o chat use outro).
              </Text>
            </>
          )}
        </Card>

        {/* Card: Voz (TTS) — síntese de áudio via API online */}
        <Card title="Voz (TTS)" icon="volume-up" theme={theme}>
          {(() => {
            const ttsBaseUrl = (draft.ttsServerOverride?.trim() || draft.llm.baseUrl || '');
            const isGemini = ttsBaseUrl.includes('generativelanguage.googleapis.com');
            return (
              <>
                <Text style={s.hint}>
                  {isGemini
                    ? 'Síntese de voz via Google AI Studio (Gemini). Retorna áudio PCM 24kHz (convertido para WAV).'
                    : 'Síntese de voz via API online (Groq TTS, OpenAI TTS, etc).'}{' '}
                  Usa o modelo selecionado abaixo com o servidor
                  atual{draft.ttsServerOverride?.trim() ? ' (override)' : ''}.
                </Text>
                <Text style={s.label}>Modelo TTS</Text>
                <View style={s.modelRow}>
                  <TextInput
                    style={[s.input, s.modelInput]}
                    value={draft.ttsOnlineModel ?? ''}
                    placeholder={isGemini ? 'gemini-2.5-flash-preview-tts' : 'tts-1, tts-1-hd, etc'}
                    placeholderTextColor={theme.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={v => update({ttsOnlineModel: v})}
                  />
                  <TouchableOpacity
                    style={s.fetchBtn}
                    onPress={async () => {
                      if (!draft.llm.baseUrl?.trim() && !draft.ttsServerOverride?.trim()) {
                        Alert.alert('URL vazia', 'Preencha a URL do servidor antes de buscar modelos.');
                        return;
                      }
                      setFetchingModels(true);
                      setModelFilter('all');
                      try {
                        const baseUrl = (draft.ttsServerOverride?.trim() || draft.llm.baseUrl).replace(/\/+$/, '');
                        let url: string;
                        let useQueryParamKey = false;
                        if (baseUrl.includes('openrouter.ai')) {
                          url = 'https://openrouter.ai/api/v1/models';
                        } else if (baseUrl.includes('generativelanguage.googleapis.com')) {
                          url = `${baseUrl}/models`;
                          useQueryParamKey = true;
                        } else {
                          url = `${baseUrl}/models`;
                        }
                        const apiKey = draft.ttsServerOverride?.trim()
                          ? await loadApiKeyForServer(draft.ttsServerOverride.trim())
                          : draft.llm.apiKey ?? '';
                        const headers: Record<string, string> = {};
                        if (apiKey && !useQueryParamKey) {
                          headers['Authorization'] = `Bearer ${apiKey}`;
                        }
                        if (useQueryParamKey && apiKey) {
                          url = `${url}?key=${encodeURIComponent(apiKey)}`;
                        }
                        const response = await fetch(url, {method: 'GET', headers});
                        if (!response.ok) {
                          const errText = await response.text();
                          throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
                        }
                        const data = await response.json();
                        const models: RemoteModel[] = data?.data ?? data?.models ?? [];
                        const ids = models
                          .map(m => {
                            const raw = m.id ?? m.name ?? '';
                            if (typeof raw !== 'string') return '';
                            return raw.replace(/^models\//, '');
                          })
                          .filter((id): id is string => id.length > 0);
                        if (ids.length === 0) {
                          Alert.alert('Vazio', 'Servidor respondeu, mas nenhum modelo encontrado.');
                          return;
                        }
                        ids.sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
                        setAvailableModels(ids);
                        setTtsPickerMode(true);
                        setShowModelsModal(true);
                      } catch (e) {
                        Alert.alert('Falha ao buscar', (e as Error).message ?? String(e));
                      } finally {
                        setFetchingModels(false);
                      }
                    }}
                    disabled={fetchingModels}>
                    {fetchingModels ? (
                      <ActivityIndicator size="small" color={theme.accentText} />
                    ) : (
                      <Icon name="search" size={20} color={theme.accentText} />
                    )}
                  </TouchableOpacity>
                </View>
                {draft.ttsOnlineModel?.trim() && (
                  <View style={s.sttModelSelected}>
                    <Icon name="check-circle" size={14} color="#2dd4bf" />
                    <Text style={s.sttModelSelectedText}>
                      {draft.ttsOnlineModel}
                    </Text>
                  </View>
                )}

                {/* Voz */}
                <Text style={s.label}>Voz</Text>
                <TextInput
                  style={s.input}
                  value={draft.ttsVoice ?? ''}
                  placeholder={isGemini ? 'Kore, Charon, Aoede, Fenrir...' : 'alloy, nova, shimmer, echo, fable, onyx'}
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={v => update({ttsVoice: v})}
                />
                <Text style={s.hint}>
                  {isGemini
                    ? 'Vozes Gemini: Achernar, Aoede, Charon, Kore, Fenrir, Leda, Puck, Zephyr, etc. Deixe vazio para Kore (padrão).'
                    : 'Vozes podem variar por provedor. OpenAI/Groq: alloy, nova, shimmer, echo, fable, onyx. Deixe vazio para alloy.'}
                </Text>

                {/* Override de servidor TTS (opcional) */}
                <Text style={s.label}>Servidor TTS (opcional)</Text>
                <TextInput
                  style={s.input}
                  value={draft.ttsServerOverride ?? ''}
                  placeholder="Deixe vazio para usar o mesmo do chat"
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={v => update({ttsServerOverride: v})}
                />
                <Text style={s.hint}>
                  Por padrão usa a URL+API Key do servidor de chat. Preencha
                  para usar um servidor diferente só para TTS.
                </Text>
              </>
            );
          })()}
        </Card>

        {/* Card: Misc — agrupa Prompt do Sistema + Streaming de Respostas */}
        <Card title="Misc" icon="settings" theme={theme}>
          {/* Sub-seção: Prompt do Sistema */}
          <Text style={[s.subSectionTitle, {marginTop: 0}]}>Prompt do Sistema</Text>
          <TextInput
            style={[s.input, s.textarea]}
            value={draft.systemPrompt}
            multiline
            numberOfLines={4}
            onChangeText={v => update({systemPrompt: v})}
          />
          <Text style={s.hint}>
            Instruções base que definem o comportamento do assistant. Aplicadas ao
            início de toda conversa.
          </Text>

          {/* Sub-seção: Tema da Interface */}
          <Text style={s.subSectionTitle}>Tema da Interface</Text>
          <View style={{flexDirection: 'row', gap: 8, marginBottom: 6}}>
            <TouchableOpacity
              style={[
                s.themeOption,
                (draft.theme ?? 'dark') === 'dark' && s.themeOptionActive,
              ]}
              onPress={() => update({theme: 'dark'})}>
              <Icon name="dark-mode" size={20} color={(draft.theme ?? 'dark') === 'dark' ? theme.accent : theme.textSecondary} />
              <Text style={[
                s.themeOptionLabel,
                (draft.theme ?? 'dark') === 'dark' && s.themeOptionLabelActive,
              ]}>Escuro</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                s.themeOption,
                draft.theme === 'light' && s.themeOptionActive,
              ]}
              onPress={() => update({theme: 'light'})}>
              <Icon name="light-mode" size={20} color={draft.theme === 'light' ? theme.accent : theme.textSecondary} />
              <Text style={[
                s.themeOptionLabel,
                draft.theme === 'light' && s.themeOptionLabelActive,
              ]}>Claro</Text>
            </TouchableOpacity>
          </View>

          {/* Sub-seção: Streaming de Respostas */}
          <Text style={s.subSectionTitle}>Streaming de Respostas</Text>
          <TouchableOpacity
            style={s.toggleRow}
            onPress={() =>
              update({streamingEnabled: !draft.streamingEnabled})
            }>
            <Text style={s.toggleLabel}>
              Receber respostas em tempo real
            </Text>
            <Icon
              name={streamingCheckboxIcon(draft.streamingEnabled === true)}
              size={24}
              color={draft.streamingEnabled === true ? '#3fb950' : theme.textSecondary}
            />
          </TouchableOpacity>
          <Text style={s.hint}>
            Quando ativo, os tokens aparecem conforme chegam (SSE). Desative se
            seu servidor não suporta streaming ou prefere aguardar a resposta
            completa de uma vez.
          </Text>
        </Card>
      </ScrollView>

      {/* Modal de seleção de modelos */}
      <Modal visible={showModelsModal} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>
                {ttsPickerMode
                  ? 'Modelos TTS disponíveis'
                  : sttPickerMode
                  ? 'Modelos STT disponíveis'
                  : 'Modelos disponíveis'}
              </Text>
              <TouchableOpacity onPress={() => setShowModelsModal(false)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="close" size={22} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Filtro: Todos | Gratuitos | STT | TTS */}
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
                <Icon name="volunteer-activism" size={14} color={modelFilter === 'free' ? theme.accentText : '#3fb950'} />
                <Text style={[s.filterBtnText, modelFilter === 'free' && s.filterBtnTextActive]}>
                  Grátis ({freeCount})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.filterBtn, modelFilter === 'stt' && s.filterBtnSttActive]}
                onPress={() => setModelFilter('stt')}>
                <Icon name="mic" size={14} color={modelFilter === 'stt' ? theme.accentText : '#f0883e'} />
                <Text style={[s.filterBtnText, modelFilter === 'stt' && s.filterBtnTextActive]}>
                  STT ({sttCount})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.filterBtn, modelFilter === 'tts' && s.filterBtnTtsActive]}
                onPress={() => setModelFilter('tts')}>
                <Icon name="volume-up" size={14} color={modelFilter === 'tts' ? theme.accentText : '#2dd4bf'} />
                <Text style={[s.filterBtnText, modelFilter === 'tts' && s.filterBtnTextActive]}>
                  TTS ({ttsCount})
                </Text>
              </TouchableOpacity>
            </View>

            <FlatList
              data={filteredModels}
              keyExtractor={(item, idx) => `${item}-${idx}`}
              renderItem={({item}) => {
                const badges = getModelBadges(item);
                return (
                  <TouchableOpacity
                    style={s.modelItem}
                    onPress={() => pickModel(item)}>
                    <Icon name="memory" size={20} color={isFreeModel(item) ? '#3fb950' : theme.accent} />
                    <Text style={s.modelItemText} numberOfLines={1}>
                      {shortModelName(item)}
                    </Text>
                    {badges.map(badge => {
                      if (badge.type === 'vision') {
                        return (
                          <View key="vision" style={s.visionBadge}>
                            <Icon name="visibility" size={10} color="#a371f7" />
                            <Text style={s.visionBadgeText}>VISÃO</Text>
                          </View>
                        );
                      }
                      if (badge.type === 'stt') {
                        return (
                          <View key="stt" style={s.sttBadge}>
                            <Icon name="mic" size={10} color="#f0883e" />
                            <Text style={s.sttBadgeText}>STT</Text>
                          </View>
                        );
                      }
                      if (badge.type === 'tts') {
                        return (
                          <View key="tts" style={s.ttsBadge}>
                            <Icon name="volume-up" size={10} color="#2dd4bf" />
                            <Text style={s.ttsBadgeText}>TTS</Text>
                          </View>
                        );
                      }
                      // anyToAny
                      return (
                        <View key="any" style={s.anyBadge}>
                          <Icon name="all-inclusive" size={10} color="#d2a8ff" />
                          <Text style={s.anyBadgeText}>ANY→ANY</Text>
                        </View>
                      );
                    })}
                    {isFreeModel(item) && (
                      <View style={s.freeBadge}>
                        <Text style={s.freeBadgeText}>FREE</Text>
                      </View>
                    )}
                    {item === (ttsPickerMode ? draft.ttsOnlineModel : sttPickerMode ? draft.sttOnlineModel : draft.llm.model) && (
                      <Icon name="check" size={20} color="#3fb950" />
                    )}
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={s.emptyText}>
                  {modelFilter === 'free'
                    ? 'Nenhum modelo gratuito encontrado.'
                    : modelFilter === 'stt'
                    ? 'Nenhum modelo STT encontrado.'
                    : modelFilter === 'tts'
                    ? 'Nenhum modelo TTS encontrado.'
                    : 'Nenhum modelo encontrado.'}
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

function getStyles(t: ThemeColors) {
  return StyleSheet.create({
  // Overlay absolute fullscreen — cobre o ChatScreen por baixo (que continua
  // montado, preservando o estado). Animação de entrada pode ser adicionada
  // depois via Animated.
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: t.bg,
    zIndex: 10,
  },
  safe: {
    flex: 1,
    backgroundColor: t.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: t.border,
    backgroundColor: t.bg,
  },
  backBtn: {
    padding: 8,
    marginRight: 8,
  },
  headerTitle: {
    color: t.text,
    fontSize: 20,
    fontWeight: '700',
  },
  container: {padding: 16, paddingBottom: 60, gap: 14},
  /* Card — container que agrupa uma seção (item 6) */
  card: {
    backgroundColor: t.bgSurface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border,
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 0,
  },
  cardChevron: {
    marginLeft: 'auto',
  },
  cardBody: {
    marginTop: 12,
  },
  subSectionTitle: {
    color: t.text,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 14,
    marginBottom: 6,
  },
  cardTitle: {
    color: t.text,
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
    backgroundColor: t.bg,
  },
  tabActive: {backgroundColor: t.userBubble},
  tabText: {color: t.textSecondary, fontWeight: '600', fontSize: 14},
  tabTextActive: {color: t.accentText},
  label: {fontSize: 13, color: t.textSecondary, marginBottom: 6, marginTop: 14},
  /* Dropdown de servidor */
  dropdownBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: t.bg,
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: t.border,
  },
  dropdownBtnText: {
    flex: 1,
    color: t.text,
    fontSize: 15,
    fontWeight: '600',
  },
  dropdownList: {
    marginTop: 4,
    backgroundColor: t.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: t.border,
    overflow: 'hidden',
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: t.bgSurface,
  },
  dropdownItemActive: {
    backgroundColor: t.bgSurface,
  },
  dropdownItemText: {
    flex: 1,
    color: t.text,
    fontSize: 14,
  },
  dropdownItemTextActive: {
    color: t.accent,
    fontWeight: '600',
  },
  urlDisplay: {
    fontSize: 11,
    color: t.textMuted,
    marginTop: 6,
    fontFamily: 'monospace',
  },
  input: {
    backgroundColor: t.bg,
    color: t.text,
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    borderWidth: 1,
    borderColor: t.border,
  },
  textarea: {minHeight: 96, textAlignVertical: 'top'},
  hint: {fontSize: 12, color: t.textSecondary, marginTop: 6},
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
  toggleLabel: {color: t.text, fontSize: 15, flex: 1, paddingRight: 12},
  /* Theme selector options */
  themeOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: t.bg,
    borderWidth: 1,
    borderColor: t.border,
  },
  themeOptionActive: {
    borderColor: t.accent,
    backgroundColor: t.bgSurface,
  },
  themeOptionLabel: {
    color: t.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  themeOptionLabelActive: {
    color: t.accent,
  },
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
    backgroundColor: t.bgSurface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: t.border,
  },
  modalTitle: {
    color: t.text,
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
    backgroundColor: t.bg,
    borderWidth: 1,
    borderColor: t.border,
  },
  filterBtnActive: {
    backgroundColor: t.userBubble,
    borderColor: t.userBubble,
  },
  filterBtnFreeActive: {
    backgroundColor: '#238636',
    borderColor: '#238636',
  },
  filterBtnSttActive: {
    backgroundColor: '#bc4c00',
    borderColor: '#bc4c00',
  },
  filterBtnTtsActive: {
    backgroundColor: '#0d9488',
    borderColor: '#0d9488',
  },
  filterBtnText: {
    color: t.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  filterBtnTextActive: {
    color: t.accentText,
  },
  freeBadge: {
    backgroundColor: '#238636',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  freeBadgeText: {
    color: t.accentText,
    fontSize: 10,
    fontWeight: '700',
  },
  visionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2d1b69',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    gap: 3,
    borderWidth: 1,
    borderColor: '#6e40c9',
  },
  visionBadgeText: {
    color: '#d2a8ff',
    fontSize: 10,
    fontWeight: '700',
  },
  sttBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#3d1f00',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    gap: 3,
    borderWidth: 1,
    borderColor: '#bc4c00',
  },
  sttBadgeText: {
    color: '#f0883e',
    fontSize: 10,
    fontWeight: '700',
  },
  ttsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#042f2e',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    gap: 3,
    borderWidth: 1,
    borderColor: '#0d9488',
  },
  ttsBadgeText: {
    color: '#2dd4bf',
    fontSize: 10,
    fontWeight: '700',
  },
  anyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2d1b69',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    gap: 3,
    borderWidth: 1,
    borderColor: '#8957e5',
  },
  anyBadgeText: {
    color: '#d2a8ff',
    fontSize: 9,
    fontWeight: '700',
  },
  emptyText: {
    color: t.textSecondary,
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
    borderBottomColor: t.border,
  },
  modelItemText: {
    flex: 1,
    color: t.text,
    fontSize: 15,
  },
  modalCloseBtn: {
    marginTop: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCloseText: {
    color: t.accent,
    fontWeight: '600',
    fontSize: 15,
  },
  sttModelSelected: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#3d1f00',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bc4c00',
  },
  sttModelSelectedText: {
    color: '#f0883e',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
});
}
