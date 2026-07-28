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
} from 'react-native';
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

  // Gravador de audio. Botao mic alterna start/stop.
  const recorder = useRecorder();

  // Transcrição on-device via whisper.rn. Carrega modelo lazy.
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
        {role: 'assistant', content: `⚠️ ${errMsg}`, isError: true},
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

  const micIcon = () => {
    if (recorder.status === 'recording') return '⏹';
    if (recorder.status === 'processing') return '…';
    if (recorder.status === 'error') return '⚠';
    return '🎤';
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
          <Text style={s.headerBtn}>⚙</Text>
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
          <Text style={s.statusText}>
            {whisper.status === 'transcribing'
              ? 'Transcrevendo…'
              : recorder.status === 'processing'
                ? 'Processando áudio…'
                : ''}
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
          placeholderTextColor="#6e7681"
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
          <Text style={s.micText}>{micIcon()}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.sendBtn, loading && s.sendBtnDisabled]}
          onPress={send}
          disabled={loading}>
          <Text style={s.sendText}>{loading ? '...' : '➤'}</Text>
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
  headerBtn: {
    color: '#8b949e',
    fontSize: 22,
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
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#161b22',
    borderTopWidth: 1,
    borderTopColor: '#21262d',
  },
  statusText: {
    color: '#8b949e',
    fontSize: 13,
    textAlign: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    backgroundColor: '#0d1117',
  },
  input: {
    flex: 1,
    backgroundColor: '#161b22',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 120,
    minHeight: 44,
  },
  micBtn: {
    backgroundColor: '#21262d',
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtnActive: {
    backgroundColor: '#da3633',
  },
  micBtnError: {
    backgroundColor: '#3d1f1f',
    borderWidth: 1,
    borderColor: '#6e232e',
  },
  micBtnDisabled: {
    opacity: 0.5,
  },
  micText: {
    color: '#fff',
    fontSize: 18,
  },
  sendBtn: {
    backgroundColor: '#238636',
    width: 44,
    height: 44,
    borderRadius: 8,
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
