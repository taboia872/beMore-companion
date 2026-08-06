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
} from 'react-native';
import Icon from '@react-native-vector-icons/material-icons';
import {Clipboard} from 'react-native';
import {AppSettings, Message, MessageStatus} from '../types';
import {streamResponse, abortGeneration} from '../services/LlmService';
import {useRecorder} from '../hooks/useRecorder';
import {useWhisper} from '../hooks/useWhisper';
import {displayModelName} from '../utils/modelName';
import Markdown from '@ronradtke/react-native-markdown-display';

// Habilita LayoutAnimation p/ animar expansão/colapso do thinking no Android.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
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

  const listRef = useRef<FlatList<Message>>(null);
  const assistantIdRef = useRef<string | null>(null);

  const recorder = useRecorder();
  const whisper = useWhisper();

  useEffect(() => {
    listRef.current?.scrollToEnd({animated: true});
  }, [messages]);

  const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streaming) return;

    // Injeta instrução de thinking no system prompt dinamicamente quando ativo.
    // Não persiste em settings — só para essa rodada (item 4 + 7).
    // Usamos <think>... ( DeepSeek-R1 / Qwen3 / O1-style) em vez de
    // <thinking> porque é o que a maioria dos modelos que suportam reasoning
    // nativamente emite. Para modelos que não suportam, a instrução explícita
    // pede <thinking> como fallback — o parser do LlmService reconhece ambas.
    const sysContent = thinkingMode
      ? `${settings.systemPrompt}\n\nBefore answering, reason step by step inside <think>... tags, then write your final answer outside the tags. If you cannot produce think tags, wrap your reasoning in <thinking>...</thinking> instead.`
      : settings.systemPrompt;

    const userMsg: Message = {
      role: 'user',
      content: text,
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
    setStreaming(true);
    assistantIdRef.current = assistantId;

    // Atualiza a mensagem do assistant in-place por id. Aceita patch direto
    // OU updater funcional (precisa do estado anterior p/ concatenar tokens).
    // Token batching: acumula deltas e flush a cada 50ms para reduzir
    // re-renders do FlatList durante streaming (performance em RN).
    const pendingTokens = useRef<{content: string; thinking: string}>(
      {content: '', thinking: ''},
    );
    const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const flushPendingTokens = () => {
      const {content: c, thinking: t} = pendingTokens.current;
      if (!c && !t) return;
      pendingTokens.current = {content: '', thinking: ''};
      setMessages(prev =>
        prev.map(m => {
          if (m.id !== assistantId) return m;
          return {
            ...m,
            content: m.content + c,
            thinking: (m.thinking ?? '') + t,
          };
        }),
      );
    };

    const batchToken = (field: 'content' | 'thinking', delta: string) => {
      if (!delta) return;
      pendingTokens.current[field] += delta;
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(flushPendingTokens, 50);
    };

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
            batchToken('thinking', event.delta);
            updateAssistant({status: 'thinking'});
            break;
          case 'token':
            batchToken('content', event.delta);
            updateAssistant({status: 'streaming'});
            break;
          case 'done':
            flushPendingTokens();
            if (flushTimer.current) clearTimeout(flushTimer.current);
            updateAssistant({status: 'done'});
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
      );
    } catch (e) {
      const errMsg = (e as Error).message ?? String(e);
      updateAssistant({
        status: 'error',
        isError: true,
        content: `⚠ ${errMsg}`,
      });
    } finally {
      flushPendingTokens();
      if (flushTimer.current) clearTimeout(flushTimer.current);
      setStreaming(false);
      assistantIdRef.current = null;
    }
  };

  const stopGeneration = () => {
    abortGeneration();
    // abortGeneration dispara onabort do XHR -> onEvent('aborted') -> finally.
  };

  const toggleMic = async () => {
    if (recorder.status === 'idle' || recorder.status === 'error') {
      if (!settings.sttModelPath?.trim()) {
        Alert.alert(
          'STT não configurado',
          'Para usar o microfone, defina o caminho do modelo Whisper em Settings.',
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
        if (!settings.sttModelPath?.trim()) {
          Alert.alert(
            'STT não configurado',
            'Defina o caminho do modelo Whisper em Settings para transcrever voz.',
          );
          return;
        }
        const transcript = await whisper.transcribe(path, settings.sttModelPath);
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
    if (input.trim().length > 0) {
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

  const copyMessage = (text: string) => {
    if (text.trim()) Clipboard.setString(text);
  };

  const regenerateMessage = (msg: Message) => {
    const idx = messages.findIndex(m => m.id === msg.id);
    if (idx <= 0) return;
    const prevUser = messages
      .slice(0, idx)
      .reverse()
      .find(m => m.role === 'user');
    if (prevUser) send(prevUser.content);
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
      item.status === 'thinking' ? 'Pensando...' : null;
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
        {/* status de geração (item 3) */}
        {statusLabel && (
          <View style={s.statusRow}>
            <ActivityIndicator size="small" color="#58a6ff" />
            <Text style={s.statusText}>{statusLabel}</Text>
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
        {(item.content || !isStreamingMsg) && (
          isUser ? (
            <Text style={[s.bubbleText, s.bubbleTextUser]}>
              {item.content}
            </Text>
          ) : (
            <Markdown style={mdStyle}>{item.content}</Markdown>
          )
        )}
        {/* Action bar estilo llama-ui: icones apos a mensagem. */}
        {!isStreamingMsg && !item.isError && (
          <View style={s.actionBar}>
            <TouchableOpacity
              style={s.actionBarItem}
              onPress={() => copyMessage(item.content)}
              hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}>
              <Icon name="content-copy" size={15} color="#8b949e" />
            </TouchableOpacity>
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
        <TouchableOpacity onPress={onOpenSettings} style={s.iconBtn}>
          <Icon name="settings" size={24} color="#8b949e" />
        </TouchableOpacity>
      </View>

      {/* Area de mensagens */}
      <FlatList
        ref={listRef}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={item => item.id ?? `idx-${item.content}`}
        contentContainerStyle={s.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({animated: true})}
        keyboardShouldPersistTaps="handled"
      />

      {/* Status do gravador / transcrição */}
      {(recorder.status === 'processing' ||
        whisper.status === 'transcribing') && (
        <View style={s.statusBar}>
          <ActivityIndicator size="small" color="#58a6ff" />
          <Text style={s.statusText}>
            {whisper.status === 'transcribing'
              ? 'Transcrevendo...'
              : 'Processando áudio...'}
          </Text>
        </View>
      )}

      {/* Input bar — botao de thinking DENTRO do campo (sem contorno). */}
      <View style={s.inputBar}>
        <View style={s.inputWrap}>
          {/* Toggle thinking — icone lâmpada dentro do input, alinhado a esquerda.
              Sem backgroundColor/border: so o icone, p/ nao poluir a UI. */}
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
  list: {
    padding: 16,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '85%',
    padding: 12,
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
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 124, // ~5 linhas; acima disso scroll interno (item 5)
    paddingHorizontal: 8,
    paddingVertical: 10,
    color: '#e6edf3',
    fontSize: 15,
    textAlignVertical: 'top',
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
});
