/**
 * OnboardingScreen — primeira abertura do app.
 *
 * Fluxo:
 * 1. Welcome (escolher Online vs Local)
 * 2. Grid de presets (Online) ou campo URL (Local)
 * 3. API key (se necessário)
 * 4. Fetch modelos → lista para marcar favoritos
 * 5. Concluir → salva server + models + seta active em settingsV2
 *
 * Conforme design doc seção 4.1.
 */

import React, {useState, useCallback} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  StatusBar,
  ActivityIndicator,
  FlatList,
  Alert,
} from 'react-native';
import Icon from '@react-native-vector-icons/material-icons';
import {ThemeColors, getTheme} from '../utils/theme';
import {SERVER_PRESETS, ServerPreset, fetchModels} from '../services/ServerService';
import {createServer, getAllServers} from '../data/serverDb';
import {syncModelsFromFetch, saveModel, getModelsByServer} from '../data/modelDb';
import {saveApiKey} from '../data/keychainDb';
import {
  loadSettingsV2,
  saveSettingsV2,
  patchSettingsV2,
  migrateToV2,
} from '../data/appSettings';
import {AppSettingsV2, ServerEntry, ModelEntry} from '../types';

type Step = 'welcome' | 'preset' | 'apikey' | 'models' | 'done';

interface Props {
  onConclude: () => void;
}

export function OnboardingScreen({onConclude}: Props) {
  const theme = getTheme('dark'); // onboarding sempre dark (ainda não tem settings)
  const [step, setStep] = useState<Step>('welcome');
  const [isOnline, setIsOnline] = useState(true);

  // Preset selecionado (ou null = custom)
  const [selectedPreset, setSelectedPreset] = useState<ServerPreset | null>(null);
  const [customUrl, setCustomUrl] = useState('');
  const [customName, setCustomName] = useState('');

  // API key
  const [apiKey, setApiKey] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Modelos fetched
  const [fetchedModelIds, setFetchedModelIds] = useState<string[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

  // Server criado (após selecionar preset e antes do fetch)
  const [createdServer, setCreatedServer] = useState<ServerEntry | null>(null);

  // --- Handlers ---

  const handleChooseOnline = () => {
    setIsOnline(true);
    setStep('preset');
  };

  const handleChooseLocal = () => {
    setIsOnline(false);
    // Local =preset Ollama direto
    const ollamaPreset = SERVER_PRESETS.find(p => p.format === 'ollama')!;
    setSelectedPreset(ollamaPreset);
    setCustomUrl(ollamaPreset.url);
    setStep('apikey'); // local não tem API key, mas passamos pelo step para chegar no fetch
  };

  const handleSelectPreset = (preset: ServerPreset) => {
    setSelectedPreset(preset);
    setCustomUrl(preset.url);
    // Pollinations não precisa de API key → pular step de key
    if (preset.format === 'pollinations') {
      createServerAndFetch(preset, preset.url, '');
    } else {
      setStep('apikey');
    }
  };

  const handleSelectCustom = () => {
    setSelectedPreset(null);
    setCustomUrl('');
    setCustomName('');
    setStep('apikey');
  };

  const handleFetchModels = async () => {
    const preset = selectedPreset;
    const url = customUrl.trim();
    if (!url) {
      Alert.alert('URL obrigatória', 'Digite a URL do servidor.');
      return;
    }

    // Servidor local não precisa de API key
    const needsKey = preset ? preset.format !== 'ollama' && preset.format !== 'pollinations' : true;

    if (needsKey && !apiKey.trim()) {
      Alert.alert('API Key obrigatória', 'Digite sua API key para este servidor.');
      return;
    }

    const name = preset?.name ?? (customName.trim() || 'Servidor Personalizado');
    const format = preset?.format ?? 'openai';
    const icon = preset?.icon ?? 'dns';
    const hasFree = preset?.hasFreeModels ?? false;

    await createServerAndFetch(
      {name, url, format, icon, hasFreeModels: hasFree, description: ''},
      url,
      apiKey.trim(),
    );
  };

  /**
   * Cria o ServerEntry, salva a API key no Keychain, e faz fetch de modelos.
   */
  const createServerAndFetch = async (
    serverInfo: Omit<ServerPreset, 'description'> & {description?: string},
    url: string,
    key: string,
  ) => {
    setFetching(true);
    setFetchError(null);

    try {
      // Cria servidor
      const server = createServer({
        name: serverInfo.name,
        baseUrl: url,
        format: serverInfo.format as ServerEntry['format'],
        icon: serverInfo.icon,
        hasFreeModels: serverInfo.hasFreeModels,
        apiKeyCount: key ? 1 : 0,
        keyRotation: 'single',
        activeKeyIndex: 0,
      });
      setCreatedServer(server);

      // Salva API key no Keychain (se houver)
      if (key) {
        await saveApiKey(server.id, 0, key);
      }

      // Fetch modelos
      const modelIds = await fetchModels(server, key);
      setFetchedModelIds(modelIds);
      setStep('models');
    } catch (e: any) {
      setFetchError(e?.message ?? 'Erro ao buscar modelos');
      Alert.alert(
        'Erro ao buscar modelos',
        e?.message ?? 'Verifique a URL e API key.',
      );
    } finally {
      setFetching(false);
    }
  };

  const toggleFavorite = (modelId: string) => {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const handleConclude = () => {
    if (!createdServer) {
      onConclude();
      return;
    }

    // Sincroniza modelos no DB (cria ModelEntry para cada um)
    const {added} = syncModelsFromFetch(createdServer.id, fetchedModelIds);

    // Marca favoritos
    const models = getModelsByServer(createdServer.id);
    for (const model of models) {
      if (favoriteIds.has(model.modelId)) {
        saveModel({...model, isFavorite: true});
      }
    }

    // Atualiza settings V2
    const settings = loadSettingsV2();
    const firstFavorite = models.find(m => favoriteIds.has(m.modelId));
    const activeModel = firstFavorite ?? models[0];

    const updated: AppSettingsV2 = {
      ...settings,
      migrated: true,
      activeServerId: createdServer.id,
      activeModelId: activeModel?.id ?? null,
    };
    saveSettingsV2(updated);

    setStep('done');
    onConclude();
  };

  // --- Render ---

  return (
    <SafeAreaView style={[styles.container, {backgroundColor: theme.bg}]}>
      <StatusBar backgroundColor={theme.bg} barStyle={theme.statusBar} translucent={false} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {step === 'welcome' && renderWelcome(theme)}
        {step === 'preset' && renderPresetGrid(theme)}
        {step === 'apikey' && renderApiKey(theme)}
        {step === 'models' && renderModels(theme)}
      </ScrollView>
    </SafeAreaView>
  );

  // --- Step renderers ---

  function renderWelcome(t: ThemeColors) {
    return (
      <View style={styles.centerContainer}>
        <Icon name="auto-awesome" size={64} color={t.accent} />
        <Text style={[styles.welcomeTitle, {color: t.text}]}>Bem-vindo ao BeMore</Text>
        <Text style={[styles.welcomeSubtitle, {color: t.textSecondary}]}>
          Como você vai se conectar?
        </Text>

        <TouchableOpacity
          style={[styles.choiceCard, {backgroundColor: t.bgSurface, borderColor: t.border}]}
          onPress={handleChooseOnline}
          activeOpacity={0.7}
        >
          <Icon name="cloud" size={40} color={t.accent} />
          <View style={styles.choiceText}>
            <Text style={[styles.choiceTitle, {color: t.text}]}>Servidor Online</Text>
            <Text style={[styles.choiceDesc, {color: t.textSecondary}]}>
              Groq, OpenRouter, Google AI Studio e mais
            </Text>
          </View>
          <Icon name="chevron-right" size={24} color={t.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.choiceCard, {backgroundColor: t.bgSurface, borderColor: t.border}]}
          onPress={handleChooseLocal}
          activeOpacity={0.7}
        >
          <Icon name="dns" size={40} color={t.accent} />
          <View style={styles.choiceText}>
            <Text style={[styles.choiceTitle, {color: t.text}]}>Servidor Local</Text>
            <Text style={[styles.choiceDesc, {color: t.textSecondary}]}>
              Ollama ou LM Studio na sua máquina
            </Text>
          </View>
          <Icon name="chevron-right" size={24} color={t.textMuted} />
        </TouchableOpacity>
      </View>
    );
  }

  function renderPresetGrid(t: ThemeColors) {
    return (
      <View>
        <Text style={[styles.stepTitle, {color: t.text}]}>Escolha um provedor</Text>
        <Text style={[styles.stepSubtitle, {color: t.textSecondary}]}>
          Selecione um servidor pré-configurado ou crie um personalizado.
        </Text>

        <View style={styles.presetGrid}>
          {SERVER_PRESETS.filter(p => isOnline ? p.format !== 'ollama' : p.format === 'ollama' || p.format === 'openai')
            .filter(p => isOnline ? p.format !== 'pollinations' || true : true)
            .map(preset => (
            <TouchableOpacity
              key={preset.name}
              style={[styles.presetCard, {backgroundColor: t.bgSurface, borderColor: t.border}]}
              onPress={() => handleSelectPreset(preset)}
              activeOpacity={0.7}
            >
              <Icon name={preset.icon as any} size={32} color={t.accent} />
              <Text style={[styles.presetName, {color: t.text}]} numberOfLines={1}>
                {preset.name}
              </Text>
              <Text style={[styles.presetDesc, {color: t.textMuted}]} numberOfLines={2}>
                {preset.description}
              </Text>
              {preset.hasFreeModels && (
                <View style={[styles.freeBadge, {backgroundColor: t.accent + '20'}]}>
                  <Text style={[styles.freeBadgeText, {color: t.accent}]}>FREE</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}

          {/* Card "Personalizado" */}
          <TouchableOpacity
            style={[styles.presetCard, {backgroundColor: t.bgSurface, borderColor: t.border}]}
            onPress={handleSelectCustom}
            activeOpacity={0.7}
          >
            <Icon name="add-circle-outline" size={32} color={t.textSecondary} />
            <Text style={[styles.presetName, {color: t.text}]}>Personalizado</Text>
            <Text style={[styles.presetDesc, {color: t.textMuted}]}>
              Configurar URL manualmente
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={() => setStep('welcome')}>
          <Text style={[styles.backText, {color: t.textSecondary}]}>← Voltar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  function renderApiKey(t: ThemeColors) {
    const isLocal = selectedPreset?.format === 'ollama';
    const isPollinations = selectedPreset?.format === 'pollinations';

    return (
      <View>
        <Text style={[styles.stepTitle, {color: t.text}]}>
          {isLocal ? 'Confirmar servidor local' : 'Configurar servidor'}
        </Text>
        <Text style={[styles.stepSubtitle, {color: t.textSecondary}]}>
          {selectedPreset?.name ?? 'Personalizado'}
        </Text>

        {/* URL */}
        <Text style={[styles.inputLabel, {color: t.textSecondary}]}>URL do servidor</Text>
        <TextInput
          style={[styles.input, {backgroundColor: t.bgSurface, color: t.text, borderColor: t.border}]}
          value={customUrl}
          onChangeText={setCustomUrl}
          placeholder="https://api.exemplo.com/v1"
          placeholderTextColor={t.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        {/* Nome custom (só se preset = null) */}
        {!selectedPreset && (
          <>
            <Text style={[styles.inputLabel, {color: t.textSecondary}]}>Nome (opcional)</Text>
            <TextInput
              style={[styles.input, {backgroundColor: t.bgSurface, color: t.text, borderColor: t.border}]}
              value={customName}
              onChangeText={setCustomName}
              placeholder="Meu Servidor"
              placeholderTextColor={t.textMuted}
            />
          </>
        )}

        {/* API Key (não mostra para local/pollinations) */}
        {!isLocal && !isPollinations && (
          <>
            <Text style={[styles.inputLabel, {color: t.textSecondary}]}>API Key</Text>
            <TextInput
              style={[styles.input, {backgroundColor: t.bgSurface, color: t.text, borderColor: t.border}]}
              value={apiKey}
              onChangeText={setApiKey}
              placeholder="sk-..."
              placeholderTextColor={t.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          </>
        )}

        {fetchError && (
          <Text style={styles.errorText}>{fetchError}</Text>
        )}

        <TouchableOpacity
          style={[styles.primaryButton, {backgroundColor: t.accent}]}
          onPress={handleFetchModels}
          disabled={fetching}
          activeOpacity={0.7}
        >
          {fetching ? (
            <ActivityIndicator color={t.accentText} />
          ) : (
            <Text style={[styles.primaryButtonText, {color: t.accentText}]}>
              Buscar modelos
            </Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setStep('preset')}>
          <Text style={[styles.backText, {color: t.textSecondary}]}>← Voltar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  function renderModels(t: ThemeColors) {
    return (
      <View style={{flex: 1}}>
        <Text style={[styles.stepTitle, {color: t.text}]}>Modelos disponíveis</Text>
        <Text style={[styles.stepSubtitle, {color: t.textSecondary}]}>
          Toque na estrela para marcar seus favoritos. Você poderá mudar depois.
        </Text>

        {fetchedModelIds.length === 0 ? (
          <View style={styles.emptyState}>
            <Icon name="info-outline" size={48} color={t.textMuted} />
            <Text style={[styles.emptyText, {color: t.textSecondary}]}>
              Nenhum modelo encontrado. Verifique se o servidor está rodando.
            </Text>
          </View>
        ) : (
          <FlatList
            data={fetchedModelIds}
            keyExtractor={item => item}
            renderItem={({item}) => {
              const isFav = favoriteIds.has(item);
              return (
                <TouchableOpacity
                  style={[styles.modelRow, {backgroundColor: t.bgSurface, borderColor: t.border}]}
                  onPress={() => toggleFavorite(item)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.modelId, {color: t.text}]} numberOfLines={1}>
                    {item}
                  </Text>
                  <Icon
                    name={isFav ? 'star' : 'star-border'}
                    size={24}
                    color={isFav ? '#f5a623' : t.textMuted}
                  />
                </TouchableOpacity>
              );
            }}
            style={{maxHeight: 400}}
          />
        )}

        <TouchableOpacity
          style={[styles.primaryButton, {backgroundColor: t.accent}]}
          onPress={handleConclude}
          activeOpacity={0.7}
        >
          <Text style={[styles.primaryButtonText, {color: t.accentText}]}>
            Concluir
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setStep('apikey')}>
          <Text style={[styles.backText, {color: t.textSecondary}]}>← Voltar</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    padding: 20,
    flexGrow: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 500,
  },
  welcomeTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    marginTop: 16,
    marginBottom: 4,
  },
  welcomeSubtitle: {
    fontSize: 16,
    marginBottom: 32,
  },
  choiceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    width: '100%',
    gap: 16,
  },
  choiceText: {
    flex: 1,
  },
  choiceTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 2,
  },
  choiceDesc: {
    fontSize: 14,
  },
  stepTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  stepSubtitle: {
    fontSize: 14,
    marginBottom: 24,
  },
  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  presetCard: {
    width: '48%',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    alignItems: 'center',
    minHeight: 120,
    gap: 6,
  },
  presetName: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  presetDesc: {
    fontSize: 12,
    textAlign: 'center',
  },
  freeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 4,
  },
  freeBadgeText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
  },
  primaryButton: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 24,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  backText: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 16,
    marginBottom: 8,
  },
  errorText: {
    color: '#f85149',
    fontSize: 14,
    marginTop: 8,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 6,
  },
  modelId: {
    fontSize: 15,
    flex: 1,
    marginRight: 12,
  },
  emptyState: {
    alignItems: 'center',
    padding: 40,
    gap: 12,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
});
