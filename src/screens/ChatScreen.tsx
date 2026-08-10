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
    <View style={s.typingDots}>
      {[0, 1, 2].map(i => (
        <View
          key={i}
          style={[
            s.typingDot,
            active === i && s.typingDotActive,
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
    <View style={s.waveformContainer}>
      {bars.map((bar, i) => (
        <Animated.View
          key={i}
          style={[
            s.waveformBar,
            {height: bar},
          ]}
        />
      ))}
    </View>
  );
}

interface Props {
  settings: AppSettings;
  messages: Message[];
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
  onOpenSettings: () => void;
}

export function ChatScreen({settings, messages, setMessages, onOpenSettings}: Props) {
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

  const listRef = useRef<FlatList<Message>>(null);
  const assistantIdRef = useRef<string | null>(null);
  // Ref para acessar messages no callback de streamResponse sem stale closure.
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  const recorder = useRecorder();
  const whisper = useWhisper();

  useEffect(() => {
    // Pequeno delay p/ garantir que o layout foi atualizado antes do scroll.
    const timer = setTimeout(() => {
      listRef.current?.scrollToEnd({animated: false});
    }, 50);
    return () => clearTimeout(timer);
  }, [messages]);

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
          <Icon name="stop" size={22} color="#fff" />
        </TouchableOpacity>
      );
    }
    if (input.trim().length > 0 || pendingImages.length > 0) {
      return (
        <TouchableOpacity style={s.actionBtn} onPress={() => send()}>
          <Icon name="send" size={20} color="#fff" />
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
                ? '#f85149'
                : '#8b949e'
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
      apiKey = settings.llm.apiKey ?? '';
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
            <ActivityIndicator size="small" color="#58a6ff" />
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
              color="#8b949e"
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
            <TouchableOpacity
              style={s.actionBarItem}
              onPress={() => copyMessage(item)}
              hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}>
              <Icon name="content-copy" size={15} color="#8b949e" />
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
                  color={speakingId === item.id ? '#2dd4bf' : '#8b949e'}
                />
              </TouchableOpacity>
            )}
            {!isUser && (
              <TouchableOpacity
                style={s.actionBarItem}
                onPress={() => regenerateMessage(item)}
                hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}>
                <Icon name="refresh" size={15} color="#8b949e" />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={s.actionBarItem}
              onPress={() => deleteMessage(item)}
              hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}>
              <Icon name="delete-outline" size={15} color="#8b949e" />
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  const headerTitle = displayModelName(settings.llm.model) || 'modelo';

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar
        backgroundColor="#0d1117"
        barStyle="light-content"
        translucent={false}
      />

      {/* Painel superior */}
      <View style={s.header}>
        <Text style={s.headerTitle} numberOfLines={1}>
          {headerTitle}
        </Text>
        <View style={s.headerActions}>
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
              color={ttsAuto ? '#2dd4bf' : '#8b949e'}
            />
          </TouchableOpacity>
          {/* Configurações */}
          <TouchableOpacity onPress={onOpenSettings} style={s.iconBtn}>
            <Icon name="settings" size={24} color="#8b949e" />
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
          onContentSizeChange={() => listRef.current?.scrollToEnd({animated: true})}
          onLayout={() => listRef.current?.scrollToEnd({animated: false})}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
        />
      </KeyboardAvoidingView>

      {/* Status do gravador / transcrição */}
      {(recorder.status === 'processing' ||
        recorder.status === 'recording' ||
        whisper.status === 'transcribing') && (
        <View style={s.statusBar}>
          {recorder.status === 'recording' ? (
            <WaveformAnimation />
          ) : (
            <ActivityIndicator size="small" color="#58a6ff" />
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
            <Icon name="attach-file" size={22} color="#8b949e" />
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
                color={thinkingMode ? '#58a6ff' : '#8b949e'}
              />
            </TouchableOpacity>
          )}

          <TextInput
            style={s.input}
            value={input}
            onChangeText={setInput}
            placeholder="Mensagem..."
            placeholderTextColor="#aab2bc"
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

// Estilos para o renderizador de Markdown (dark theme).
// Sobrescreve apenas as cores — tipografia herda do tema da bubble.
const mdStyle = StyleSheet.create({
  body: {color: '#e6edf3', fontSize: 15, lineHeight: 21},
  heading1: {color: '#e6edf3', fontSize: 22, fontWeight: '700', marginTop: 8, marginBottom: 6},
  heading2: {color: '#e6edf3', fontSize: 19, fontWeight: '700', marginTop: 6, marginBottom: 4},
  heading3: {color: '#e6edf3', fontSize: 17, fontWeight: '600', marginTop: 4, marginBottom: 3},
  heading4: {color: '#e6edf3', fontSize: 16, fontWeight: '600'},
  heading5: {color: '#e6edf3', fontSize: 15, fontWeight: '600'},
  heading6: {color: '#8b949e', fontSize: 14, fontWeight: '600'},
  code_inline: {
    color: '#f0883e',
    backgroundColor: '#0d1117',
    paddingHorizontal: 4,
    borderRadius: 3,
    fontFamily: 'monospace',
  },
  code_block: {
    color: '#e6edf3',
    backgroundColor: '#0d1117',
    padding: 10,
    borderRadius: 6,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  fence: {
    color: '#e6edf3',
    backgroundColor: '#0d1117',
    padding: 10,
    borderRadius: 6,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  blockquote: {
    backgroundColor: '#0d1117',
    borderLeftWidth: 3,
    borderLeftColor: '#58a6ff',
    paddingLeft: 10,
    paddingVertical: 4,
    marginVertical: 4,
  },
  link: {color: '#58a6ff', textDecorationLine: 'underline'},
  list_item: {color: '#e6edf3', marginVertical: 2},
  bullet_list: {color: '#e6edf3'},
  ordered_list: {color: '#e6edf3'},
  em: {color: '#e6edf3', fontStyle: 'italic'},
  strong: {color: '#fff', fontWeight: '700'},
  text: {color: '#e6edf3'},
});

// Regras customizadas de renderização do Markdown.
// Substitui o renderizador padrão de `fence` (code blocks com fences ```),
// que depende do prism-react-renderer + MaterialDesignIcons — pesado e
// suscetível a falhas de layout (a View pai perde overflow/estilos quando
// o user style sobrescreve fence). Aqui usamos um ScrollView horizontal
// simples com Text monoespaçado — robusto e consistente com o dark theme.
//
// Assinatura do RenderRule (v9): (node, children, parentNodes, styles, ...extra) => ReactNode
//   node.content traz o código bruto da fence.
//   node.key é obrigatório como key do elemento raiz (animações/reconciliação).
const markdownRules = {
  fence: (node: any, _children: any, _parentNodes: any, _styles: any) => (
    <ScrollView
      key={node.key}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{marginVertical: 8}}>
      <Text style={mdStyle.fence}>{node.content}</Text>
    </ScrollView>
  ),
};

const s = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
    backgroundColor: '#0d1117',
  },
  headerTitle: {
    color: '#8b949e',
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
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '85%',
    // Largura fixa em ~85% para bubbles consistentes (evita que mensagens
    // curtas fiquem estreitas demais). Compatibilidade dark/light.
    width: '85%',
    padding: 12,
    // Espaço extra no rodapé para evitar que o conteúdo (Markdown longo)
    // se sobreponha ao actionBar (copy/regenerate/delete) logo abaixo.
    paddingBottom: 6,
    borderRadius: 12,
    marginBottom: 8,
  },
  bubbleUser: {
    backgroundColor: '#1f6feb',
    alignSelf: 'flex-end',
  },
  bubbleBot: {
    backgroundColor: '#161b22',
    alignSelf: 'flex-start',
  },
  bubbleError: {
    backgroundColor: '#3d1f1f',
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#6e232e',
  },
  bubbleText: {
    color: '#fff',
    fontSize: 15,
  },
  bubbleTextUser: {
    color: '#fff',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  statusText: {
    color: '#58a6ff',
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
    color: '#8b949e',
    fontSize: 12,
    fontStyle: 'italic',
  },
  typingDots: {
    flexDirection: 'row',
    gap: 3,
    marginLeft: 2,
  },
  typingDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#30363d',
  },
  typingDotActive: {
    backgroundColor: '#58a6ff',
  },
  thinkingBox: {
    backgroundColor: '#0d1117',
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#21262d',
  },
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginTop: 6,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    opacity: 0.7,
  },
  actionBarItem: {
    padding: 4,
  },
  thinkingText: {
    color: '#8b949e',
    fontSize: 12,
    lineHeight: 16,
  },
  waveformContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    height: 30,
  },
  waveformBar: {
    width: 4,
    borderRadius: 2,
    backgroundColor: '#f0883e',
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#161b22',
    gap: 8,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    backgroundColor: '#0d1117',
    gap: 8,
  },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: 22,
    backgroundColor: '#161b22',
  },
  thinkingBtn: {
    // Dentro do input — sem contorno, so o icone. Posicionado a esquerda.
    width: 40,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 4,
  },
  attachBtn: {
    // Botão de anexar imagem (clip) — mesma estrutura do thinkingBtn.
    width: 40,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 4,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 124, // ~5 linhas; acima disso scroll interno (item 5)
    paddingHorizontal: 8,
    paddingVertical: 10,
    color: '#e6edf3',
    fontSize: 15,
    textAlignVertical: 'center',
  },
  actionBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1f6feb',
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionBtnStop: {
    backgroundColor: '#da3633',
  },
  actionBtnMic: {
    backgroundColor: '#21262d',
  },
  actionBtnMicActive: {
    backgroundColor: '#da3633',
  },
  actionBtnMicError: {
    backgroundColor: '#3d1f1f',
    borderWidth: 1,
    borderColor: '#f85149',
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
    backgroundColor: '#0d1117',
    borderTopWidth: 1,
    borderTopColor: '#21262d',
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
    borderColor: '#0d1117',
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
    backgroundColor: '#161b22',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderWidth: 1,
    borderTopColor: '#30363d',
  },
  pickerSheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#30363d',
    alignSelf: 'center',
    marginBottom: 12,
  },
  pickerSheetTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e6edf3',
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
    backgroundColor: '#21262d',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#30363d',
  },
  pickerSheetOptionLabel: {
    fontSize: 13,
    color: '#8b949e',
    textAlign: 'center',
  },
  pickerSheetCancelBtn: {
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#21262d',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#30363d',
  },
  pickerSheetCancelText: {
    fontSize: 15,
    color: '#c9d1d9',
  },
});
