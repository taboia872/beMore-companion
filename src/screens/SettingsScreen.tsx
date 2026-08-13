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
import {AppSettingsV2, ServerEntry, ModelEntry, ServerFormat} from '../types';
import {
  getAllServers,
  getServer,
  deleteServerCascade,
} from '../data/serverDb';
import {
  getModelsByServer,
  getAllModels,
  getModel,
} from '../data/modelDb';
import {loadSettingsV2, patchSettingsV2} from '../data/appSettings';
import {shortModelName, displayModelName} from '../utils/modelName';
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
  settingsV2: AppSettingsV2;
  onChangeV2: (patch: Partial<AppSettingsV2>) => void;
  onClose: () => void;
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

// --- Helpers para formatar badges (reutilizam getModelBadges por modelId) ---

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

/** Gera badges visíveis para imageGen + as capabilities do getModelBadges. */
function renderAllBadges(
  model: ModelEntry,
  styles: ReturnType<typeof getStyles>,
): React.ReactNode {
  const capBadges = renderBadges(model.modelId, styles);
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

export function SettingsScreen({settingsV2, onChangeV2, onClose}: Props) {
  const theme = getTheme(settingsV2.theme);
  const s = getStyles(theme);

  // Drop downs abertos
  const [serverDropdownOpen, setServerDropdownOpen] = useState(false);
  const [sttServerDropdownOpen, setSttServerDropdownOpen] = useState(false);
  const [ttsServerDropdownOpen, setTtsServerDropdownOpen] = useState(false);

  // Estado de loading p/ delete de servidor
  const [deleting, setDeleting] = useState(false);

  // --- Dados (síncronos, MMKV) ---

  const allServers: ServerEntry[] = getAllServers();

  const activeServerId = settingsV2.activeServerId;
  const activeServer = activeServerId ? getServer(activeServerId) : null;

  // Modelos do servidor ativo (chat/LLM) — apenas visíveis (não-hidden)
  const serverModels: ModelEntry[] = activeServerId
    ? getModelsByServer(activeServerId).filter(m => !m.isHidden)
    : [];

  // Modelos STT de todos os servidores (isStt === true)
  const allModels: ModelEntry[] = getAllModels();
  const sttModels: ModelEntry[] = allModels.filter(
    m => m.isStt === true && !m.isHidden,
  );
  const ttsModels: ModelEntry[] = allModels.filter(
    m => m.isTts === true && !m.isHidden,
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

  const selectServer = (server: ServerEntry) => {
    setServerDropdownOpen(false);
    onChangeV2({activeServerId: server.id, activeModelId: null});
  };

  const selectModel = (model: ModelEntry) => {
    onChangeV2({activeModelId: model.id});
  };

  const selectSttModel = (model: ModelEntry) => {
    onChangeV2({activeSttModelId: model.id});
  };

  const selectTtsModel = (model: ModelEntry) => {
    onChangeV2({activeTtsModelId: model.id});
  };

  const selectSttServer = (serverId: string | null) => {
    setSttServerDropdownOpen(false);
    onChangeV2({sttServerId: serverId});
  };

  const selectTtsServer = (serverId: string | null) => {
    setTtsServerDropdownOpen(false);
    onChangeV2({ttsServerId: serverId});
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

  const formatBadgeColor = (format: ServerFormat): string => {
    switch (format) {
      case 'openai':
        return '#10a37f';
      case 'gemini':
        return '#4285f4';
      case 'ollama':
        return '#6d4aff';
      case 'pollinations':
        return '#e84393';
      default:
        return '#8b949e';
    }
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

  // Nome do servidor STT/TTS selecionado (ou "mesmo do chat")
  const sttServerName = settingsV2.sttServerId
    ? getServer(settingsV2.sttServerId)?.name ?? 'Servidor removido'
    : 'Igual ao servidor de chat';
  const ttsServerName = settingsV2.ttsServerId
    ? getServer(settingsV2.ttsServerId)?.name ?? 'Servidor removido'
    : 'Igual ao servidor de chat';

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
          {/* Card: Servidores — lista de servidores cadastrados     */}
          {/* ====================================================== */}
          <Card
            title="Servidores"
            icon="dns"
            defaultExpanded={true}
            theme={theme}>
            {allServers.length === 0 ? (
              <>
                <Text style={s.hint}>
                  Nenhum servidor cadastrado. Use o onboarding para adicionar
                  servidores.
                </Text>
                <TouchableOpacity
                  style={s.addServerBtn}
                  onPress={() =>
                    Alert.alert(
                      'Adicionar servidor',
                      'Use o onboarding para adicionar servidores.',
                    )
                  }>
                  <Icon name="add" size={20} color={theme.accentText} />
                  <Text style={s.addServerBtnText}>Adicionar servidor</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                {allServers.map(server => {
                  const isActive = server.id === settingsV2.activeServerId;
                  const badgeColor = formatBadgeColor(server.format);
                  return (
                    <TouchableOpacity
                      key={server.id}
                      style={[s.serverItem, isActive && s.serverItemActive]}
                      onPress={() => selectServer(server)}
                      disabled={isActive}>
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
                      {/* Format badge */}
                      <View
                        style={[s.formatBadge, {backgroundColor: badgeColor}]}>
                        <Text style={s.formatBadgeText}>
                          {server.format.toUpperCase()}
                        </Text>
                      </View>
                      {/* Free badge */}
                      {server.hasFreeModels && (
                        <View style={s.freeBadge}>
                          <Text style={s.freeBadgeText}>FREE</Text>
                        </View>
                      )}
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
                      {isActive && (
                        <Icon name="check" size={18} color="#3fb950" />
                      )}
                    </TouchableOpacity>
                  );
                })}

                {/* Botão adicionar servidor */}
                <TouchableOpacity
                  style={s.addServerBtn}
                  onPress={() =>
                    Alert.alert(
                      'Adicionar servidor',
                      'Use o onboarding para adicionar servidores.',
                    )
                  }>
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
            defaultExpanded={true}
            theme={theme}>
            {/* Dropdown de servidor ativo */}
            <Text style={s.label}>Servidor ativo</Text>
            <TouchableOpacity
              style={s.dropdownBtn}
              onPress={() => setServerDropdownOpen(v => !v)}>
              <Icon
                name={(activeServer?.icon ?? 'dns') as any}
                size={20}
                color={theme.accent}
              />
              <Text style={s.dropdownBtnText} numberOfLines={1}>
                {activeServer?.name ?? 'Nenhum servidor selecionado'}
              </Text>
              <Icon
                name={serverDropdownOpen ? 'expand-less' : 'expand-more'}
                size={22}
                color={theme.textSecondary}
              />
            </TouchableOpacity>

            {serverDropdownOpen && (
              <View style={s.dropdownList}>
                {allServers.map(server => {
                  const isActive = server.id === settingsV2.activeServerId;
                  return (
                    <TouchableOpacity
                      key={server.id}
                      style={[
                        s.dropdownItem,
                        isActive && s.dropdownItemActive,
                      ]}
                      onPress={() => selectServer(server)}>
                      <Icon
                        name={server.icon as any}
                        size={18}
                        color={isActive ? theme.accent : theme.textSecondary}
                      />
                      <Text
                        style={[
                          s.dropdownItemText,
                          isActive && s.dropdownItemTextActive,
                        ]}
                        numberOfLines={1}>
                        {server.name}
                      </Text>
                      {isActive && (
                        <Icon name="check" size={18} color="#3fb950" />
                      )}
                    </TouchableOpacity>
                  );
                })}
                {allServers.length === 0 && (
                  <Text style={s.emptyText}>Nenhum servidor cadastrado.</Text>
                )}
              </View>
            )}

            {activeServer && (
              <Text style={s.urlDisplay} numberOfLines={2}>
                {activeServer.baseUrl}
              </Text>
            )}

            {/* Lista de modelos do servidor ativo */}
            <Text style={s.label}>Modelo</Text>
            {!activeServerId ? (
              <Text style={s.hint}>
                Selecione um servidor acima para ver os modelos disponíveis.
              </Text>
            ) : sortedServerModels.length === 0 ? (
              <Text style={s.hint}>
                Nenhum modelo. Volte ao onboarding ou adicione um servidor para
                buscar modelos.
              </Text>
            ) : (
              <View style={s.dropdownList}>
                {sortedServerModels.map(model => {
                  const isActive = model.id === settingsV2.activeModelId;
                  return (
                    <TouchableOpacity
                      key={model.id}
                      style={[
                        s.dropdownItem,
                        isActive && s.dropdownItemActive,
                      ]}
                      onPress={() => selectModel(model)}>
                      <Icon
                        name={model.isFavorite ? 'star' : 'memory'}
                        size={18}
                        color={isActive ? theme.accent : model.isFavorite ? '#e3b341' : theme.textSecondary}
                      />
                      <View style={{flex: 1}}>
                        <Text
                          style={[
                            s.dropdownItemText,
                            isActive && s.dropdownItemTextActive,
                          ]}
                          numberOfLines={1}>
                          {modelDisplayName(model)}
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
          {/* Card: Voz (STT) — toggle online/on-device + modelo     */}
          {/* ====================================================== */}
          <Card title="Voz (STT)" icon="mic" theme={theme}>
            {/* Toggle: Online ↔ On-device */}
            <View style={s.row}>
              <TouchableOpacity
                style={[s.tab, settingsV2.sttMode === 'online' && s.tabActive]}
                onPress={() => onChangeV2({sttMode: 'online'})}>
                <Icon
                  name="cloud-queue"
                  size={18}
                  color={
                    settingsV2.sttMode === 'online'
                      ? theme.accentText
                      : theme.textSecondary
                  }
                />
                <Text
                  style={[
                    s.tabText,
                    settingsV2.sttMode === 'online' && s.tabTextActive,
                  ]}>
                  Online
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  s.tab,
                  settingsV2.sttMode === 'on-device' && s.tabActive,
                ]}
                onPress={() => onChangeV2({sttMode: 'on-device'})}>
                <Icon
                  name="smartphone"
                  size={18}
                  color={
                    settingsV2.sttMode === 'on-device'
                      ? theme.accentText
                      : theme.textSecondary
                  }
                />
                <Text
                  style={[
                    s.tabText,
                    settingsV2.sttMode === 'on-device' && s.tabTextActive,
                  ]}>
                  On-device
                </Text>
              </TouchableOpacity>
            </View>

            {settingsV2.sttMode === 'on-device' ? (
              <>
                <Text style={s.hint}>
                  Modelo Whisper GGUF no dispositivo. Deixe vazio para
                  desativar. Ex: ggml-tiny.bin (~75 MB).
                </Text>
                <Text style={s.label}>Caminho do modelo</Text>
                <TextInput
                  style={s.input}
                  value={settingsV2.sttModelPath ?? ''}
                  placeholder="/data/data/com.bemore.companion/files/models/ggml-tiny.bin"
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={v => onChangeV2({sttModelPath: v})}
                />
              </>
            ) : (
              <>
                <Text style={s.hint}>
                  Transcrição via API online (Groq, OpenAI, etc). Escolha o
                  servidor e modelo STT abaixo.
                </Text>

                {/* Servidor STT (override) — null = mesmo do chat */}
                <Text style={s.label}>Servidor STT</Text>
                <TouchableOpacity
                  style={s.dropdownBtn}
                  onPress={() => setSttServerDropdownOpen(v => !v)}>
                  <Icon
                    name="cloud-queue"
                    size={20}
                    color={theme.accent}
                  />
                  <Text style={s.dropdownBtnText} numberOfLines={1}>
                    {sttServerName}
                  </Text>
                  <Icon
                    name={
                      sttServerDropdownOpen ? 'expand-less' : 'expand-more'
                    }
                    size={22}
                    color={theme.textSecondary}
                  />
                </TouchableOpacity>

                {sttServerDropdownOpen && (
                  <View style={s.dropdownList}>
                    {/* Null = same as chat server */}
                    <TouchableOpacity
                      style={[
                        s.dropdownItem,
                        settingsV2.sttServerId === null &&
                          s.dropdownItemActive,
                      ]}
                      onPress={() => selectSttServer(null)}>
                      <Icon
                        name="repeat"
                        size={18}
                        color={
                          settingsV2.sttServerId === null
                            ? theme.accent
                            : theme.textSecondary
                        }
                      />
                      <Text
                        style={[
                          s.dropdownItemText,
                          settingsV2.sttServerId === null &&
                            s.dropdownItemTextActive,
                        ]}
                        numberOfLines={1}>
                        Igual ao servidor de chat
                      </Text>
                      {settingsV2.sttServerId === null && (
                        <Icon name="check" size={18} color="#3fb950" />
                      )}
                    </TouchableOpacity>
                    {allServers.map(server => {
                      const isActive = server.id === settingsV2.sttServerId;
                      return (
                        <TouchableOpacity
                          key={server.id}
                          style={[
                            s.dropdownItem,
                            isActive && s.dropdownItemActive,
                          ]}
                          onPress={() => selectSttServer(server.id)}>
                          <Icon
                            name={server.icon as any}
                            size={18}
                            color={
                              isActive ? theme.accent : theme.textSecondary
                            }
                          />
                          <Text
                            style={[
                              s.dropdownItemText,
                              isActive && s.dropdownItemTextActive,
                            ]}
                            numberOfLines={1}>
                            {server.name}
                          </Text>
                          {isActive && (
                            <Icon name="check" size={18} color="#3fb950" />
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                {/* Lista de modelos STT (de todos os servidores) */}
                <Text style={s.label}>Modelo STT online</Text>
                {sortedSttModels.length === 0 ? (
                  <Text style={s.hint}>
                    Nenhum modelo STT encontrado. Volte ao onboarding ou
                    adicione um servidor com modelos de transcrição.
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
                            name={model.isFavorite ? 'star' : 'mic'}
                            size={18}
                            color={
                              isActive
                                ? theme.accent
                                : model.isFavorite
                                ? '#e3b341'
                                : theme.textSecondary
                            }
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
              </>
            )}
          </Card>

          {/* ====================================================== */}
          {/* Card: Voz (TTS) — síntese de áudio                     */}
          {/* ====================================================== */}
          <Card title="Voz (TTS)" icon="volume-up" theme={theme}>
            <Text style={s.hint}>
              Síntese de voz via API online (Groq TTS, OpenAI TTS, etc). Escolha
              o servidor e modelo TTS abaixo.
            </Text>

            {/* Servidor TTS (override) — null = mesmo do chat */}
            <Text style={s.label}>Servidor TTS</Text>
            <TouchableOpacity
              style={s.dropdownBtn}
              onPress={() => setTtsServerDropdownOpen(v => !v)}>
              <Icon name="cloud-queue" size={20} color={theme.accent} />
              <Text style={s.dropdownBtnText} numberOfLines={1}>
                {ttsServerName}
              </Text>
              <Icon
                name={ttsServerDropdownOpen ? 'expand-less' : 'expand-more'}
                size={22}
                color={theme.textSecondary}
              />
            </TouchableOpacity>

            {ttsServerDropdownOpen && (
              <View style={s.dropdownList}>
                <TouchableOpacity
                  style={[
                    s.dropdownItem,
                    settingsV2.ttsServerId === null && s.dropdownItemActive,
                  ]}
                  onPress={() => selectTtsServer(null)}>
                  <Icon
                    name="repeat"
                    size={18}
                    color={
                      settingsV2.ttsServerId === null
                        ? theme.accent
                        : theme.textSecondary
                    }
                  />
                  <Text
                    style={[
                      s.dropdownItemText,
                      settingsV2.ttsServerId === null &&
                        s.dropdownItemTextActive,
                    ]}
                    numberOfLines={1}>
                    Igual ao servidor de chat
                  </Text>
                  {settingsV2.ttsServerId === null && (
                    <Icon name="check" size={18} color="#3fb950" />
                  )}
                </TouchableOpacity>
                {allServers.map(server => {
                  const isActive = server.id === settingsV2.ttsServerId;
                  return (
                    <TouchableOpacity
                      key={server.id}
                      style={[
                        s.dropdownItem,
                        isActive && s.dropdownItemActive,
                      ]}
                      onPress={() => selectTtsServer(server.id)}>
                      <Icon
                        name={server.icon as any}
                        size={18}
                        color={isActive ? theme.accent : theme.textSecondary}
                      />
                      <Text
                        style={[
                          s.dropdownItemText,
                          isActive && s.dropdownItemTextActive,
                        ]}
                        numberOfLines={1}>
                        {server.name}
                      </Text>
                      {isActive && (
                        <Icon name="check" size={18} color="#3fb950" />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Lista de modelos TTS (de todos os servidores) */}
            <Text style={s.label}>Modelo TTS</Text>
            {sortedTtsModels.length === 0 ? (
              <Text style={s.hint}>
                Nenhum modelo TTS encontrado. Volte ao onboarding ou adicione
                um servidor com modelos de síntese de voz.
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
                        name={model.isFavorite ? 'star' : 'volume-up'}
                        size={18}
                        color={
                          isActive
                            ? theme.accent
                            : model.isFavorite
                            ? '#e3b341'
                            : theme.textSecondary
                        }
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
            <TextInput
              style={s.input}
              value={settingsV2.ttsVoice ?? ''}
              placeholder="alloy, nova, shimmer, echo, fable, onyx"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={v => onChangeV2({ttsVoice: v})}
            />
            <Text style={s.hint}>
              Vozes podem variar por provedor. OpenAI/Groq: alloy, nova,
              shimmer, echo, fable, onyx. Deixe vazio para alloy.
            </Text>
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
    formatBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    formatBadgeText: {
      color: t.accentText,
      fontSize: 10,
      fontWeight: '700',
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
  });
}
