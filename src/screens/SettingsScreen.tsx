import React, {useState, useRef} from 'react';
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
  Animated,
  PanResponder,
  Dimensions,
} from 'react-native';
import Icon from '@react-native-vector-icons/material-icons';
import {AppSettingsV2, ServerEntry, ModelEntry} from '../types';
import {
  getAllServers,
  getServer,
  deleteServerCascade,
} from '../data/serverDb';
import {
  getModelsByServer,
  getAllModels,
  getModel,
  patchModel,
  syncModelsFromFetch,
} from '../data/modelDb';
import {loadSettingsV2, patchSettingsV2} from '../data/appSettings';
import {shortModelName, displayModelName} from '../utils/modelName';
import {fetchModels} from '../services/ServerService';
import {loadApiKey, saveApiKey, resetApiKey} from '../data/keychainDb';
import {patchServer} from '../data/serverDb';
import {getModelBadges, ModelCapability} from '../utils/modelCapabilities';
import {getAvailableVoices, testVoice, stopSpeaking, fetchFishAudioVoices} from '../services/TtsService';
import {
  getFishVoices,
  appendFishVoices,
  getFishVoicesLastPage,
  clearFishVoices,
} from '../data/voiceDb';
import {isKeyExhausted, clearServerCooldown} from '../services/KeyRotation';
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
  settingsV2: AppSettingsV2;
  onChangeV2: (patch: Partial<AppSettingsV2>) => void;
  onClose: () => void;
  /** dispara o fluxo de adicionar servidor (monta OnboardingScreen por cima) */
  onAddServer: () => void;
}

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

// --- Helpers para formatar badges ---
// Usa os campos do ModelEntry (que incluem overrides manuais do usuário)
// em vez de apenas getModelBadges (heurística por nome).

interface BadgeInfo {
  type: 'vision' | 'stt' | 'tts' | 'anyToAny' | 'imageGen';
  label: string;
}

/** Retorna as capabilities efetivas de um modelo (model override > heurística). */
function getModelEffectiveBadges(model: ModelEntry): BadgeInfo[] {
  // Heurística base (por nome)
  const auto = getModelBadges(model.modelId);
  const autoTypes = new Set(auto.map(b => b.type));

  const result: BadgeInfo[] = [];

  // Any→Any: campo setado OU heurística
  const anyToAny = model.isAnyToAny ?? autoTypes.has('anyToAny');
  if (anyToAny) result.push({type: 'anyToAny', label: 'ANY→ANY'});

  // STT: campo setado OU heurística
  const stt = model.isStt ?? autoTypes.has('stt');
  if (stt) result.push({type: 'stt', label: 'STT'});

  // TTS: campo setado OU heurística
  const tts = model.isTts ?? autoTypes.has('tts');
  if (tts) result.push({type: 'tts', label: 'TTS'});

  // Vision: campo setado OU heurística
  const vision = model.isVision ?? autoTypes.has('vision');
  if (vision) result.push({type: 'vision', label: 'VISÃO'});

  return result;
}

function renderBadgesFromModel(
  model: ModelEntry,
  styles: ReturnType<typeof getStyles>,
): React.ReactNode {
  const badges = getModelEffectiveBadges(model);
  return badges.map((badge, idx) => {
    const key = `${badge.type}-${idx}`;
    if (badge.type === 'vision') {
      return (
        <View key={key} style={styles.visionBadge}>
          <Icon name="visibility" size={10} color="#a371f7" />
          <Text style={styles.visionBadgeText}>VISÃO</Text>
        </View>
      );
    }
    if (badge.type === 'stt') {
      return (
        <View key={key} style={styles.sttBadge}>
          <Icon name="mic" size={10} color="#f0883e" />
          <Text style={styles.sttBadgeText}>STT</Text>
        </View>
      );
    }
    if (badge.type === 'tts') {
      return (
        <View key={key} style={styles.ttsBadge}>
          <Icon name="volume-up" size={10} color="#2dd4bf" />
          <Text style={styles.ttsBadgeText}>TTS</Text>
        </View>
      );
    }
    if (badge.type === 'imageGen') {
      return (
        <View key={key} style={styles.sttBadge}>
          <Icon name="image" size={10} color="#3fb950" />
          <Text style={styles.sttBadgeText}>IMG</Text>
        </View>
      );
    }
    // anyToAny
    return (
      <View key={key} style={styles.anyBadge}>
        <Icon name="all-inclusive" size={10} color="#d2a8ff" />
        <Text style={styles.anyBadgeText}>ANY→ANY</Text>
      </View>
    );
  });
}

/** Mantida para compatibilidade onde só temos o modelId (não o ModelEntry). */
function renderBadges(
  modelId: string,
  styles: ReturnType<typeof getStyles>,
): React.ReactNode {
  const badges = getModelBadges(modelId);
  return badges.map((badge, idx) => {
    const key = `${badge.type}-${idx}`;
    if (badge.type === 'vision') {
      return (
        <View key={key} style={styles.visionBadge}>
          <Icon name="visibility" size={10} color="#a371f7" />
          <Text style={styles.visionBadgeText}>VISÃO</Text>
        </View>
      );
    }
    if (badge.type === 'stt') {
      return (
        <View key={key} style={styles.sttBadge}>
          <Icon name="mic" size={10} color="#f0883e" />
          <Text style={styles.sttBadgeText}>STT</Text>
        </View>
      );
    }
    if (badge.type === 'tts') {
      return (
        <View key={key} style={styles.ttsBadge}>
          <Icon name="volume-up" size={10} color="#2dd4bf" />
          <Text style={styles.ttsBadgeText}>TTS</Text>
        </View>
      );
    }
    // anyToAny
    return (
      <View key={key} style={styles.anyBadge}>
        <Icon name="all-inclusive" size={10} color="#d2a8ff" />
        <Text style={styles.anyBadgeText}>ANY→ANY</Text>
      </View>
    );
  });
}

/** Gera badges visíveis para imageGen + as capabilities do model. */
function renderAllBadges(
  model: ModelEntry,
  styles: ReturnType<typeof getStyles>,
): React.ReactNode {
  // Usa o novo helper que respeita os campos do ModelEntry
  const capBadges = renderBadgesFromModel(model, styles);
  const imageBadge =
    model.isImageGen || model.modelId.toLowerCase().includes('image') ? (
      <View key="imagegen" style={styles.sttBadge}>
        <Icon name="image" size={10} color="#3fb950" />
        <Text style={styles.sttBadgeText}>IMG</Text>
      </View>
    ) : null;
  return (
    <>
      {capBadges}
      {imageBadge}
    </>
  );
}

// ---------------------------------------------------------------------------
// CapabilityToggle — linha de toggle para uma capability no modal de edição
// ---------------------------------------------------------------------------
interface CapabilityToggleProps {
  label: string;
  icon: string;
  color: string;
  value: boolean;
  onToggle: () => void;
}

function CapabilityToggle({label, icon, color, value, onToggle}: CapabilityToggleProps) {
  return (
    <TouchableOpacity
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(128,128,128,0.2)',
      }}
      onPress={onToggle}
      activeOpacity={0.7}>
      <Icon name={icon as any} size={20} color={color} />
      <Text style={{flex: 1, color: '#c9d1d9', fontSize: 14}}>{label}</Text>
      <Icon
        name={value ? 'check-box' : 'check-box-outline-blank'}
        size={24}
        color={value ? '#3fb950' : '#8b949e'}
      />
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// SwipeableModelRow — linha de modelo com swipe à esquerda revelando actions
// ---------------------------------------------------------------------------

const ACTION_WIDTH = 72; // largura de cada botão de ação (ocultar + tags)

interface SwipeableModelRowProps {
  model: ModelEntry;
  theme: ThemeColors;
  styles: ReturnType<typeof getStyles>;
  modelDisplayName: (m: ModelEntry) => string;
  renderAllBadges: (m: ModelEntry, s: ReturnType<typeof getStyles>) => React.ReactNode;
  onToggleFavorite: (m: ModelEntry) => void;
  onHide: (m: ModelEntry) => void;
  onEditTags: (m: ModelEntry) => void;
}

function SwipeableModelRow({
  model, theme, styles, modelDisplayName, renderAllBadges,
  onToggleFavorite, onHide, onEditTags,
}: SwipeableModelRowProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const [open, setOpen] = useState(false);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 10 && Math.abs(gestureState.dy) < 10;
      },
      onPanResponderMove: (_, gestureState) => {
        // Permite arrastar para a esquerda (negativo) a partir de 0 ou da posição aberta
        const newValue = open
          ? Math.min(0, gestureState.dx - ACTION_WIDTH * 2)
          : Math.max(-ACTION_WIDTH * 2, gestureState.dx);
        translateX.setValue(newValue);
      },
      onPanResponderRelease: (_, gestureState) => {
        const threshold = -ACTION_WIDTH;
        const shouldOpen = open
          ? gestureState.dx > -ACTION_WIDTH // já aberto: fechar se arrastar pouco
          : gestureState.dx < threshold;     // fechado: abrir se arrastar bastante
        if (shouldOpen) {
          Animated.spring(translateX, {
            toValue: -ACTION_WIDTH * 2,
            useNativeDriver: true,
            tension: 80,
            friction: 10,
          }).start();
          setOpen(true);
        } else {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            tension: 80,
            friction: 10,
          }).start();
          setOpen(false);
        }
      },
    }),
  ).current;

  return (
    <View style={{overflow: 'hidden'}}>
      {/* Actions de fundo (reveladas ao deslizar) */}
      <View style={styles.swipeActionsContainer}>
        <TouchableOpacity
          style={[styles.swipeActionBtn, {backgroundColor: theme.border}]}
          onPress={() => { onEditTags(model); Animated.spring(translateX, {toValue: 0, useNativeDriver: true}).start(); setOpen(false); }}
          activeOpacity={0.7}>
          <Icon name="edit" size={18} color={theme.accent} />
          <Text style={styles.swipeActionText}>Tags</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.swipeActionBtn, {backgroundColor: theme.errorText}]}
          onPress={() => { onHide(model); Animated.spring(translateX, {toValue: 0, useNativeDriver: true}).start(); setOpen(false); }}
          activeOpacity={0.7}>
          <Icon name="visibility-off" size={18} color="#fff" />
          <Text style={[styles.swipeActionText, {color: '#fff'}]}>Ocultar</Text>
        </TouchableOpacity>
      </View>
      {/* Conteúdo da linha (desliza) */}
      <Animated.View
        style={[styles.swipeRowContent, {transform: [{translateX}]}]}
        {...panResponder.panHandlers}>
        <Icon name="memory" size={16} color={theme.textSecondary} />
        <View style={{flex: 1}}>
          <Text style={styles.dropdownItemText} numberOfLines={1}>
            {modelDisplayName(model)}
          </Text>
          <View style={{flexDirection: 'row', gap: 4, marginTop: 2, flexWrap: 'wrap'}}>
            {renderAllBadges(model, styles)}
            {model.isFree && (
              <View style={styles.freeBadge}>
                <Text style={styles.freeBadgeText}>FREE</Text>
              </View>
            )}
          </View>
        </View>
        {/* Toggle favorito */}
        <TouchableOpacity
          onPress={() => onToggleFavorite(model)}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          style={styles.favBtn}>
          <Icon
            name={model.isFavorite ? 'star' : 'star-border'}
            size={20}
            color={model.isFavorite ? '#e3b341' : theme.textMuted}
          />
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

export function SettingsScreen({settingsV2, onChangeV2, onClose, onAddServer}: Props) {
  const theme = getTheme(settingsV2.theme);
  const s = getStyles(theme);

  // Drop downs abertos
  // serverDropdownOpen, sttServerDropdownOpen e ttsServerDropdownOpen removidos:
  // os modais de servidor ativo/STT/TTS não existem mais na UI.
  // A seleção de servidor é implícita ao selecionar o modelo (selectModel,
  // selectSttModel, selectTtsModel setam o serverId correspondente).

  // Estado de loading p/ delete de servidor
  const [deleting, setDeleting] = useState(false);

  // Servidor expandido no card de Servidores (null = nenhum)
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);
  // Servidor sendo atualizado (refresh modelos)
  const [refreshingServerId, setRefreshingServerId] = useState<string | null>(null);

  // Estado p/ forçar re-render após toggle de favorito (MMKV é síncrono,
  // mas não dispara re-render automaticamente)
  const [, setFavTick] = useState(0);
  const refreshFav = () => setFavTick(t => t + 1);

  // Estado para vozes TTS
  const [ttsVoices, setTtsVoices] = useState<string[]>([]);
  const [testingVoice, setTestingVoice] = useState<string | null>(null);

  // Estado para vozes FishAudio (fetch async com title + id)
  const [fishVoices, setFishVoices] = useState<{id: string; title: string; languages: string[]}[]>([]);
  const [fishVoicesLoading, setFishVoicesLoading] = useState(false);
  const [fishVoicesHasMore, setFishVoicesHasMore] = useState(false);
  const [fishVoicesTotal, setFishVoicesTotal] = useState(0);
  const [fishVoicesLoadingMore, setFishVoicesLoadingMore] = useState(false);
  const [fishVoicesTick, setFishVoicesTick] = useState(0);

  // Estado para edição de capabilities de modelo
  const [editingModel, setEditingModel] = useState<ModelEntry | null>(null);

  // Estado para seção de modelos ocultos (por servidor)
  const [expandedHiddenId, setExpandedHiddenId] = useState<string | null>(null);

  // Estado para gerenciamento de API keys
  const [keyModalServer, setKeyModalServer] = useState<ServerEntry | null>(null);
  const [newKeyValue, setNewKeyValue] = useState('');
  const [keyTick, setKeyTick] = useState(0);
  const refreshKeys = () => setKeyTick(t => t + 1);

  // Estado para renomear key
  const [renameKeyServer, setRenameKeyServer] = useState<ServerEntry | null>(null);
  const [renameKeyIndex, setRenameKeyIndex] = useState(0);
  const [renameKeyValue, setRenameKeyValue] = useState('');

  // --- Dados (síncronos, MMKV) ---

  const allServers: ServerEntry[] = getAllServers();

  const activeServerId = settingsV2.activeServerId;
  const activeServer = activeServerId ? getServer(activeServerId) : null;

  // Resolvedor de servidor TTS (override explícito, senão usa o do chat)
  const ttsServer = settingsV2.ttsServerId
    ? getServer(settingsV2.ttsServerId)
    : activeServer;

  // Modelos de LLM (chat) — favoritos de TODOS os servidores, não só o ativo.
  // Exclui STT/TTS/imageGen (esses aparecem nos cards de Voz e Image Gen).
  const allModels: ModelEntry[] = getAllModels();
  const serverModels: ModelEntry[] = allModels.filter(
    m => !m.isHidden && !m.isUserHidden && m.isFavorite && !m.isStt && !m.isTts && !m.isImageGen,
  );

  // Modelos STT/TTS de todos os servidores — apenas favoritos para seleção
  const sttModels: ModelEntry[] = allModels.filter(
    m => m.isStt === true && !m.isHidden && !m.isUserHidden && m.isFavorite,
  );
  const ttsModels: ModelEntry[] = allModels.filter(
    m => m.isTts === true && !m.isHidden && !m.isUserHidden && m.isFavorite,
  );

  // --- Helpers de ordenação (favoritos primeiro) ---

  function sortFavFirst<T extends {isFavorite?: boolean}>(
    arr: T[],
  ): T[] {
    return [...arr].sort((a, b) => {
      const af = a.isFavorite ? 0 : 1;
      const bf = b.isFavorite ? 0 : 1;
      if (af !== bf) return af - bf;
      return 0;
    });
  }

  const sortedServerModels = sortFavFirst(serverModels);
  const sortedSttModels = sortFavFirst(sttModels);
  const sortedTtsModels = sortFavFirst(ttsModels);

  // --- Handlers ---

  const selectModel = (model: ModelEntry) => {
    // Ao selecionar um modelo, also troca o servidor ativo para o do modelo
    onChangeV2({activeModelId: model.id, activeServerId: model.serverId});
  };

  const selectSttModel = (model: ModelEntry) => {
    // Troca também o servidor STT para o servidor do modelo selecionado,
    // para que o App.tsx/useWhisper resolvam o servidor correto.
    onChangeV2({activeSttModelId: model.id, sttServerId: model.serverId});
  };

  const selectTtsModel = (model: ModelEntry) => {
    // Troca também o servidor TTS para o servidor do modelo selecionado.
    onChangeV2({activeTtsModelId: model.id, ttsServerId: model.serverId});
  };

  /** Alterna favorito de um modelo (LLM, STT, TTS). */
  const toggleFavorite = (model: ModelEntry) => {
    patchModel(model.id, {isFavorite: !model.isFavorite});
    refreshFav();
  };

  /** Oculta um modelo manualmente (persiste entre fetchs). */
  const hideModel = (model: ModelEntry) => {
    patchModel(model.id, {isUserHidden: true});
    refreshFav();
  };

  /** Re-exibe um modelo que foi ocultado manualmente. */
  const unhideModel = (model: ModelEntry) => {
    patchModel(model.id, {isUserHidden: false});
    refreshFav();
  };

  /** Salva as capabilities editadas manualmente num modelo. */
  const saveCapabilities = (
    model: ModelEntry,
    caps: {
      isVision?: boolean;
      isStt?: boolean;
      isTts?: boolean;
      isAnyToAny?: boolean;
      isImageGen?: boolean;
    },
  ) => {
    patchModel(model.id, caps);
    refreshFav();
    setEditingModel(null);
  };

  /** Adiciona uma nova API key a um servidor. */
  const handleAddKey = async (server: ServerEntry) => {
    const key = newKeyValue.trim();
    if (!key) {
      Alert.alert('Chave vazia', 'Digite uma API key válida.');
      return;
    }
    const newIndex = server.apiKeyCount;
    await saveApiKey(server.id, newIndex, key);
    patchServer(server.id, {
      apiKeyCount: newIndex + 1,
      activeKeyIndex: newIndex === 0 ? 0 : server.activeKeyIndex,
    });
    setNewKeyValue('');
    setKeyModalServer(null);
    refreshKeys();
    refreshFav();
  };

  /** Remove uma API key de um servidor. */
  const handleRemoveKey = async (server: ServerEntry, keyIndex: number) => {
    if (server.apiKeyCount <= 1) {
      Alert.alert(
        'Não é possível remover',
        'O servidor precisa de pelo menos uma chave. Edite a chave em vez de remover.',
      );
      return;
    }
    Alert.alert(
      `Remover chave #${keyIndex + 1}?`,
      'A chave será removida permanentemente do dispositivo.',
      [
        {text: 'Cancelar', style: 'cancel'},
        {
          text: 'Remover',
          style: 'destructive',
          onPress: async () => {
            await resetApiKey(server.id, keyIndex);
            // Reindexa as chaves restantes: move keys > keyIndex uma posição para baixo
            for (let i = keyIndex; i < server.apiKeyCount - 1; i++) {
              const k = await loadApiKey(server.id, i + 1);
              await saveApiKey(server.id, i, k);
              await resetApiKey(server.id, i + 1);
            }
            const newCount = server.apiKeyCount - 1;
            const newActive = Math.min(server.activeKeyIndex, newCount - 1);
            patchServer(server.id, {
              apiKeyCount: newCount,
              activeKeyIndex: Math.max(0, newActive),
            });
            clearServerCooldown(server.id);
            refreshKeys();
            refreshFav();
          },
        },
      ],
    );
  };

  /** Troca a chave ativa manualmente. */
  const handleSetActiveKey = (server: ServerEntry, keyIndex: number) => {
    patchServer(server.id, {activeKeyIndex: keyIndex});
    clearServerCooldown(server.id);
    refreshKeys();
  };

  /** Troca a estratégia de rotação. */
  const handleSetRotation = (server: ServerEntry, rotation: 'single' | 'round-robin' | 'failover') => {
    patchServer(server.id, {keyRotation: rotation});
    clearServerCooldown(server.id);
    refreshKeys();
  };

  /** Define o cooldown (em minutos) para o modo failover. */
  const handleSetCooldown = (server: ServerEntry, minutes: number) => {
    patchServer(server.id, {cooldownMinutes: minutes});
    clearServerCooldown(server.id);
    refreshKeys();
  };

  /** Salva o nome amigável de uma key. */
  const handleRenameKey = (server: ServerEntry, keyIndex: number, label: string) => {
    const labels = [...(server.keyLabels ?? [])];
    // Preenche com null até o índice se necessário
    while (labels.length < keyIndex) labels.push('');
    labels[keyIndex] = label.trim();
    patchServer(server.id, {keyLabels: labels});
    setRenameKeyServer(null);
    refreshKeys();
  };

  /** Busca vozes disponíveis do servidor TTS ativo.
   *  Para FishAudio: usa cache do MMKV (voiceDb) se já foi buscado antes.
   *  Para OpenAI/Gemini: vozes são fixas (getAvailableVoices). */
  const handleFetchVoices = async () => {
    if (!ttsServer) {
      Alert.alert('Sem servidor', 'Selecione um servidor TTS primeiro.');
      return;
    }
    // FishAudio: fetch async de vozes públicas via GET /model
    if (ttsServer.baseUrl.includes('fish.audio')) {
      // Se já há vozes no cache, mostra as cacheadas em vez de refazer fetch.
      const cached = getFishVoices(ttsServer.id);
      if (cached.length > 0) {
        setFishVoices(cached);
        // Se o cache não esgotou o total na última busca, mantém hasMore ativo
        const lastPage = getFishVoicesLastPage(ttsServer.id);
        // Sempre mostra o botão "Carregar mais" se já tem vozes no cache
        // — o usuário pode querer paginar
        setFishVoicesTick(t => t + 1);
        return;
      }
      setFishVoicesLoading(true);
      setTtsVoices([]); // limpa lista fixa
      try {
        // Busca vozes em português primeiro (filtro do FishAudio)
        let result = await fetchFishAudioVoices(ttsServer.baseUrl, 1, 50, 'pt');
        // Se não há vozes em PT, busca sem filtro
        if (result.voices.length === 0) {
          result = await fetchFishAudioVoices(ttsServer.baseUrl, 1, 50);
        }
        // Salva no cache (página 1)
        setFishVoices(result.voices);
        setFishVoicesHasMore(result.hasMore);
        setFishVoicesTotal(result.total);
        appendFishVoices(ttsServer.id, result.voices, result.page);
        setFishVoicesTick(t => t + 1);
      } catch (e: any) {
        Alert.alert('Erro ao buscar vozes', e?.message ?? 'Verifique a URL do servidor.');
      } finally {
        setFishVoicesLoading(false);
      }
      return;
    }
    // OpenAI/Gemini: vozes fixas
    setFishVoices([]);
    setFishVoicesHasMore(false);
    const voices = getAvailableVoices(ttsServer.baseUrl);
    setTtsVoices(voices);
  };

  /** Carrega mais 50 vozes FishAudio (próxima página do cache/API). */
  const handleLoadMoreVoices = async () => {
    if (!ttsServer || fishVoicesLoadingMore) return;
    setFishVoicesLoadingMore(true);
    try {
      const lastPage = getFishVoicesLastPage(ttsServer.id);
      const nextPage = lastPage + 1;
      // Primeiro verifica se já temos no cache (usuário pode ter paginado antes)
      // Se a próxima página já está no cache, não precisa de fetch.
      // Como armazenamos em um único array, não sabemos se a próxima página
      // foi toda carregada. Verificamos se já temos o total ou se o cache
      // já tem mais vozes que as mostradas.
      const cached = getFishVoices(ttsServer.id);
      if (cached.length > fishVoices.length) {
        // Já temos mais no cache — apenas atualiza a UI
        setFishVoices(cached);
        setFishVoicesTick(t => t + 1);
        return;
      }
      // Senão, busca a próxima página da API
      let result = await fetchFishAudioVoices(ttsServer.baseUrl, nextPage, 50);
      // Se PT retornou vazio na primeira vez, aqui também pode
      // Mantém consistência com o handleFetchVoices
      if (result.voices.length === 0 && nextPage === 2) {
        result = await fetchFishAudioVoices(ttsServer.baseUrl, nextPage, 50);
      }
      if (result.voices.length > 0) {
        const merged = appendFishVoices(ttsServer.id, result.voices, result.page);
        setFishVoices(merged);
        setFishVoicesHasMore(result.hasMore);
        setFishVoicesTotal(result.total);
        setFishVoicesTick(t => t + 1);
      } else {
        setFishVoicesHasMore(false);
      }
    } catch (e: any) {
      Alert.alert('Erro ao carregar mais vozes', e?.message ?? 'Verifique a conexão.');
    } finally {
      setFishVoicesLoadingMore(false);
    }
  };

  /** Limpa o cache de vozes FishAudio e refaz o fetch do zero. */
  const handleRefreshVoices = async () => {
    if (!ttsServer) return;
    if (ttsServer.baseUrl.includes('fish.audio')) {
      clearFishVoices(ttsServer.id);
      setFishVoices([]);
      setFishVoicesHasMore(false);
      setFishVoicesTotal(0);
      await handleFetchVoices();
    }
  };

  /** Testa uma voz sintetizando uma frase curta. */
  const handleTestVoice = async (voice: string) => {
    if (!ttsServer || !activeTtsModel) {
      Alert.alert('Configuração incompleta', 'Selecione um servidor e modelo TTS.');
      return;
    }
    setTestingVoice(voice);
    try {
      let apiKey = '';
      if (ttsServer.apiKeyCount > 0) {
        apiKey = await loadApiKey(ttsServer.id, ttsServer.activeKeyIndex);
      }
      await testVoice({
        baseUrl: ttsServer.baseUrl,
        apiKey,
        model: activeTtsModel.modelId,
        voice,
      });
    } catch (e: any) {
      Alert.alert('Erro ao testar voz', e?.message ?? 'Verifique a configuração.');
    } finally {
      setTestingVoice(null);
    }
  };

  /** Re-fetch dos modelos de um servidor. Preserva favoritos existentes
   *  (syncModelsFromFetch só atualiza timestamp, não reset isFavorite). */
  const refreshModels = async (server: ServerEntry) => {
    setRefreshingServerId(server.id);
    try {
      // Carrega API key do Keychain para o fetch
      let apiKey = '';
      if (server.apiKeyCount > 0) {
        apiKey = await loadApiKey(server.id, server.activeKeyIndex);
      }
      const modelIds = await fetchModels(server, apiKey);
      const {added, updated, hidden} = syncModelsFromFetch(server.id, modelIds);
      refreshFav();
      if (added === 0 && updated === 0 && hidden === 0) {
        Alert.alert('Atualizado', 'Nenhuma mudança nos modelos disponíveis.');
      } else {
        const parts: string[] = [];
        if (added > 0) parts.push(`${added} novo(s)`);
        if (updated > 0) parts.push(`${updated} atualizado(s)`);
        if (hidden > 0) parts.push(`${hidden} removido(s)`);
        Alert.alert('Modelos atualizados', parts.join(', '));
      }
    } catch (e: any) {
      Alert.alert('Erro ao atualizar', e?.message ?? 'Verifique a conexão e a API key.');
    } finally {
      setRefreshingServerId(null);
    }
  };

  const handleDeleteServer = (server: ServerEntry) => {
    Alert.alert(
      'Deletar servidor',
      `Deletar "${server.name}"? Todos os modelos e API keys associados serão removidos.`,
      [
        {text: 'Cancelar', style: 'cancel'},
        {
          text: 'Deletar',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              const ok = await deleteServerCascade(server.id);
              if (ok) {
                const wasActive = settingsV2.activeServerId === server.id;
                if (wasActive) {
                  onChangeV2({activeServerId: null, activeModelId: null});
                }
                // Notifica: precisa de refresh. Usamos onChangeV2 com o estado atual.
                onChangeV2({});
              } else {
                Alert.alert('Erro', 'Servidor não encontrado.');
              }
            } catch (e) {
              Alert.alert(
                'Erro ao deletar',
                (e as Error).message ?? String(e),
              );
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  // --- Nome legível do modelo ---

  const modelDisplayName = (model: ModelEntry): string => {
    if (model.displayName?.trim()) return model.displayName!;
    return shortModelName(model.modelId);
  };

  const activeModel = settingsV2.activeModelId
    ? getModel(settingsV2.activeModelId)
    : null;
  const activeSttModel = settingsV2.activeSttModelId
    ? getModel(settingsV2.activeSttModelId)
    : null;
  const activeTtsModel = settingsV2.activeTtsModelId
    ? getModel(settingsV2.activeTtsModelId)
    : null;

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
          {/* ====================================================== */}
          {/* Card: Servidores — lista expansível com modelos          */}
          {/* ====================================================== */}
          <Card
            title="Servidores"
            icon="dns"
            defaultExpanded={false}
            theme={theme}>
            {allServers.length === 0 ? (
              <>
                <Text style={s.hint}>
                  Nenhum servidor cadastrado. Toque em adicionar para criar
                  um novo servidor.
                </Text>
                <TouchableOpacity
                  style={s.addServerBtn}
                  onPress={onAddServer}>
                  <Icon name="add" size={20} color={theme.accentText} />
                  <Text style={s.addServerBtnText}>Adicionar servidor</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                {allServers.map(server => {
                  const isActive = server.id === settingsV2.activeServerId;
                  const isExpanded = expandedServerId === server.id;
                  const isRefreshing = refreshingServerId === server.id;
                  const serverModelsAll = getModelsByServer(server.id).filter(m => !m.isHidden);
                  const serverModelsVisible = serverModelsAll.filter(m => !m.isUserHidden);
                  const serverModelsHidden = serverModelsAll.filter(m => m.isUserHidden);
                  const isHiddenSectionOpen = expandedHiddenId === server.id;
                  return (
                    <View key={server.id}>
                      {/* Header do servidor — clicável expande/colapsa */}
                      <View
                        style={[s.serverItem, isActive && s.serverItemActive]}>
                        <TouchableOpacity
                          style={{flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10}}
                          onPress={() => setExpandedServerId(isExpanded ? null : server.id)}>
                          <Icon
                            name={server.icon as any}
                            size={20}
                            color={isActive ? theme.accent : theme.textSecondary}
                          />
                          <View style={s.serverItemInfo}>
                            <Text
                              style={[
                                s.serverItemName,
                                isActive && s.serverItemNameActive,
                              ]}
                              numberOfLines={1}>
                              {server.name}
                            </Text>
                            <Text
                              style={s.serverItemUrl}
                              numberOfLines={1}>
                              {server.baseUrl}
                            </Text>
                          </View>
                        </TouchableOpacity>
                        {/* Refresh button */}
                        <TouchableOpacity
                          style={s.serverDeleteBtn}
                          onPress={() => refreshModels(server)}
                          disabled={isRefreshing}
                          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                          {isRefreshing ? (
                            <ActivityIndicator size={16} color={theme.accent} />
                          ) : (
                            <Icon name="refresh" size={18} color={theme.accent} />
                          )}
                        </TouchableOpacity>
                        {/* Delete button */}
                        <TouchableOpacity
                          style={s.serverDeleteBtn}
                          onPress={() => handleDeleteServer(server)}
                          disabled={deleting}
                          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                          <Icon
                            name="delete"
                            size={18}
                            color={theme.errorText}
                          />
                        </TouchableOpacity>
                        {/* Expand chevron */}
                        <Icon
                          name={isExpanded ? 'expand-less' : 'expand-more'}
                          size={20}
                          color={theme.textSecondary}
                        />
                      </View>
                      {/* Modelos do servidor (expandido) */}
                      {isExpanded && (
                        <View style={s.serverModelsList}>
                          {serverModelsVisible.length === 0 && serverModelsHidden.length === 0 ? (
                            <Text style={s.hint}>
                              Nenhum modelo. Toque em refresh para buscar.
                            </Text>
                          ) : (
                            <>
                              {serverModelsVisible.map(model => (
                                <SwipeableModelRow
                                  key={model.id}
                                  model={model}
                                  theme={theme}
                                  styles={s}
                                  modelDisplayName={modelDisplayName}
                                  renderAllBadges={renderAllBadges}
                                  onToggleFavorite={toggleFavorite}
                                  onHide={hideModel}
                                  onEditTags={setEditingModel}
                                />
                              ))}

                              {/* Seção de modelos ocultos */}
                              {serverModelsHidden.length > 0 && (
                                <View>
                                  <TouchableOpacity
                                    style={s.hiddenSectionHeader}
                                    onPress={() => setExpandedHiddenId(isHiddenSectionOpen ? null : server.id)}>
                                    <Icon
                                      name={isHiddenSectionOpen ? 'expand-less' : 'expand-more'}
                                      size={16}
                                      color={theme.textSecondary}
                                    />
                                    <Icon name="visibility-off" size={14} color={theme.textSecondary} />
                                    <Text style={s.hiddenSectionText}>
                                      Modelos ocultos ({serverModelsHidden.length})
                                    </Text>
                                  </TouchableOpacity>
                                  {isHiddenSectionOpen && (
                                    serverModelsHidden.map(model => (
                                      <View key={model.id} style={s.hiddenModelRow}>
                                        <Icon name="memory" size={16} color={theme.textMuted} />
                                        <Text
                                          style={[s.dropdownItemText, {color: theme.textMuted}]}
                                          numberOfLines={1}>
                                          {modelDisplayName(model)}
                                        </Text>
                                        <TouchableOpacity
                                          onPress={() => unhideModel(model)}
                                          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                                          style={s.favBtn}>
                                          <Icon name="visibility" size={18} color={theme.accent} />
                                        </TouchableOpacity>
                                      </View>
                                    ))
                                  )}
                                </View>
                              )}
                            </>
                          )}
                          {/* Refresh inline */}
                          <TouchableOpacity
                            style={[s.addServerBtn, {marginTop: 4}]}
                            onPress={() => refreshModels(server)}
                            disabled={isRefreshing}>
                            {isRefreshing ? (
                              <ActivityIndicator size={16} color={theme.accent} />
                            ) : (
                              <Icon name="refresh" size={16} color={theme.accent} />
                            )}
                            <Text style={s.addServerBtnText}>Atualizar modelos</Text>
                          </TouchableOpacity>

                          {/* --- API Keys --- */}
                          <View style={s.keySection}>
                            <Text style={s.keySectionTitle}>API Keys ({server.apiKeyCount})</Text>

                            {/* Estratégia de rotação */}
                            <Text style={s.keyLabel}>Rotação</Text>
                            <View style={s.keyRotationRow}>
                              {(['single', 'round-robin', 'failover'] as const).map(rot => {
                                const currentRot = (getServer(server.id) ?? server).keyRotation;
                                const isSelected = currentRot === rot;
                                const labels: Record<typeof rot, string> = {
                                  'single': 'Manual',
                                  'round-robin': 'Round-robin',
                                  'failover': 'Failover',
                                };
                                return (
                                  <TouchableOpacity
                                    key={rot}
                                    style={[
                                      s.keyRotationBtn,
                                      isSelected && s.keyRotationBtnActive,
                                    ]}
                                    onPress={() => handleSetRotation(server, rot)}>
                                    <Text
                                      style={[
                                        s.keyRotationText,
                                        isSelected && s.keyRotationTextActive,
                                      ]}>
                                      {labels[rot]}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </View>

                              {/* Cooldown customizável (só visível em failover) */}
                              {(() => {
                              const curRot = (getServer(server.id) ?? server).keyRotation;
                              if (curRot !== 'failover') return null;
                              const curServer = getServer(server.id) ?? server;
                              const curMin = curServer.cooldownMinutes ?? 1;
                              return (
                              <View style={s.keyCooldownRow}>
                              <Text style={s.keyLabel}>Cooldown (min)</Text>
                              {[1, 3, 5, 10, 30].map(m => {
                              const isSelected = curMin === m;
                              return (
                              <TouchableOpacity
                                key={m}
                                style={[s.keyCooldownBtn, isSelected && s.keyRotationBtnActive]}
                                onPress={() => handleSetCooldown(curServer, m)}>
                                <Text style={[s.keyCooldownText, isSelected && s.keyRotationTextActive]}>
                                  {m}
                                </Text>
                              </TouchableOpacity>
                              );
                              })}
                              </View>
                              );
                              })()}

                              {/* Lista de keys — relê server do MMKV para refletir troca de ativa */}
                              {(() => {
                              const currentServer = getServer(server.id) ?? server;
                              return Array.from({length: currentServer.apiKeyCount}).map((_, idx) => {
                              const isActiveNow = idx === currentServer.activeKeyIndex;
                              const cooldownMs = Math.max(1, currentServer.cooldownMinutes ?? 1) * 60_000;
                              const exhausted = isKeyExhausted(currentServer.id, idx, cooldownMs);
                              const label = currentServer.keyLabels?.[idx];
                              return (
                              <View key={idx} style={[s.keyRow, isActiveNow && s.keyRowActive]}>
                              <Icon
                              name="vpn-key"
                              size={16}
                              color={isActiveNow ? theme.accent : theme.textMuted}
                              />
                              <View style={{flex: 1}}>
                              <Text style={s.keyLabel} numberOfLines={1}>
                              {label ? label : `Chave #${idx + 1}`}
                              </Text>
                              </View>
                              {isActiveNow && (
                              <View style={s.keyActiveBadge}>
                              <Text style={s.keyActiveBadgeText}>ATIVA</Text>
                              </View>
                              )}
                              {exhausted && (
                              <View style={s.keyCooldownBadge}>
                              <Text style={s.keyCooldownBadgeText}>COOLDOWN</Text>
                              </View>
                              )}
                              {/* Renomear */}
                              <TouchableOpacity
                              style={s.keyActionBtn}
                              onPress={() => { setRenameKeyServer(currentServer); setRenameKeyIndex(idx); setRenameKeyValue(label ?? ''); }}
                              hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}>
                              <Icon name="edit" size={16} color={theme.textSecondary} />
                              </TouchableOpacity>
                              {/* Trocar para ativa (manual) */}
                              {!isActiveNow && (
                              <TouchableOpacity
                              style={s.keyActionBtn}
                              onPress={() => handleSetActiveKey(currentServer, idx)}
                              hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}>
                              <Icon name="swap-vert" size={18} color={theme.accent} />
                              </TouchableOpacity>
                              )}
                              {/* Remover */}
                              {currentServer.apiKeyCount > 1 && (
                              <TouchableOpacity
                              style={s.keyActionBtn}
                              onPress={() => handleRemoveKey(currentServer, idx)}
                              hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}>
                              <Icon name="delete" size={16} color={theme.errorText} />
                              </TouchableOpacity>
                              )}
                              </View>
                              );
                              });
                              })()}

                            {/* Botão adicionar chave */}
                            <TouchableOpacity
                              style={[s.addServerBtn, {marginTop: 6}]}
                              onPress={() => { setKeyModalServer(server); setNewKeyValue(''); }}>
                              <Icon name="add" size={16} color={theme.accentText} />
                              <Text style={s.addServerBtnText}>Adicionar chave</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      )}
                    </View>
                  );
                })}

                {/* Botão adicionar servidor */}
                <TouchableOpacity
                  style={s.addServerBtn}
                  onPress={onAddServer}>
                  <Icon name="add" size={20} color={theme.accentText} />
                  <Text style={s.addServerBtnText}>Adicionar servidor</Text>
                </TouchableOpacity>
              </>
            )}
          </Card>

          {/* ====================================================== */}
          {/* Card: Modelo de Linguagem (chat/LLM)                   */}
          {/* ====================================================== */}
          <Card
            title="Modelo de Linguagem"
            icon="memory"
            defaultExpanded={false}
            theme={theme}>
            {/* Lista de modelos favoritos (todos os servidores) */}
            <Text style={s.label}>Modelo</Text>
            {sortedServerModels.length === 0 ? (
              <Text style={s.hint}>
                Nenhum favorito. Vá em Servidores e marque modelos com a
                estrela para vê-los aqui.
              </Text>
            ) : (
              <View style={s.dropdownList}>
                {sortedServerModels.map(model => {
                  const isActive = model.id === settingsV2.activeModelId;
                  const modelServer = getServer(model.serverId);
                  return (
                    <TouchableOpacity
                      key={model.id}
                      style={[
                        s.dropdownItem,
                        isActive && s.dropdownItemActive,
                      ]}
                      onPress={() => selectModel(model)}>
                      <Icon
                        name="memory"
                        size={18}
                        color={isActive ? theme.accent : theme.textSecondary}
                      />
                      <View style={{flex: 1}}>
                        <Text
                          style={[
                            s.dropdownItemText,
                            isActive && s.dropdownItemTextActive,
                          ]}
                          numberOfLines={1}>
                          {modelDisplayName(model)}
                          {modelServer ? ` · ${modelServer.name}` : ''}
                        </Text>
                        {/* badges inline */}
                        <View
                          style={{
                            flexDirection: 'row',
                            gap: 4,
                            marginTop: 2,
                            flexWrap: 'wrap',
                          }}>
                          {renderAllBadges(model, s)}
                          {model.isFree && (
                            <View style={s.freeBadge}>
                              <Text style={s.freeBadgeText}>FREE</Text>
                            </View>
                          )}
                        </View>
                      </View>
                      {/* Toggle favorito */}
                      <TouchableOpacity
                        onPress={(e) => { e.stopPropagation?.(); toggleFavorite(model); }}
                        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                        style={s.favBtn}>
                        <Icon
                          name={model.isFavorite ? 'star' : 'star-border'}
                          size={20}
                          color={model.isFavorite ? '#e3b341' : theme.textMuted}
                        />
                      </TouchableOpacity>
                      {isActive && (
                        <Icon name="check" size={18} color="#3fb950" />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Modelo ativo selecionado (destaque) */}
            {activeModel && (
              <View style={s.sttModelSelected}>
                <Icon name="check-circle" size={14} color="#3fb950" />
                <Text style={s.sttModelSelectedText}>
                  {displayModelName(activeModel.modelId)}
                </Text>
              </View>
            )}
          </Card>

          {/* ====================================================== */}
          {/* Card: Voz (STT) — transcription online                   */}
          {/* ====================================================== */}
          <Card title="Voz (STT)" icon="mic" theme={theme}>
            {/* Lista de modelos STT (de todos os servidores) */}
                <Text style={s.label}>Modelo STT online</Text>
                {sortedSttModels.length === 0 ? (
                  <Text style={s.hint}>
                    Nenhum favorito STT. Vá em Servidores e marque modelos
                    de transcrição com a estrela.
                  </Text>
                ) : (
                  <View style={s.dropdownList}>
                    {sortedSttModels.map(model => {
                      const isActive =
                        model.id === settingsV2.activeSttModelId;
                      const modelServer = getServer(model.serverId);
                      return (
                        <TouchableOpacity
                          key={model.id}
                          style={[
                            s.dropdownItem,
                            isActive && s.dropdownItemActive,
                          ]}
                          onPress={() => selectSttModel(model)}>
                          <Icon
                            name="mic"
                            size={18}
                            color={isActive ? theme.accent : theme.textSecondary}
                          />
                          <View style={{flex: 1}}>
                            <Text
                              style={[
                                s.dropdownItemText,
                                isActive && s.dropdownItemTextActive,
                              ]}
                              numberOfLines={1}>
                              {modelDisplayName(model)}
                              {modelServer ? ` · ${modelServer.name}` : ''}
                            </Text>
                            <View
                              style={{
                                flexDirection: 'row',
                                gap: 4,
                                marginTop: 2,
                                flexWrap: 'wrap',
                              }}>
                              {renderBadges(model.modelId, s)}
                              {model.isFree && (
                                <View style={s.freeBadge}>
                                  <Text style={s.freeBadgeText}>FREE</Text>
                                </View>
                              )}
                            </View>
                          </View>
                          {/* Toggle favorito */}
                          <TouchableOpacity
                            onPress={(e) => { e.stopPropagation?.(); toggleFavorite(model); }}
                            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                            style={s.favBtn}>
                            <Icon
                              name={model.isFavorite ? 'star' : 'star-border'}
                              size={20}
                              color={model.isFavorite ? '#e3b341' : theme.textMuted}
                            />
                          </TouchableOpacity>
                          {isActive && (
                            <Icon name="check" size={18} color="#3fb950" />
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                {/* Modelo STT ativo selecionado (destaque) */}
                {activeSttModel && (
                  <View style={s.sttModelSelected}>
                    <Icon name="check-circle" size={14} color="#f0883e" />
                    <Text style={s.sttModelSelectedText}>
                      {displayModelName(activeSttModel.modelId)}
                    </Text>
                  </View>
                )}
          </Card>

          {/* ====================================================== */}
          {/* Card: Voz (TTS) — síntese de áudio                     */}
          {/* ====================================================== */}
          <Card title="Voz (TTS)" icon="volume-up" theme={theme}>
            {/* Lista de modelos TTS (de todos os servidores) */}
            <Text style={s.label}>Modelo TTS</Text>
            {sortedTtsModels.length === 0 ? (
              <Text style={s.hint}>
                Nenhum favorito TTS. Vá em Servidores e marque modelos
                de síntese de voz com a estrela.
              </Text>
            ) : (
              <View style={s.dropdownList}>
                {sortedTtsModels.map(model => {
                  const isActive = model.id === settingsV2.activeTtsModelId;
                  const modelServer = getServer(model.serverId);
                  return (
                    <TouchableOpacity
                      key={model.id}
                      style={[
                        s.dropdownItem,
                        isActive && s.dropdownItemActive,
                      ]}
                      onPress={() => selectTtsModel(model)}>
                      <Icon
                        name="volume-up"
                        size={18}
                        color={isActive ? theme.accent : theme.textSecondary}
                      />
                      <View style={{flex: 1}}>
                        <Text
                          style={[
                            s.dropdownItemText,
                            isActive && s.dropdownItemTextActive,
                          ]}
                          numberOfLines={1}>
                          {modelDisplayName(model)}
                          {modelServer ? ` · ${modelServer.name}` : ''}
                        </Text>
                        <View
                          style={{
                            flexDirection: 'row',
                            gap: 4,
                            marginTop: 2,
                            flexWrap: 'wrap',
                          }}>
                          {renderBadges(model.modelId, s)}
                          {model.isFree && (
                            <View style={s.freeBadge}>
                              <Text style={s.freeBadgeText}>FREE</Text>
                            </View>
                          )}
                        </View>
                      </View>
                      {/* Toggle favorito */}
                      <TouchableOpacity
                        onPress={(e) => { e.stopPropagation?.(); toggleFavorite(model); }}
                        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                        style={s.favBtn}>
                        <Icon
                          name={model.isFavorite ? 'star' : 'star-border'}
                          size={20}
                          color={model.isFavorite ? '#e3b341' : theme.textMuted}
                        />
                      </TouchableOpacity>
                      {isActive && (
                        <Icon name="check" size={18} color="#3fb950" />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Modelo TTS ativo selecionado (destaque) */}
            {activeTtsModel && (
              <View style={s.sttModelSelected}>
                <Icon name="check-circle" size={14} color="#2dd4bf" />
                <Text style={s.sttModelSelectedText}>
                  {displayModelName(activeTtsModel.modelId)}
                </Text>
              </View>
            )}

            {/* Voz */}
            <Text style={s.label}>Voz</Text>
            <View style={{flexDirection: 'row', gap: 8, alignItems: 'center'}}>
              <TouchableOpacity
                style={[s.dropdownBtn, {marginTop: 2, flex: 1}]}
                onPress={handleFetchVoices}
                disabled={!ttsServer || !activeTtsModel}>
                <Icon name="record-voice-over" size={20} color={theme.accent} />
                <Text style={s.dropdownBtnText} numberOfLines={1}>
                  {settingsV2.ttsVoice || 'Buscar vozes disponíveis'}
                </Text>
                <Icon name="expand-more" size={18} color={theme.textSecondary} />
              </TouchableOpacity>
              {/* Botão refresh — limpa cache e refaz fetch (FishAudio) */}
              {ttsServer && ttsServer.baseUrl.includes('fish.audio') && fishVoices.length > 0 && (
                <TouchableOpacity
                  style={[s.favBtn, {marginTop: 2}]}
                  onPress={handleRefreshVoices}
                  disabled={fishVoicesLoading}
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <Icon name="refresh" size={20} color={theme.textSecondary} />
                </TouchableOpacity>
              )}
            </View>
            <Text style={s.hint}>
              Toque para carregar as vozes disponíveis. Selecione uma voz para
              testar e definir.
            </Text>

            {/* Lista de vozes com botão de teste (OpenAI/Gemini — fixas) */}
            {ttsVoices.length > 0 && (
              <View style={s.dropdownList}>
                {ttsVoices.map(voice => {
                  const isActive = voice === (settingsV2.ttsVoice ?? '');
                  const isTesting = testingVoice === voice;
                  return (
                    <View
                      key={voice}
                      style={[s.dropdownItem, isActive && s.dropdownItemActive]}>
                      <TouchableOpacity
                        style={{flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8}}
                        onPress={() => onChangeV2({ttsVoice: voice})}>
                        <Icon
                          name={isActive ? 'check-circle' : 'radio-button-unchecked'}
                          size={18}
                          color={isActive ? '#3fb950' : theme.textSecondary}
                        />
                        <Text
                          style={[
                            s.dropdownItemText,
                            isActive && s.dropdownItemTextActive,
                          ]}
                          numberOfLines={1}>
                          {voice}
                        </Text>
                      </TouchableOpacity>
                      {/* Botão de teste */}
                      <TouchableOpacity
                        style={s.favBtn}
                        onPress={() => handleTestVoice(voice)}
                        disabled={isTesting || !ttsServer || !activeTtsModel}
                        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                        {isTesting ? (
                          <ActivityIndicator size={16} color={theme.accent} />
                        ) : (
                          <Icon name="play-arrow" size={20} color={theme.accent} />
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Loading de vozes FishAudio */}
            {fishVoicesLoading && (
              <View style={{flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8}}>
                <ActivityIndicator size={16} color={theme.accent} />
                <Text style={s.hint}>Buscando vozes do FishAudio...</Text>
              </View>
            )}

            {/* Lista de vozes FishAudio (fetch async — title + id) */}
            {fishVoices.length > 0 && (
              <View style={s.dropdownList}>
                {fishVoices.map(fv => {
                  const isActive = fv.id === (settingsV2.ttsVoice ?? '');
                  const isTesting = testingVoice === fv.id;
                  return (
                    <View
                      key={fv.id}
                      style={[s.dropdownItem, isActive && s.dropdownItemActive]}>
                      <TouchableOpacity
                        style={{flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8}}
                        onPress={() => onChangeV2({ttsVoice: fv.id})}>
                        <Icon
                          name={isActive ? 'check-circle' : 'radio-button-unchecked'}
                          size={18}
                          color={isActive ? '#3fb950' : theme.textSecondary}
                        />
                        <View style={{flex: 1}}>
                          <Text
                            style={[
                              s.dropdownItemText,
                              isActive && s.dropdownItemTextActive,
                            ]}
                            numberOfLines={1}>
                            {fv.title}
                          </Text>
                          {fv.languages && fv.languages.length > 0 && (
                            <Text style={s.hint} numberOfLines={1}>
                              {fv.languages.join(', ')}
                            </Text>
                          )}
                        </View>
                      </TouchableOpacity>
                      {/* Botão de teste */}
                      <TouchableOpacity
                        style={s.favBtn}
                        onPress={() => handleTestVoice(fv.id)}
                        disabled={isTesting || !ttsServer || !activeTtsModel}
                        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                        {isTesting ? (
                          <ActivityIndicator size={16} color={theme.accent} />
                        ) : (
                          <Icon name="play-arrow" size={20} color={theme.accent} />
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Botão "Carregar mais 50 vozes" (FishAudio — paginação) */}
            {fishVoices.length > 0 && ttsServer && ttsServer.baseUrl.includes('fish.audio') && (
              <>
                {fishVoicesTotal > 0 && (
                  <Text style={[s.hint, {textAlign: 'center', marginVertical: 4}]}>
                    {fishVoices.length} de {fishVoicesTotal} vozes
                  </Text>
                )}
                {fishVoicesHasMore && (
                  <TouchableOpacity
                    style={[s.dropdownBtn, {marginTop: 4, justifyContent: 'center'}]}
                    onPress={handleLoadMoreVoices}
                    disabled={fishVoicesLoadingMore}>
                    {fishVoicesLoadingMore ? (
                      <>
                        <ActivityIndicator size={16} color={theme.accent} />
                        <Text style={[s.dropdownBtnText, {marginLeft: 8}]}>
                          Carregando...
                        </Text>
                      </>
                    ) : (
                      <>
                        <Icon name="add" size={18} color={theme.accent} />
                        <Text style={[s.dropdownBtnText, {marginLeft: 4}]}>
                          Carregar mais 50 vozes
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}
              </>
            )}
          </Card>

          {/* ====================================================== */}
          {/* Card: Misc — prompt + tema + streaming                 */}
          {/* ====================================================== */}
          <Card title="Misc" icon="settings" theme={theme}>
            {/* Sub-seção: Prompt do Sistema */}
            <Text style={[s.subSectionTitle, {marginTop: 0}]}>
              Prompt do Sistema
            </Text>
            <TextInput
              style={[s.input, s.textarea]}
              value={settingsV2.systemPrompt}
              multiline
              numberOfLines={4}
              onChangeText={v => onChangeV2({systemPrompt: v})}
            />
            <Text style={s.hint}>
              Instruções base que definem o comportamento do assistant.
              Aplicadas ao início de toda conversa.
            </Text>

            {/* Sub-seção: Tema da Interface */}
            <Text style={s.subSectionTitle}>Tema da Interface</Text>
            <View style={{flexDirection: 'row', gap: 8, marginBottom: 6}}>
              <TouchableOpacity
                style={[
                  s.themeOption,
                  settingsV2.theme === 'dark' && s.themeOptionActive,
                ]}
                onPress={() => onChangeV2({theme: 'dark'})}>
                <Icon
                  name="dark-mode"
                  size={20}
                  color={
                    settingsV2.theme === 'dark'
                      ? theme.accent
                      : theme.textSecondary
                  }
                />
                <Text
                  style={[
                    s.themeOptionLabel,
                    settingsV2.theme === 'dark' && s.themeOptionLabelActive,
                  ]}>
                  Escuro
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  s.themeOption,
                  settingsV2.theme === 'light' && s.themeOptionActive,
                ]}
                onPress={() => onChangeV2({theme: 'light'})}>
                <Icon
                  name="light-mode"
                  size={20}
                  color={
                    settingsV2.theme === 'light'
                      ? theme.accent
                      : theme.textSecondary
                  }
                />
                <Text
                  style={[
                    s.themeOptionLabel,
                    settingsV2.theme === 'light' && s.themeOptionLabelActive,
                  ]}>
                  Claro
                </Text>
              </TouchableOpacity>
            </View>

            {/* Sub-seção: Streaming de Respostas */}
            <Text style={s.subSectionTitle}>Streaming de Respostas</Text>
            <TouchableOpacity
              style={s.toggleRow}
              onPress={() =>
                onChangeV2({streamingEnabled: !settingsV2.streamingEnabled})
              }>
              <Text style={s.toggleLabel}>
                Receber respostas em tempo real
              </Text>
              <Icon
                name={streamingCheckboxIcon(settingsV2.streamingEnabled === true)}
                size={24}
                color={
                  settingsV2.streamingEnabled === true
                    ? '#3fb950'
                    : theme.textSecondary
                }
              />
            </TouchableOpacity>
            <Text style={s.hint}>
              Quando ativo, os tokens aparecem conforme chegam (SSE). Desative
              se seu servidor não suporta streaming ou prefere aguardar a
              resposta completa de uma vez.
            </Text>
          </Card>
        </ScrollView>

        {/* ====================================================== */}
        {/* Modal: Editar capabilities de um modelo                 */}
        {/* ====================================================== */}
        <Modal
          visible={editingModel !== null}
          transparent={true}
          animationType="fade"
          onRequestClose={() => setEditingModel(null)}>
          <View style={s.modalOverlay}>
            <View style={s.modalCard}>
              {editingModel && (
                <>
                  <Text style={s.modalTitle} numberOfLines={1}>
                    {modelDisplayName(editingModel)}
                  </Text>
                  <Text style={s.modalSubtitle}>
                    Marque as capacidades deste modelo:
                  </Text>
                  <CapabilityToggle label="Visão (imagem input)" icon="visibility" color="#a371f7"
                    value={!!editingModel.isVision}
                    onToggle={() => setEditingModel({
                      ...editingModel,
                      isVision: !editingModel.isVision,
                    })} />
                  <CapabilityToggle label="STT (transcrição)" icon="mic" color="#f0883e"
                    value={!!editingModel.isStt}
                    onToggle={() => setEditingModel({
                      ...editingModel,
                      isStt: !editingModel.isStt,
                    })} />
                  <CapabilityToggle label="TTS (síntese voz)" icon="volume-up" color="#2dd4bf"
                    value={!!editingModel.isTts}
                    onToggle={() => setEditingModel({
                      ...editingModel,
                      isTts: !editingModel.isTts,
                    })} />
                  <CapabilityToggle label="Image Gen (gera imagem)" icon="image" color="#3fb950"
                    value={!!editingModel.isImageGen}
                    onToggle={() => setEditingModel({
                      ...editingModel,
                      isImageGen: !editingModel.isImageGen,
                    })} />
                  <CapabilityToggle label="Any→Any (multimodal I/O)" icon="all-inclusive" color="#d2a8ff"
                    value={!!editingModel.isAnyToAny}
                    onToggle={() => setEditingModel({
                      ...editingModel,
                      isAnyToAny: !editingModel.isAnyToAny,
                    })} />
                  <View style={s.modalActions}>
                    <TouchableOpacity
                      style={[s.modalBtn, s.modalBtnCancel]}
                      onPress={() => setEditingModel(null)}>
                      <Text style={s.modalBtnText}>Cancelar</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.modalBtn, s.modalBtnSave]}
                      onPress={() => editingModel && saveCapabilities(editingModel, {
                        isVision: editingModel.isVision,
                        isStt: editingModel.isStt,
                        isTts: editingModel.isTts,
                        isImageGen: editingModel.isImageGen,
                        isAnyToAny: editingModel.isAnyToAny,
                      })}>
                      <Text style={s.modalBtnTextSave}>Salvar</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          </View>
        </Modal>

        {/* ====================================================== */}
        {/* Modal: Adicionar API key                                 */}
        {/* ====================================================== */}
        <Modal
          visible={keyModalServer !== null}
          transparent={true}
          animationType="fade"
          onRequestClose={() => { setKeyModalServer(null); setNewKeyValue(''); }}>
          <View style={s.modalOverlay}>
            <View style={s.modalCard}>
              <Text style={s.modalTitle} numberOfLines={1}>
                {keyModalServer?.name ?? 'Servidor'}
              </Text>
              <Text style={s.modalSubtitle}>
                Adicionar nova API key:
              </Text>
              <TextInput
                style={[s.input, {marginTop: 8}]}
                value={newKeyValue}
                onChangeText={setNewKeyValue}
                placeholder="sk-... / AIza..."
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <View style={s.modalActions}>
                <TouchableOpacity
                  style={[s.modalBtn, s.modalBtnCancel]}
                  onPress={() => { setKeyModalServer(null); setNewKeyValue(''); }}>
                  <Text style={s.modalBtnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.modalBtn, s.modalBtnSave]}
                  onPress={() => keyModalServer && handleAddKey(keyModalServer)}>
                  <Text style={s.modalBtnTextSave}>Adicionar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* ====================================================== */}
        {/* Modal: Renomear API key                                  */}
        {/* ====================================================== */}
        <Modal
          visible={renameKeyServer !== null}
          transparent={true}
          animationType="fade"
          onRequestClose={() => setRenameKeyServer(null)}>
          <View style={s.modalOverlay}>
            <View style={s.modalCard}>
              <Text style={s.modalTitle} numberOfLines={1}>
                Renomear Chave #{renameKeyIndex + 1}
              </Text>
              <Text style={s.modalSubtitle}>
                {renameKeyServer?.name ?? 'Servidor'}
              </Text>
              <TextInput
                style={[s.input, {marginTop: 8}]}
                value={renameKeyValue}
                onChangeText={setRenameKeyValue}
                placeholder="Ex: Gemini Pro, Conta trabalho..."
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={40}
              />
              <View style={s.modalActions}>
                <TouchableOpacity
                  style={[s.modalBtn, s.modalBtnCancel]}
                  onPress={() => setRenameKeyServer(null)}>
                  <Text style={s.modalBtnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.modalBtn, s.modalBtnSave]}
                  onPress={() => renameKeyServer && handleRenameKey(renameKeyServer, renameKeyIndex, renameKeyValue)}>
                  <Text style={s.modalBtnTextSave}>Salvar</Text>
                </TouchableOpacity>
              </View>
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
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
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
    /* --- Servidores card --- */
    serverItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    serverItemActive: {
      backgroundColor: t.bgElevated,
    },
    serverItemInfo: {
      flex: 1,
      flexDirection: 'column',
    },
    serverItemName: {
      color: t.text,
      fontSize: 14,
      fontWeight: '600',
    },
    serverItemNameActive: {
      color: t.accent,
    },
    serverItemUrl: {
      color: t.textMuted,
      fontSize: 11,
      fontFamily: 'monospace',
      marginTop: 2,
    },
    serverDeleteBtn: {
      padding: 6,
      marginLeft: 4,
    },
    addServerBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: t.bg,
      borderWidth: 1,
      borderColor: t.accent,
      marginTop: 8,
      borderStyle: 'dashed',
    },
    addServerBtnText: {
      color: t.accent,
      fontSize: 14,
      fontWeight: '600',
    },
    favBtn: {
      padding: 4,
      marginLeft: 4,
    },
    serverModelsList: {
      marginTop: 4,
      marginBottom: 8,
      paddingLeft: 30,
      gap: 2,
    },
    serverModelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: t.bgSurface,
    },
    // --- Swipeable model row ---
    swipeActionsContainer: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      flexDirection: 'row',
      justifyContent: 'flex-end',
    },
    swipeActionBtn: {
      width: ACTION_WIDTH,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
    },
    swipeActionText: {
      fontSize: 10,
      fontWeight: '600',
      color: t.accent,
    },
    swipeRowContent: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      paddingRight: 8,
      backgroundColor: t.bgSurface,
      borderBottomWidth: 1,
      borderBottomColor: t.bg,
    },
    // --- Seção de modelos ocultos ---
    hiddenSectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 8,
      marginTop: 8,
      borderTopWidth: 1,
      borderTopColor: t.border,
    },
    hiddenSectionText: {
      color: t.textSecondary,
      fontSize: 12,
      fontStyle: 'italic',
    },
    hiddenModelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 6,
      opacity: 0.6,
    },
    // --- Modal de edição de capabilities ---
    modalSubtitle: {
      color: t.textSecondary,
      fontSize: 13,
      marginBottom: 8,
    },
    modalActions: {
      flexDirection: 'row',
      gap: 10,
      marginTop: 12,
    },
    modalBtn: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 10,
      alignItems: 'center',
    },
    modalBtnCancel: {
      backgroundColor: t.bg,
      borderWidth: 1,
      borderColor: t.border,
    },
    modalBtnSave: {
      backgroundColor: t.accent,
    },
    modalBtnText: {
      color: t.text,
      fontSize: 14,
      fontWeight: '600',
    },
    modalBtnTextSave: {
      color: t.accentText,
      fontSize: 14,
      fontWeight: '600',
    },
    // --- API Keys management ---
    keySection: {
      marginTop: 10,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: t.border,
    },
    keySectionTitle: {
      color: t.textSecondary,
      fontSize: 13,
      fontWeight: '700',
      marginBottom: 8,
    },
    keyLabel: {
      color: t.text,
      fontSize: 13,
      flex: 1,
    },
    keyRotationRow: {
      flexDirection: 'row',
      gap: 6,
      marginBottom: 10,
    },
    keyRotationBtn: {
      flex: 1,
      paddingVertical: 8,
      borderRadius: 8,
      alignItems: 'center',
      backgroundColor: t.bg,
      borderWidth: 1,
      borderColor: t.border,
    },
    keyRotationBtnActive: {
      backgroundColor: t.accent,
      borderColor: t.accent,
    },
    keyRotationText: {
      color: t.textSecondary,
      fontSize: 12,
      fontWeight: '600',
    },
    keyRotationTextActive: {
      color: t.accentText,
    },
    keyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderRadius: 8,
      backgroundColor: t.bg,
      marginBottom: 4,
    },
    keyRowActive: {
      backgroundColor: t.accent + '15',
      borderWidth: 1,
      borderColor: t.accent + '40',
    },
    keyActiveBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: '#3fb950',
    },
    keyActiveBadgeText: {
      color: '#fff',
      fontSize: 9,
      fontWeight: '700',
    },
    keyCooldownBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: '#f0883e',
    },
    keyCooldownBadgeText: {
      color: '#fff',
      fontSize: 9,
      fontWeight: '700',
    },
    keyActionBtn: {
      padding: 4,
    },
    // Cooldown selector (failover only)
    keyCooldownRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 10,
      marginTop: 4,
      flexWrap: 'wrap',
    },
    keyCooldownBtn: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: t.bg,
      borderWidth: 1,
      borderColor: t.border,
    },
    keyCooldownText: {
      color: t.textSecondary,
      fontSize: 12,
      fontWeight: '600',
    },
  });
}
