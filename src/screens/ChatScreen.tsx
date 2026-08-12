import React, {useState, useRef, useEffect} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Alert,
  SafeAreaView,
  StatusBar,
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  UIManager,
  KeyboardAvoidingView,
  Image as RNImage,
  ActionSheetIOS,
  ScrollView,
  Modal,
  Dimensions,
  PermissionsAndroid,
  Animated,
  Easing,
} from 'react-native';
import Icon from '@react-native-vector-icons/material-icons';
import {Clipboard} from 'react-native';
import {AppSettings, Message, MessageStatus, ContentPart} from '../types';
import {streamResponse, abortGeneration} from '../services/LlmService';
import {useRecorder} from '../hooks/useRecorder';
import {useWhisper} from '../hooks/useWhisper';
import {displayModelName} from '../utils/modelName';
import {getTextContent, getImageUrls, hasImages} from '../utils/messageContent';
import Markdown from '@ronradtke/react-native-markdown-display';
import {launchCamera, launchImageLibrary} from 'react-native-image-picker';
import {speakText, stopSpeaking} from '../services/TtsService';
import {loadApiKeyForServer} from '../data/appSettings';
import {getTheme} from '../utils/theme';
import type {ThemeColors} from '../utils/theme';

// Habilita LayoutAnimation p/ animar expansão/colapso do thinking no Android.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Indicador de "typing" — três pontos que pulam em sequência (feedback
// visual de que o modelo está processando). Animação em loop infinito.
function TypingDots() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setActive(a => (a + 1) % 3);
    }, 400);
    return () => clearInterval(interval);
  }, []);
  return (
    <View style={{flexDirection: 'row', gap: 3, marginLeft: 2}}>
      {[0, 1, 2].map(i => (
        <View
          key={i}
          style={[
            {
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: '#30363d',
            },
            active === i && {backgroundColor: '#58a6ff'},
          ]}
        />
      ))}
    </View>
  );
}

/**
 * WaveformAnimation — barras animadas simulando captação de áudio.
 * Substitui o ActivityIndicator quando o gravador está ativo (recording).
 * Cada barra tem altura animada com loop infinito e delays escalonados.
 */
const BAR_COUNT = 5;
const BAR_MIN_HEIGHT = 6;
const BAR_MAX_HEIGHT = 26;

function WaveformAnimation() {
  // Array de Animated.Value uma por barra
  const [bars] = useState(() =>
    Array.from({length: BAR_COUNT}, () => new Animated.Value(BAR_MIN_HEIGHT)),
  );

  useEffect(() => {
    // Cada barra sobe e desce num loop com delay escalonado.
    // A animação é suave e não bloqueia o JS thread (useNativeDriver implícito
    // para height? Não — height não é supported por native driver. Mas é leve
    // o suficiente com 5 barras para não causar jank.)
    const animations = bars.map((bar, i) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(i * 90),
          Animated.timing(bar, {
            toValue: BAR_MAX_HEIGHT,
            duration: 400,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
          Animated.timing(bar, {
            toValue: BAR_MIN_HEIGHT,
            duration: 400,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
          Animated.delay((BAR_COUNT - 1 - i) * 90),
        ]),
      );
    });

    // Inicia todas as animações
    animations.forEach(a => a.start());

    return () => {
      animations.forEach(a => a.stop());
      bars.forEach(b => b.setValue(BAR_MIN_HEIGHT));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, height: 30}}>
      {bars.map((bar, i) => (
        <Animated.View
          key={i}
          style={[
            {
              width: 4,
              borderRadius: 2,
              backgroundColor: '#f0883e',
            },
            {height: bar},
          ]}
        />
      ))}
    </View>
  );
}

/**
 * AnimatedBubble — wrapper que aplica fade-in + slide-up suave quando uma
 * mensagem aparece no chat. Inspirado nas animações do ChatGPT: a mensagem
 * desliza de baixo para cima com fade-in, suavemente (~300ms).
 */
function AnimatedBubble({children, delay = 0}: {children: React.ReactNode; delay?: number}) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 280,
        delay,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 280,
        delay,
        useNativeDriver: true,
      }),
    ]).start();
  }, [fadeAnim, translateY, delay]);

  return (
    <Animated.View
      style={{
        opacity: fadeAnim,
        transform: [{translateY}],
      }}>
      {children}
    </Animated.View>
  );
}

interface Props {
  settings: AppSettings;
  messages: Message[];
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
  onOpenSettings: () => void;
}

export function ChatScreen({settings, messages, setMessages, onOpenSettings}: Props) {
  const theme = getTheme(settings.theme);
  const s = getStyles(theme);
  const mdStyle = getMdStyle(theme);
  const markdownRules = createMarkdownRules(theme);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  // Modo thinking local ao chat — inicia DESLIGADO. Sem persistir em
  // settings (foi removido do AppSettings); o usuário alterna em runtime
  // pelo botão lâmpada dentro do input.
  const [thinkingMode, setThinkingMode] = useState(false);
  // Ids de mensagens com bloco de thinking expandido.
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());
  // Imagens pendentes anexadas pelo usuário (preview antes de enviar).
  // Cada item tem {uri, base64} — base64 é o data URI enviado na API.
  const [pendingImages, setPendingImages] = useState<Array<{uri: string; base64: string; mime: string}>>([]);
  // URL da imagem exibida no modal de expansão (full-screen). null = fechado.
  const [imageModalUrl, setImageModalUrl] = useState<string | null>(null);
  // Controla o bottom sheet visual para escolher origem da imagem (Android).
  const [showPickerSheet, setShowPickerSheet] = useState(false);
  // Auto-play TTS: liga/desliga em runtime pelo botão na header.
  //Inicialmente segue settings.ttsAutoPlay.
  const [ttsAuto, setTtsAuto] = useState(settings.ttsAutoPlay ?? false);
  // Id da mensagem sendo sintetizada (para feedback visual no botão).
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  // Se o usuário está no final da lista (longe do topo = scroll ativo).
  // Usado para: mostrar/esconder botão "rolar para baixo" e decidir
  // se auto-scroll durante streaming é apropriado.
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Se o conteúdo da lista é maior que o viewport (há o que rolar).
  const [hasScrollableContent, setHasScrollableContent] = useState(false);
  // Timestamp do último clique no botão "rolar para baixo". Ignora
  // eventos onScroll temporariamente após clicar para evitar que o
  // botão pisque (race condition: scroll animado ainda rolando enquanto
  // isAtBottom já foi setado para true).
  const scrollDownClickRef = useRef(0);

  const listRef = useRef<FlatList<Message>>(null);
  const assistantIdRef = useRef<string | null>(null);
  // Ref para acessar messages no callback de streamResponse sem stale closure.
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  const recorder = useRecorder();
  const whisper = useWhisper();

  useEffect(() => {
    // Pequeno delay p/ garantir que o layout foi atualizado antes do scroll.
    // SÓ rola se o usuário já estiver no bottom — se está lendo mensagens
    // antigas (scrollou para cima), não puxa de volta pra o final.
    if (!isAtBottom) return;
    const timer = setTimeout(() => {
      listRef.current?.scrollToEnd({animated: false});
    }, 50);
    return () => clearTimeout(timer);
  }, [messages, isAtBottom]);

  const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const send = async (
    overrideText?: string,
    overrideContent?: string | ContentPart[],
  ) => {
    // overrideContent tem prioridade sobre overrideText — usado por
    // regenerateMessage para reanexar a mensagem multimodal original
    // (texto + imagens) sem perder a imagem do chat.
    const text = (overrideText ?? input).trim();
    const hasOverrideContent = overrideContent !== undefined;
    // Pode enviar se tem texto OU imagens pendentes OU overrideContent.
    if ((!text && pendingImages.length === 0 && !hasOverrideContent) || streaming) return;

    // Injeta instrução de thinking no system prompt dinamicamente quando ativo.
    // Só funciona no modo local (provider === 'local'). Quando online, o
    // botão de thinking é escondido da UI, então thinkingMode deve ser false.
    const sysContent = thinkingMode
      ? `${settings.systemPrompt}\n\nBefore answering, reason step by step inside 🧠...💬 or ... tags, then write your final answer outside the tags. If you cannot produce these tags, wrap your reasoning in <thinking>...</thinking> instead.`
      : settings.systemPrompt;

    // Constrói content: multimodal (array) se há imagens, senão string.
    // Se overrideContent foi fornecido (regenerate), usa direto — já vem
    // no formato correto (string OU ContentPart[] preservando imagens).
    let userContent: string | ContentPart[];
    if (hasOverrideContent) {
      userContent = overrideContent!;
    } else if (pendingImages.length > 0) {
      const parts: ContentPart[] = [];
      if (text) {
        parts.push({type: 'text', text});
      }
      for (const img of pendingImages) {
        parts.push({
          type: 'image_url',
          image_url: {url: `data:${img.mime};base64,${img.base64}`},
        });
      }
      userContent = parts;
    } else {
      userContent = text;
    }

    const userMsg: Message = {
      role: 'user',
      content: userContent,
      id: genId(),
    };
    const assistantId = genId();
    const assistantMsg: Message = {
      role: 'assistant',
      content: '',
      thinking: '',
      status: 'thinking' as MessageStatus,
      id: assistantId,
    };
    const newMsgs = [...messages, userMsg, assistantMsg];
    // Usa prev p/ não depender do snapshot de messages (race entre render e set).
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput('');
    setPendingImages([]);
    setStreaming(true);
    assistantIdRef.current = assistantId;

    // Alinhamento de nova mensagem ao topo (item 9 da lista de tasks).
    // Se há conteúdo scrollável (a conversa já preenche a tela), alinha
    // a nova pergunta do user ao TOPO do espaço visível. Se o conteúdo
    // ainda cabe na viewport (início da conversa, sem scroll ativo),
    // não faz nada — o useEffect de messages cuida do scrollToEnd.
    const userMsgIndex = newMsgs.length - 2; // penúltima = userMsg
    setTimeout(() => {
      if (hasScrollableContent) {
        listRef.current?.scrollToIndex({
          index: userMsgIndex,
          viewPosition: 0,  // 0 = alinha ao topo
          animated: true,
        });
      }
    }, 60);

    const updateAssistant = (
      patchOrUpdater: Partial<Message> | ((prev: Message) => Partial<Message>),
    ) => {
      setMessages(prev =>
        prev.map(m => {
          if (m.id !== assistantId) return m;
          const patch =
            typeof patchOrUpdater === 'function'
              ? patchOrUpdater(m)
              : patchOrUpdater;
          return {...m, ...patch};
        }),
      );
    };

    try {
      const context: Message[] = [
        {role: 'system', content: sysContent},
        ...newMsgs.filter(m => m.id !== assistantId),
      ];
      await streamResponse(
        context,
        settings.llm,
        event => {
        switch (event.type) {
          case 'reasoning':
          case 'thinking':
            updateAssistant(prev => ({
              thinking: (prev.thinking ?? '') + event.delta,
              status: 'thinking',
            }));
            break;
          case 'token':
            updateAssistant(prev => ({
              content: prev.content + event.delta,
              status: 'streaming',
            }));
            break;
          case 'done':
            updateAssistant({status: 'done'});
            // Auto-play TTS se ativado e modelo TTS configurado.
            if (ttsAuto && settings.ttsOnlineModel?.trim()) {
              const assistantId = assistantIdRef.current;
              const finalMsg = messagesRef.current.find(m => m.id === assistantId);
              if (finalMsg) {
                const text = getTextContent(finalMsg);
                if (text.trim()) {
                  // Dispara sem await — não bloqueia o fluxo do chat.
                  speakMessage(finalMsg);
                }
              }
            }
            break;
          case 'error':
            updateAssistant({
              status: 'error',
              isError: true,
              content: `⚠ ${event.message}`,
            });
            break;
          case 'aborted':
            updateAssistant(prev => ({
              status: 'done',
              content: (prev.content || '') + ' *[cancelado]*',
            }));
            break;
        }
      },
        settings.streamingEnabled !== false,
        thinkingMode,
      );
    } catch (e) {
      const errMsg = (e as Error).message ?? String(e);
      updateAssistant({
        status: 'error',
        isError: true,
        content: `⚠ ${errMsg}`,
      });
    } finally {
      setStreaming(false);
      assistantIdRef.current = null;
    }
  };

  const stopGeneration = () => {
    abortGeneration();
    // abortGeneration dispara onabort do XHR -> onEvent('aborted') -> finally.
  };

  // --- Anexar imagem (câmera ou galeria) ---
  // ActionSheet no iOS (nativo), bottom sheet customizado no Android
  // (Modal com cards visuais — mais bonito que Alert.alert com 3 botões).
  const showImagePicker = () => {
    if (Platform.OS === 'ios') {
      const options = ['Tirar foto', 'Escolher da galeria', 'Cancelar'];
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Anexar imagem',
          options,
          cancelButtonIndex: 2,
        },
        (idx) => {
          if (idx === 0) pickFromCamera();
          else if (idx === 1) pickFromGallery();
        },
      );
    } else {
      // Android: bottom sheet visual via Modal (substitui Alert.alert).
      setShowPickerSheet(true);
    }
  };

  // --- Permissões Android em runtime ---
  // O AndroidManifest declara as permissões, mas a API ainda precisa
  // solicitar ao usuário em tempo de execução (CAMERA, RECORD_AUDIO e
  // READ_MEDIA_IMAGES/READ_EXTERNAL_STORAGE). Sem isso, launchCamera/
  // launchImageLibrary/recorder.start falham silenciosamente quando o
  // usuário ainda não concedeu — e ele só descobre indo nas Configs
  // do Android. Aqui pedimos antes de chamar cada função.
  const ensureCameraPermission = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CAMERA,
        {
          title: 'Permissão de câmera',
          message: 'O BeMore precisa acessar a câmera para tirar fotos e anexá-las ao chat.',
          buttonPositive: 'Permitir',
          buttonNegative: 'Cancelar',
        },
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  };

  const ensureGalleryPermission = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    try {
      // Android 13+ usa READ_MEDIA_IMAGES; Android ≤12 usa READ_EXTERNAL_STORAGE.
      // O PermissionsAndroid.request aceita qualquer uma, mas pode falhar se a
      // permissão não existir no manifest. Tentamos a nova primeiro; se a API
      // rejeitar (undefined), caímos para a antiga.
      const perm13 = PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES;
      const granted = await PermissionsAndroid.request(
        perm13 ?? PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
        {
          title: 'Permissão de acesso à galeria',
          message: 'O BeMore precisa acessar suas fotos para anexá-las ao chat.',
          buttonPositive: 'Permitir',
          buttonNegative: 'Cancelar',
        },
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  };

  const ensureAudioPermission = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Permissão de microfone',
          message: 'O BeMore precisa do microfone para transcrever sua voz em texto.',
          buttonPositive: 'Permitir',
          buttonNegative: 'Cancelar',
        },
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  };

  const pickFromCamera = async () => {
    const ok = await ensureCameraPermission();
    if (!ok) {
      Alert.alert(
        'Permissão negada',
        'Para tirar foto, libere o acesso à câmera nas Configurações do Android.',
      );
      return;
    }
    try {
      const result = await launchCamera({
        mediaType: 'photo',
        quality: 0.8,
        maxWidth: 1024,
        maxHeight: 1024,
        includeBase64: true,
        cameraType: 'back',
      });
      if (result.didCancel || !result.assets?.length) return;
      const asset = result.assets[0];
      if (!asset.base64) {
        Alert.alert('Erro', 'Não foi possível obter a imagem.');
        return;
      }
      const mime = asset.type ?? 'image/jpeg';
      setPendingImages(prev => [...prev, {uri: asset.uri!, base64: asset.base64!, mime}]);
    } catch (e) {
      Alert.alert('Erro na câmera', (e as Error)?.message ?? String(e));
    }
  };

  const pickFromGallery = async () => {
    const ok = await ensureGalleryPermission();
    if (!ok) {
      Alert.alert(
        'Permissão negada',
        'Para escolher fotos, libere o acesso ao armazenamento nas Configurações do Android.',
      );
      return;
    }
    try {
      const result = await launchImageLibrary({
        mediaType: 'photo',
        quality: 0.8,
        maxWidth: 1024,
        maxHeight: 1024,
        includeBase64: true,
        selectionLimit: 0, // 0 = sem limite (multiseleção)
      });
      if (result.didCancel || !result.assets?.length) return;
      const newImages = result.assets
        .filter(a => a.base64 && a.uri)
        .map(a => ({uri: a.uri!, base64: a.base64!, mime: a.type ?? 'image/jpeg'}));
      if (newImages.length === 0) {
        Alert.alert('Erro', 'Não foi possível obter as imagens.');
        return;
      }
      setPendingImages(prev => [...prev, ...newImages]);
    } catch (e) {
      Alert.alert('Erro na galeria', (e as Error)?.message ?? String(e));
    }
  };

  const removePendingImage = (idx: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== idx));
  };

  const toggleMic = async () => {
    const sttMode = settings.sttMode ?? 'on-device';
    const sttReady =
      sttMode === 'online'
        ? !!settings.sttOnlineModel?.trim() &&
          (!!settings.llm.baseUrl?.trim() || !!settings.sttServerOverride?.trim())
        : !!settings.sttModelPath?.trim();

    if (recorder.status === 'idle' || recorder.status === 'error') {
      if (!sttReady) {
        const msg = sttMode === 'online'
          ? 'Para usar o microfone, selecione um modelo STT online nas configurações.'
          : 'Para usar o microfone, defina o caminho do modelo Whisper em Settings.';
        Alert.alert('STT não configurado', msg);
        return;
      }
      const ok = await ensureAudioPermission();
      if (!ok) {
        Alert.alert(
          'Permissão negada',
          'Para gravar áudio, libere o acesso ao microfone nas Configurações do Android.',
        );
        return;
      }
      try {
        await recorder.start();
        if (recorder.errorMessage) {
          Alert.alert('Microfone indisponível', recorder.errorMessage);
        }
      } catch (e) {
        Alert.alert('Erro ao iniciar microfone', (e as Error)?.message ?? String(e));
      }
      return;
    }
    if (recorder.status === 'recording') {
      try {
        const path = await recorder.stop();
        if (!path) return;
        if (!sttReady) {
          const msg = sttMode === 'online'
            ? 'Selecione um modelo STT online nas configurações para transcrever voz.'
            : 'Defina o caminho do modelo Whisper em Settings para transcrever voz.';
          Alert.alert('STT não configurado', msg);
          return;
        }
        const transcript = await whisper.transcribe(path, settings);
        if (transcript && transcript.trim()) {
          setInput(transcript.trim());
        } else if (whisper.errorMessage) {
          Alert.alert('Transcrição falhou', whisper.errorMessage);
        } else {
          Alert.alert('Vazio', 'Nenhuma fala detectada no áudio.');
        }
      } catch (e) {
        Alert.alert('Erro no microfone', (e as Error)?.message ?? String(e));
      }
    }
  };

  // Nome de ícone do botão mic conforme estado do recorder.
  // Returns usam `as const` p/ produzir literal válido do union
  // MaterialIconsIconName (~2230 nomes). Sem isso, TS infere `string` e
  // <Icon name={...}> rejeita (v13 scoped tem tipagem estrita no prop name).
  const micIconName = () => {
    if (recorder.status === 'recording') return 'stop' as const;
    if (recorder.status === 'processing') return 'hourglass-top' as const;
    if (recorder.status === 'error') return 'warning' as const;
    return 'mic' as const;
  };

  // Botão dinâmico à direita: mic | send | stop (item 8)
  const renderActionBtn = () => {
    if (streaming) {
      return (
        <TouchableOpacity style={[s.actionBtn, s.actionBtnStop]} onPress={stopGeneration}>
          <Icon name="stop" size={22} color={theme.accentText} />
        </TouchableOpacity>
      );
    }
    if (input.trim().length > 0 || pendingImages.length > 0) {
      return (
        <TouchableOpacity style={s.actionBtn} onPress={() => send()}>
          <Icon name="send" size={20} color={theme.accentText} />
        </TouchableOpacity>
      );
    }
    return (
      <TouchableOpacity
        style={[
          s.actionBtn,
          s.actionBtnMic,
          recorder.status === 'recording' && s.actionBtnMicActive,
          recorder.status === 'error' && s.actionBtnMicError,
        ]}
        onPress={toggleMic}
        disabled={recorder.status === 'processing'}>
        <Icon
          name={micIconName()}
          size={22}
          color={
            recorder.status === 'recording'
              ? '#fff'
              : recorder.status === 'error'
                ? theme.errorText
                : theme.textSecondary
          }
        />
      </TouchableOpacity>
    );
  };

  const toggleThinkingExpanded = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedThinking(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyMessage = (msg: Message) => {
    const text = getTextContent(msg);
    if (text.trim()) Clipboard.setString(text);
  };

  // --- TTS: sintetizar e tocar a mensagem do assistant ---
  const speakMessage = async (msg: Message) => {
    // Se já está tocando esta mensagem, para.
    if (speakingId && speakingId === msg.id) {
      stopSpeaking();
      setSpeakingId(null);
      return;
    }
    const text = getTextContent(msg);
    if (!text.trim()) return;

    const ttsModel = settings.ttsOnlineModel ?? '';
    if (!ttsModel) {
      Alert.alert('TTS não configurado', 'Selecione um modelo TTS nas configurações.');
      return;
    }

    // Determina baseUrl e apiKey (override ou reutiliza LLM).
    let baseUrl: string;
    let apiKey: string;
    if (settings.ttsServerOverride?.trim()) {
      baseUrl = settings.ttsServerOverride.trim();
      apiKey = await loadApiKeyForServer(baseUrl);
    } else {
      baseUrl = settings.llm.baseUrl;
      // Tenta usar a apiKey do settings; se vazia, carrega do Keychain.
      apiKey = settings.llm.apiKey ?? '';
      if (!apiKey) {
        apiKey = await loadApiKeyForServer(baseUrl);
      }
    }

    setSpeakingId(msg.id ?? null);
    try {
      await speakText({
        baseUrl,
        apiKey,
        model: ttsModel,
        input: text,
        voice: settings.ttsVoice,
      });
    } catch (e) {
      Alert.alert('TTS falhou', (e as Error)?.message ?? String(e));
    } finally {
      setSpeakingId(null);
    }
  };

  const regenerateMessage = (msg: Message) => {
    // Encontra a msg do user imediatamente antes desta resposta do assistant.
    const idx = messages.findIndex(m => m.id === msg.id);
    if (idx <= 0) return;
    const prevUser = messages
      .slice(0, idx)
      .reverse()
      .find(m => m.role === 'user');
    if (!prevUser) return;
    // Preserva o content original (texto OU multimodal com imagens).
    // Antes, só reenviávamos o texto (getTextContent) — isso descartava
    // as imagens anexadas e fazia a imagem sumir do chat. Agora passamos
    // o content completo: a mensagem recriada pelo send() terá as mesmas
    // partes (texto+image_url), e o modelo recebe a imagem igualzinha.
    const userContent = prevUser.content;
    const userText = getTextContent(prevUser);
    const userId = prevUser.id;
    // Remove tanto a resposta antiga quanto a pergunta antiga.
    // send() vai recriar ambas com novos IDs.
    setMessages(prev =>
      prev.filter(m => m.id !== msg.id && m.id !== userId),
    );
    // Pequeno delay p/ o setMessages aplicar antes do send.
    // Passa userContent (preserva imagens) e userText (fallback nos bubbles).
    setTimeout(() => send(userText, userContent), 0);
  };

  const deleteMessage = (msg: Message) => {
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === msg.id);
      if (idx < 0) return prev;
      // Se assistant, remove tambem a pergunta do user imediatamente antes.
      if (msg.role === 'assistant' && idx > 0 && prev[idx - 1].role === 'user') {
        return prev.filter((_, i) => i !== idx && i !== idx - 1);
      }
      // Se user, remove a msg e a resposta do assistant depois dela.
      if (msg.role === 'user' && idx < prev.length - 1 && prev[idx + 1].role === 'assistant') {
        return prev.filter((_, i) => i !== idx && i !== idx + 1);
      }
      return prev.filter(m => m.id !== msg.id);
    });
  };

  // Nome do ícone de thinking conforme estado do toggle (lâmpada acesa/apagada).
  // as const em cada return para satisfazer a tipagem estrita do prop name
  // do <Icon> (v13 scoped exige union MaterialIconsIconName).
  const thinkingIconName = () => {
    if (thinkingMode) return 'lightbulb' as const;
    return 'lightbulb-outline' as const;
  };

  const renderMessage = ({item}: {item: Message}) => {
    const isUser = item.role === 'user';
    const isStreamingMsg =
      !isUser && (item.status === 'thinking' || item.status === 'streaming');
    // Tag de status so aparece durante o "pensando". Assim que o modelo
    // comeca a responder (status streaming), a tag some e so fica o texto
    // sendo escrito — evita "Processando..." concorrendo com o proprio output.
    const statusLabel =
      item.status === 'thinking'
        ? 'Pensando...'
        : item.status === 'streaming'
          ? null  // token-a-token não precisa de label — o texto aparecendo já é o feedback
          : null;
    const expanded = item.id ? expandedThinking.has(item.id) : false;
    const showThinkingToggle = !!item.thinking && item.thinking.trim().length > 0;

    return (
      <AnimatedBubble>
        <View
          style={[
            s.bubble,
            isUser
              ? s.bubbleUser
              : item.isError
                ? s.bubbleError
                : s.bubbleBot,
          ]}>
        {/* status de geração — feedback de "pensando" */}
        {statusLabel && (
          <View style={s.statusRow}>
            <ActivityIndicator size="small" color={theme.accent} />
            <Text style={s.statusText}>{statusLabel}</Text>
            <TypingDots />
          </View>
        )}
        {/* bloco pensamento expansível (item 4) */}
        {showThinkingToggle && (
          <TouchableOpacity
            style={s.thinkingToggle}
            onPress={() => item.id && toggleThinkingExpanded(item.id)}
            activeOpacity={0.7}>
            <Icon
              name={expanded ? 'expand-less' : 'expand-more'}
              size={16}
              color={theme.textSecondary}
            />
            <Text style={s.thinkingToggleLabel}>
              {expanded ? 'Ocultar pensamento' : 'Ver pensamento'}
            </Text>
          </TouchableOpacity>
        )}
        {showThinkingToggle && expanded && (
          <View style={s.thinkingBox}>
            <Text style={s.thinkingText}>{item.thinking}</Text>
          </View>
        )}
        {/* conteúdo principal */}
        {(getTextContent(item) || !isStreamingMsg || hasImages(item)) && (
          <>
            {/* Imagens anexadas (multimodal) — exibidas acima do texto.
                Cada imagem é clicável: abre modal de expansão full-screen. */}
            {hasImages(item) && (
              <View style={s.imageRow}>
                {getImageUrls(item).map((url, imgIdx) => (
                  <TouchableOpacity
                    key={imgIdx}
                    activeOpacity={0.85}
                    onPress={() => setImageModalUrl(url)}>
                    <RNImage
                      source={{uri: url}}
                      style={s.chatImage}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {/* Texto da mensagem */}
            {(() => {
              const text = getTextContent(item);
              if (!text) return null;
              return isUser ? (
                <Text style={[s.bubbleText, s.bubbleTextUser]}>
                  {text}
                </Text>
              ) : (
                <Markdown style={mdStyle} rules={markdownRules}>
                  {text}
                </Markdown>
              );
            })()}
          </>
        )}
        {/* Action bar estilo llama-ui: icones apos a mensagem. */}
        {!isStreamingMsg && !item.isError && (
          <View style={s.actionBar}>
            {/* Cor do ícone: branco semi-transparente na bubble azul do user
                para contraste; cinza na bubble do bot. */}
            {(() => {
              const iconColor = isUser ? 'rgba(255,255,255,0.65)' : theme.textSecondary;
              return (
                <>
                  <TouchableOpacity
                    style={s.actionBarItem}
                    onPress={() => copyMessage(item)}
                    hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}>
                    <Icon name="content-copy" size={15} color={iconColor} />
                  </TouchableOpacity>
                  {/* TTS: botão de alto-falante (só para mensagens do assistant). */}
                  {!isUser && (
                    <TouchableOpacity
                      style={s.actionBarItem}
                      onPress={() => speakMessage(item)}
                      hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}>
                      <Icon
                        name={speakingId === item.id ? 'stop' : 'volume-up'}
                        size={15}
                        color={speakingId === item.id ? '#2dd4bf' : iconColor}
                      />
                    </TouchableOpacity>
                  )}
                  {!isUser && (
                    <TouchableOpacity
                      style={s.actionBarItem}
                      onPress={() => regenerateMessage(item)}
                      hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}>
                      <Icon name="refresh" size={15} color={iconColor} />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={s.actionBarItem}
                    onPress={() => deleteMessage(item)}
                    hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}>
                    <Icon name="delete-outline" size={15} color={iconColor} />
                  </TouchableOpacity>
                </>
              );
            })()}
          </View>
        )}
      </View>
      </AnimatedBubble>
    );
  };

  const headerTitle = displayModelName(settings.llm.model) || 'modelo';

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar
        backgroundColor={theme.bg}
        barStyle={theme.statusBar}
        translucent={false}
      />

      {/* Painel superior */}
      <View style={s.header}>
        <Text style={s.headerTitle} numberOfLines={1}>
          {headerTitle}
        </Text>
        <View style={s.headerActions}>
          {/* Novo chat — limpa histórico e contexto atual */}
          <TouchableOpacity
            onPress={() => {
              if (messages.length === 0) return;
              Alert.alert(
                'Novo Chat',
                'Limpar todo o histórico de mensagens?',
                [
                  {text: 'Cancelar', style: 'cancel'},
                  {text: 'Limpar', onPress: () => setMessages(() => []), style: 'destructive'},
                ],
              );
            }}
            style={s.iconBtn}>
            <Icon name="add-circle-outline" size={24} color={theme.textSecondary} />
          </TouchableOpacity>
          {/* Auto-play TTS toggle — ativa reprodução automática das respostas */}
          <TouchableOpacity
            onPress={() => {
              const next = !ttsAuto;
              setTtsAuto(next);
              if (!next) {
                stopSpeaking();
                setSpeakingId(null);
              }
            }}
            style={s.iconBtn}>
            <Icon
              name={ttsAuto ? 'record-voice-over' : 'voice-over-off'}
              size={24}
              color={ttsAuto ? '#2dd4bf' : theme.textSecondary}
            />
          </TouchableOpacity>
          {/* Configurações */}
          <TouchableOpacity onPress={onOpenSettings} style={s.iconBtn}>
            <Icon name="settings" size={24} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Area de mensagens — KeyboardAvoidingView ajusta p/ teclado */}
      <KeyboardAvoidingView
        style={{flex: 1}}
        behavior={Platform.OS === 'android' ? undefined : 'padding'}
        enabled>
        <FlatList
          ref={listRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={item => item.id ?? `idx-${getTextContent(item).slice(0, 20)}`}
          contentContainerStyle={s.list}
          // Auto-scroll SÓ quando o usuário está no bottom (não interrompe
          // a leitura de mensagens antigas). Remove o comportamento de
          // scroll automático ao focar no input ou expandir thinking.
          onContentSizeChange={() => {
            if (isAtBottom) {
              listRef.current?.scrollToEnd({animated: true});
            }
          }}
          onLayout={(e) => {
            // Detecta se há conteúdo scrollável (conteúdo > viewport).
            const layoutHeight = e.nativeEvent.layout.height;
            // Precisamos do contentHeight — medido no onContentSizeChange.
            // Aqui só registramos a altura da viewport para comparação.
            // O hasScrollableContent é atualizado no onScroll.
          }}
          onScroll={(e) => {
            // Ignora onScroll por 400ms após clicar no botão rolar para
            // baixo — evita que o botão pisque durante a animação.
            if (Date.now() - scrollDownClickRef.current < 400) return;
            const {layoutMeasurement, contentOffset, contentSize} = e.nativeEvent;
            // Considera "no bottom" se está a menos de 60px do final.
            const distanceFromBottom =
              contentSize.height - layoutMeasurement.height - contentOffset.y;
            const atBottom = distanceFromBottom < 60;
            setIsAtBottom(atBottom);
            // Há conteúdo scrollável se o conteúdo é maior que a viewport.
            setHasScrollableContent(contentSize.height > layoutMeasurement.height + 10);
          }}
          scrollEventThrottle={16}
          onScrollToIndexFailed={() => {
            // Fallback: se scrollToIndex falhar (alturas variáveis),
            // rola para o final como fallback seguro.
            listRef.current?.scrollToEnd({animated: true});
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
        />
      </KeyboardAvoidingView>

      {/* Botão flutuante "Rolar para Baixo" — centralizado na parte inferior.
          Aparece apenas quando há conteúdo para rolar e o usuário não está
          no final da lista. */}
      {hasScrollableContent && !isAtBottom && (
        <TouchableOpacity
          style={s.scrollDownBtn}
          onPress={() => {
            scrollDownClickRef.current = Date.now();
            listRef.current?.scrollToEnd({animated: true});
            setIsAtBottom(true);
          }}>
          <Icon name="arrow-downward" size={18} color={theme.textSecondary} />
        </TouchableOpacity>
      )}

      {/* Status do gravador / transcrição */}
      {(recorder.status === 'processing' ||
        recorder.status === 'recording' ||
        whisper.status === 'transcribing') && (
        <View style={s.statusBar}>
          {recorder.status === 'recording' ? (
            <WaveformAnimation />
          ) : (
            <ActivityIndicator size="small" color={theme.accent} />
          )}
          <Text style={s.statusText}>
            {whisper.status === 'transcribing'
              ? 'Transcrevendo...'
              : recorder.status === 'recording'
              ? 'Gravando... toque para parar'
              : 'Processando áudio...'}
          </Text>
        </View>
      )}

      {/* Preview das imagens pendentes (acima da input bar) */}
      {pendingImages.length > 0 && (
        <View style={s.pendingImagesRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {pendingImages.map((img, idx) => (
              <View key={idx} style={s.pendingImageWrap}>
                <RNImage
                  source={{uri: img.uri}}
                  style={s.pendingImage}
                  resizeMode="cover"
                />
                <TouchableOpacity
                  style={s.pendingImageRemove}
                  onPress={() => removePendingImage(idx)}>
                  <Icon name="close" size={14} color="#fff" />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Input bar — botão de anexo (clip) + thinking (só local) dentro do campo. */}
      <View style={s.inputBar}>
        <View style={s.inputWrap}>
          {/* Botão de anexar imagem (clip) — sempre disponível */}
          <TouchableOpacity
            style={s.attachBtn}
            onPress={showImagePicker}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="attach-file" size={22} color={theme.textSecondary} />
          </TouchableOpacity>

          {/* Toggle thinking — só visível no modo local (provider === 'local').
              Online, o botão é escondido (thinking é controlado pelo servidor). */}
          {settings.llm.provider === 'local' && (
            <TouchableOpacity
              style={s.thinkingBtn}
              onPress={() => setThinkingMode(v => !v)}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
              <Icon
                name={thinkingIconName()}
                size={22}
                color={thinkingMode ? theme.accent : theme.textSecondary}
              />
            </TouchableOpacity>
          )}

          <TextInput
            style={s.input}
            value={input}
            onChangeText={setInput}
            placeholder="Mensagem..."
            placeholderTextColor={theme.textMuted}
            multiline
            // minHeight/maxHeight via style (nao como props diretas —
            // TextInputProps nao aceita). 1 linha (44px) ate 5 (124px);
            // acima disso o proprio TextInput ativa scroll interno (item 5).
            maxLength={8000}
          />
        </View>

        {renderActionBtn()}
      </View>

      {/* --- Modal de expansão de imagem (full-screen) --- */}
      {/* Abre quando o usuário toca numa imagem do chat. Mostra a imagem
          grande num overlay escuro, com botão X no canto superior direito. */}
      <Modal
        visible={imageModalUrl !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setImageModalUrl(null)}>
        <View style={s.imageModalOverlay}>
          <TouchableOpacity
            style={s.imageModalCloseBtn}
            onPress={() => setImageModalUrl(null)}
            hitSlop={{top: 12, bottom: 12, left: 12, right: 12}}>
            <Icon name="close" size={28} color="#fff" />
          </TouchableOpacity>
          {imageModalUrl && (
            <RNImage
              source={{uri: imageModalUrl}}
              style={s.imageModalImage}
              resizeMode="contain"
            />
          )}
        </View>
      </Modal>

      {/* --- Bottom sheet de seleção de origem da imagem (Android) --- */}
      {/* Substitui Alert.alert por cards visuais com ícones grandes.
          Mostra câmera, galeria e cancelar em colunas com labels. */}
      <Modal
        visible={showPickerSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPickerSheet(false)}>
        <TouchableOpacity
          style={s.pickerSheetOverlay}
          activeOpacity={1}
          onPress={() => setShowPickerSheet(false)}>
          <View
            style={s.pickerSheetCard}
            // Impede que o tap no card feche o modal (overlay sim).
            onStartShouldSetResponder={() => true}>
            <View style={s.pickerSheetHandle} />
            <Text style={s.pickerSheetTitle}>Anexar imagem</Text>
            <View style={s.pickerSheetOptions}>
              <TouchableOpacity
                style={s.pickerSheetOption}
                onPress={() => {
                  setShowPickerSheet(false);
                  pickFromCamera();
                }}>
                <View style={s.pickerSheetIconWrap}>
                  <Icon name="photo-camera" size={32} color="#58a6ff" />
                </View>
                <Text style={s.pickerSheetOptionLabel}>Tirar foto</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.pickerSheetOption}
                onPress={() => {
                  setShowPickerSheet(false);
                  pickFromGallery();
                }}>
                <View style={s.pickerSheetIconWrap}>
                  <Icon name="photo-library" size={32} color="#3fb950" />
                </View>
                <Text style={s.pickerSheetOptionLabel}>Escolher da galeria</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={s.pickerSheetCancelBtn}
              onPress={() => setShowPickerSheet(false)}>
              <Text style={s.pickerSheetCancelText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

// Estilos para o renderizador de Markdown.
// Gerados dinamicamente a partir do tema ativo — cores mudam entre dark/light.
function getMdStyle(t: ThemeColors) {
  return StyleSheet.create({
    body: {color: t.text, fontSize: 15, lineHeight: 21},
    heading1: {color: t.text, fontSize: 22, fontWeight: '700', marginTop: 8, marginBottom: 6},
    heading2: {color: t.text, fontSize: 19, fontWeight: '700', marginTop: 6, marginBottom: 4},
    heading3: {color: t.text, fontSize: 17, fontWeight: '600', marginTop: 4, marginBottom: 3},
    heading4: {color: t.text, fontSize: 16, fontWeight: '600'},
    heading5: {color: t.text, fontSize: 15, fontWeight: '600'},
    heading6: {color: t.textSecondary, fontSize: 14, fontWeight: '600'},
    code_inline: {
      color: t.codeInline,
      backgroundColor: t.codeInlineBg,
      paddingHorizontal: 4,
      borderRadius: 3,
      fontFamily: 'monospace',
    },
    code_block: {
      color: t.codeText,
      backgroundColor: t.codeBg,
      padding: 10,
      borderRadius: 6,
      fontFamily: 'monospace',
      fontSize: 13,
    },
    fence: {
      color: t.codeText,
      backgroundColor: t.codeBg,
      padding: 10,
      borderRadius: 6,
      fontFamily: 'monospace',
      fontSize: 13,
    },
    blockquote: {
      backgroundColor: t.thinkingBg,
      borderLeftWidth: 3,
      borderLeftColor: t.accent,
      paddingLeft: 10,
      paddingVertical: 4,
      marginVertical: 4,
    },
    link: {color: t.accent, textDecorationLine: 'underline'},
    list_item: {color: t.text, marginVertical: 2},
    bullet_list: {color: t.text},
    ordered_list: {color: t.text},
    em: {color: t.text, fontStyle: 'italic'},
    strong: {color: t.text, fontWeight: '700'},
    text: {color: t.text},
    // Tabela — fundo e bordas visíveis em ambos os temas.
    // IMPORTANTE: a lib usa borderColor: '#000000' no estilo padrão de tr/td,
    // que é um shorthand que sobrescreve borderBottomColor/borderRightColor.
    // Por isso usamos borderColor (não as versões direcionais) para garantir
    // que a cor do tema tenha precedência.
    table: {
      borderWidth: 1,
      borderColor: t.tableBorder,
      borderRadius: 4,
      overflow: 'hidden',
      marginVertical: 8,
    },
    tr: {
      borderBottomWidth: 1,
      borderColor: t.tableBorder,
      flexDirection: 'row',
    },
    th: {
      flex: 1,
      padding: 5,
      borderRightWidth: 1,
      borderColor: t.tableBorder,
      backgroundColor: t.tableHeaderBg,
      color: t.text,
      fontWeight: '700',
    },
    td: {
      flex: 1,
      padding: 5,
      borderRightWidth: 1,
      borderColor: t.tableBorder,
      color: t.text,
    },
  });
}

/**
 * CopyCodeButton — botão de copiar para code blocks. Ao clicar, copia o
 * código para o clipboard e troca o ícone de "content-copy" para "check"
 * por 2 segundos, dando feedback visual sem perder a função de copiar
 * (cliques subsequentes copiam novamente).
 */
function CopyCodeButton({content, color}: {content: string; color: string}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePress = () => {
    Clipboard.setString(content);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <TouchableOpacity
      style={{
        position: 'absolute',
        top: 6,
        right: 6,
        zIndex: 10,
        padding: 6,
        borderRadius: 4,
        backgroundColor: 'rgba(255,255,255,0.08)',
      }}
      onPress={handlePress}>
      <Icon name={copied ? 'check' : 'content-copy'} size={14} color={copied ? '#3fb950' : color} />
    </TouchableOpacity>
  );
}

// Regras customizadas de renderização do Markdown.
// Substitui o renderizador padrão de `fence` (code blocks com fences ```),
// que depende do prism-react-renderer + MaterialDesignIcons — pesado e
// suscetível a falhas de layout (a View pai perde overflow/estilos quando
// o user style sobrescreve fence). Aqui usamos um ScrollView horizontal
// simples com Text monoespaçado — robusto e consistente com o tema.
//
// Inclui botão "Copiar" no canto superior direito de cada code block.
// Em landscape, o ScrollView horizontal expande para o conteúdo (overflow-x
// auto) em vez de quebrar linhas, igual ao comportamento portrait.
//
// Assinatura do RenderRule (v9): (node, children, parentNodes, styles, ...extra) => ReactNode
//   node.content traz o código bruto da fence.
//   node.key é obrigatório como key do elemento raiz (animações/reconciliação).
function createMarkdownRules(t: ThemeColors) {
  return {
    fence: (node: any, _children: any, _parentNodes: any, _styles: any) => (
      <View key={node.key} style={{marginVertical: 8, borderRadius: 6, backgroundColor: t.codeBg, overflow: 'hidden'}}>
        <CopyCodeButton content={node.content ?? ''} color={t.textSecondary} />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{}}
          contentContainerStyle={{padding: 10}}>
          <Text style={{color: t.codeText, fontFamily: 'monospace', fontSize: 13}}>
            {node.content}
          </Text>
        </ScrollView>
      </View>
    ),
  };
}

// Stylesheet dinâmico — cores dependem do tema ativo.
// Estrutura estrutural (flex, padding, radius) é igual em ambos os temas;
// só as cores mudam. Isto evita duplicar 300 linhas de StyleSheet.
function getStyles(t: ThemeColors) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: t.bg,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
      backgroundColor: t.bg,
    },
    headerTitle: {
      color: t.textSecondary,
      fontSize: 14,
      fontWeight: '600',
      flex: 1,
      marginRight: 12,
    },
    iconBtn: {
      padding: 4,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    list: {
      padding: 16,
      paddingBottom: 8,
      flexGrow: 1,
      // Sem justifyContent: 'flex-end' — o flex-end causava overscroll
      // (espaço extra além da última mensagem). Sem ele, o conteúdo
      // naturalmente preenche de cima para baixo, e o scroll para
      // exatamente no final.
    },
    // Largura 90% conforme solicitado (era 85%)
    bubble: {
      maxWidth: '90%',
      width: '90%',
      padding: 12,
      paddingBottom: 6,
      borderRadius: 12,
      marginBottom: 8,
    },
    bubbleUser: {
      backgroundColor: t.userBubble,
      alignSelf: 'flex-end',
    },
    bubbleBot: {
      backgroundColor: t.botBubble,
      alignSelf: 'flex-start',
    },
    bubbleError: {
      backgroundColor: t.errorBg,
      alignSelf: 'flex-start',
      borderWidth: 1,
      borderColor: t.errorBorder,
    },
    bubbleText: {
      color: t.text,
      fontSize: 15,
    },
    bubbleTextUser: {
      color: t.userBubbleText,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 6,
    },
    statusText: {
      color: t.accent,
      fontSize: 13,
    },
    thinkingToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginBottom: 6,
      paddingVertical: 2,
      alignSelf: 'flex-start',
    },
    thinkingToggleLabel: {
      color: t.textSecondary,
      fontSize: 12,
      fontStyle: 'italic',
    },
    thinkingBox: {
      backgroundColor: t.thinkingBg,
      borderRadius: 8,
      padding: 8,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: t.thinkingBorder,
    },
    actionBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      marginTop: 6,
      paddingTop: 4,
      borderTopWidth: 1,
      borderTopColor: t.border,
      opacity: 0.7,
    },
    actionBarItem: {
      padding: 4,
    },
    thinkingText: {
      color: t.thinkingText,
      fontSize: 12,
      lineHeight: 16,
    },
    statusBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 6,
      backgroundColor: t.bgSurface,
      gap: 8,
    },
    inputBar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: t.border,
      backgroundColor: t.bg,
      gap: 8,
    },
    inputWrap: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'flex-end',
      borderRadius: 22,
      backgroundColor: t.bgSurface,
    },
    thinkingBtn: {
      width: 40,
      height: 44,
      justifyContent: 'center',
      alignItems: 'center',
      paddingLeft: 4,
    },
    attachBtn: {
      width: 40,
      height: 44,
      justifyContent: 'center',
      alignItems: 'center',
      paddingLeft: 4,
    },
    input: {
      flex: 1,
      minHeight: 44,
      maxHeight: 124,
      paddingHorizontal: 8,
      paddingVertical: 10,
      color: t.text,
      fontSize: 15,
      textAlignVertical: 'center',
    },
    actionBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: t.accent,
      justifyContent: 'center',
      alignItems: 'center',
    },
    actionBtnStop: {
      backgroundColor: '#da3633',
    },
    actionBtnMic: {
      backgroundColor: t.bgElevated,
    },
    actionBtnMicActive: {
      backgroundColor: '#da3633',
    },
    actionBtnMicError: {
      backgroundColor: t.errorBg,
      borderWidth: 1,
      borderColor: t.errorText,
    },
    // --- Imagens no chat (multimodal) ---
    imageRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 4,
      marginBottom: 8,
    },
    chatImage: {
      width: 200,
      height: 200,
      borderRadius: 8,
    },
    // --- Preview de imagens pendentes (acima da input bar) ---
    pendingImagesRow: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      backgroundColor: t.bg,
      borderTopWidth: 1,
      borderTopColor: t.border,
    },
    pendingImageWrap: {
      position: 'relative',
      marginRight: 8,
    },
    pendingImage: {
      width: 72,
      height: 72,
      borderRadius: 8,
    },
    pendingImageRemove: {
      position: 'absolute',
      top: -4,
      right: -4,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: '#da3633',
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: t.bg,
    },
    // --- Modal de expansão de imagem (full-screen) ---
    imageModalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.92)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    imageModalCloseBtn: {
      position: 'absolute',
      top: 40,
      right: 20,
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: 'rgba(30,30,30,0.85)',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 10,
    },
    imageModalImage: {
      width: Dimensions.get('window').width,
      height: Dimensions.get('window').height * 0.75,
    },
    // --- Bottom sheet de seleção de origem (Android) ---
    pickerSheetOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    pickerSheetCard: {
      backgroundColor: t.bgSurface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingBottom: 24,
      paddingHorizontal: 20,
      paddingTop: 12,
      borderWidth: 1,
      borderTopColor: t.border,
    },
    pickerSheetHandle: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: t.border,
      alignSelf: 'center',
      marginBottom: 12,
    },
    pickerSheetTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: t.text,
      textAlign: 'center',
      marginBottom: 16,
    },
    pickerSheetOptions: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 24,
      marginBottom: 20,
    },
    pickerSheetOption: {
      alignItems: 'center',
      width: 100,
    },
    pickerSheetIconWrap: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: t.bgElevated,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 8,
      borderWidth: 1,
      borderColor: t.border,
    },
    pickerSheetOptionLabel: {
      fontSize: 13,
      color: t.textSecondary,
      textAlign: 'center',
    },
    pickerSheetCancelBtn: {
      paddingVertical: 14,
      borderRadius: 10,
      backgroundColor: t.bgElevated,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: t.border,
    },
    pickerSheetCancelText: {
      fontSize: 15,
      color: t.text,
    },
    // --- Botão flutuante "Rolar para Baixo" ---
    scrollDownBtn: {
      position: 'absolute',
      bottom: 80,
      alignSelf: 'center',
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: t.bgElevated,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: t.border,
      shadowColor: '#000',
      shadowOffset: {width: 0, height: 2},
      shadowOpacity: 0.25,
      shadowRadius: 3,
      elevation: 4,
    },
  });
}
