import React, {useState, useRef, useEffect} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Platform,
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

interface Props {
  settings: AppSettings;
  onOpenSettings: () => void;
}

export function ChatScreen({settings, onOpenSettings}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
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
    setMessages(newMsgs);
    setInput('');
    setLoading(true);

    try {
      const context: Message[] = [
        {role: 'system', content: settings.systemPrompt},
        ...newMsgs,
      ];
      const reply = await generateResponse(context, settings.llm);
      setMessages([...newMsgs, {role: 'assistant', content: reply}]);
    } catch (e) {
      const errMsg = (e as Error).message ?? String(e);
      Alert.alert('Erro', errMsg);
      setMessages([
        ...newMsgs,
        {role: 'assistant', content: `⚠ ${errMsg}`, isError: true},
      ]);
    } finally {
      setLoading(false);
    }
  };

  const toggleMic = async () => {
    if (recorder.status === 'recording') {
      const path = await recorder.stop();
      if (path) {
        if (!settings.sttModelPath) {
          Alert.alert(
            'STT não configurado',
            'Defina o caminho do modelo Whisper em Settings para transcrever voz.',
          );
          return;
        }
        const transcript = await whisper.transcribe(path, settings.sttModelPath ?? '');
        if (transcript && transcript.trim()) {
          setInput(transcript.trim());
        } else if (whisper.errorMessage) {
          Alert.alert('Transcrição falhou', whisper.errorMessage);
        } else {
          Alert.alert('Vazio', 'Nenhuma fala detectada no áudio.');
        }
      }
    } else if (recorder.status === 'idle' || recorder.status === 'error') {
      await recorder.start();
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
          {settings.llm.model || 'modelo'}
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

      {/* Barra de texto inferior */}
      <View style={s.inputRow}>
        <TextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder="Mensagem..."
          placeholderTextColor="#aab2bc"
          editable={!loading}
          multiline
        />
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
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    backgroundColor: '#0d1117',
  },
  input: {
    flex: 1,
    color: '#e6edf3',
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#161b22',
    borderRadius: 20,
    fontSize: 15,
  },
  micBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#21262d',
    alignItems: 'center',
    justifyContent: 'center',
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
  micText: {
    color: '#8b949e',
    fontSize: 20,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1f6feb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.5,
  },
  sendText: {
    color: '#fff',
    fontSize: 18,
  },
});
