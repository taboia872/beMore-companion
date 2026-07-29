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
} from 'react-native';
import Icon from '@react-native-vector-icons/material-icons';
import {AppSettings, Message} from '../types';
import {generateResponse} from '../services/LlmService';
import {useRecorder} from '../hooks/useRecorder';
import {useWhisper} from '../hooks/useWhisper';
import {shortModelName} from '../utils/modelName';

interface Props {
  settings: AppSettings;
  messages: Message[];
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
  onOpenSettings: () => void;
}

export function ChatScreen({settings, messages, setMessages, onOpenSettings}: Props) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  const recorder = useRecorder();
  const whisper = useWhisper();

  useEffect(() => {
    listRef.current?.scrollToEnd({animated: true});
  }, [messages]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg: Message = {role: 'user', content: input.trim()};
    const newMsgs = [...messages, userMsg];
    setMessages(() => newMsgs);
    setInput('');
    setLoading(true);

    try {
      const context: Message[] = [
        {role: 'system', content: settings.systemPrompt},
        ...newMsgs,
      ];
      const reply = await generateResponse(context, settings.llm);
      setMessages(() => [...newMsgs, {role: 'assistant', content: reply}]);
    } catch (e) {
      const errMsg = (e as Error).message ?? String(e);
      Alert.alert('Erro', errMsg);
      setMessages(() => [
        ...newMsgs,
        {role: 'assistant', content: `⚠ ${errMsg}`, isError: true},
      ]);
    } finally {
      setLoading(false);
    }
  };

  const toggleMic = async () => {
    // Checagem pré-gravação: STT não configurado? Avisa ANTES de gravar,
    // em vez de iniciar e falhar depois —  evita a sensação de "travou".
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
        const msg = (e as Error)?.message ?? String(e);
        Alert.alert('Erro ao iniciar microfone', msg);
      }
      return;
    }
    // Estado recording → parar e transcrever
    if (recorder.status === 'recording') {
      try {
        const path = await recorder.stop();
        if (!path) return;
        if (!settings.sttModelPath?.trim()) {
          // Não deve chegar aqui (checamos antes de iniciar), mas defensive.
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
        const msg = (e as Error)?.message ?? String(e);
        Alert.alert('Erro no microfone', msg);
      }
    }
  };

  const renderItem = ({item}: {item: Message}) => (
    <View
      style={[
        s.bubble,
        item.role === 'user'
          ? s.bubbleUser
          : item.isError
            ? s.bubbleError
            : s.bubbleBot,
      ]}>
      <Text style={s.bubbleText}>{item.content}</Text>
    </View>
  );

  const micIconName = () => {
    if (recorder.status === 'recording') return 'stop' as const;
    if (recorder.status === 'processing') return 'hourglass-top' as const;
    if (recorder.status === 'error') return 'warning' as const;
    return 'mic' as const;
  };

  const micIconColor = (): string => {
    if (recorder.status === 'recording') return '#fff';
    if (recorder.status === 'error') return '#f85149';
    return '#8b949e';
  };

  const headerTitle = shortModelName(settings.llm.model) || 'modelo';

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
        renderItem={renderItem}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={s.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({animated: true})}
        keyboardShouldPersistTaps="handled"
      />

      {/* Status do gravador / transcrição */}
      {(recorder.status === 'processing' || whisper.status === 'transcribing') && (
        <View style={s.statusBar}>
          <ActivityIndicator size="small" color="#58a6ff" />
          <Text style={s.statusText}>
            {whisper.status === 'transcribing'
              ? 'Transcrevendo...'
              : 'Processando áudio...'}
          </Text>
        </View>
      )}

      {/* Input bar */}
      <View style={s.inputBar}>
        <TouchableOpacity
          style={[
            s.micBtn,
            recorder.status === 'recording' && s.micBtnActive,
            recorder.status === 'error' && s.micBtnError,
            recorder.status === 'processing' && s.micBtnDisabled,
          ]}
          onPress={toggleMic}
          disabled={recorder.status === 'processing'}>
          <Icon name={micIconName()} size={22} color={micIconColor()} />
        </TouchableOpacity>

        <TextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder="Mensagem..."
          placeholderTextColor="#aab2bc"
          multiline
        />

        <TouchableOpacity
          style={[s.sendBtn, loading && s.sendBtnDisabled]}
          onPress={send}
          disabled={loading}>
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Icon name="send" size={20} color="#fff" />
          )}
        </TouchableOpacity>
      </View>
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
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#161b22',
    gap: 8,
  },
  statusText: {
    color: '#58a6ff',
    fontSize: 13,
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
  micBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#21262d',
    justifyContent: 'center',
    alignItems: 'center',
  },
  micBtnActive: {
    backgroundColor: '#da3633',
  },
  micBtnError: {
    backgroundColor: '#3d1f1f',
    borderWidth: 1,
    borderColor: '#f85149',
  },
  micBtnDisabled: {
    opacity: 0.5,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 22,
    backgroundColor: '#161b22',
    color: '#e6edf3',
    fontSize: 15,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1f6feb',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.5,
  },
});
