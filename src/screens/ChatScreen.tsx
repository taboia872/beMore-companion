import React, {useState, useRef, useEffect} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import {AppSettings, Message} from '../types';
import {generateResponse} from '../services/LlmService';

interface Props {
  settings: AppSettings;
  onOpenSettings: () => void;
}

export function ChatScreen({settings, onOpenSettings}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

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
      Alert.alert('Erro', String((e as Error).message));
      setMessages([
        ...newMsgs,
        {role: 'assistant', content: `Erro: ${(e as Error).message}`},
      ]);
    } finally {
      setLoading(false);
    }
  };

  const renderItem = ({item}: {item: Message}) => (
    <View style={[s.bubble, item.role === 'user' ? s.bubbleUser : s.bubbleBot]}>
      <Text style={s.bubbleText}>{item.content}</Text>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.header}>
        <Text style={s.headerTitle}>
          {settings.llm.provider === 'localhost'
            ? 'Localhost'
            : 'Local'}
        </Text>
        <TouchableOpacity onPress={onOpenSettings}>
          <Text style={s.headerBtn}>⚙</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        renderItem={renderItem}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={s.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({animated: true})}
      />

      <View style={s.inputRow}>
        <TextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder="Mensagem..."
          placeholderTextColor="#6e7681"
          editable={!loading}
        />
        <TouchableOpacity
          style={[s.sendBtn, loading && s.sendBtnDisabled]}
          onPress={send}
          disabled={loading}>
          <Text style={s.sendText}>{loading ? '...' : '➤'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d1117'},
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
  },
  headerTitle: {color: '#8b949e', fontSize: 14, fontWeight: '600'},
  headerBtn: {color: '#8b949e', fontSize: 22},
  list: {padding: 16},
  bubble: {maxWidth: '85%', padding: 12, borderRadius: 12, marginBottom: 8},
  bubbleUser: {backgroundColor: '#1f6feb', alignSelf: 'flex-end'},
  bubbleBot: {backgroundColor: '#161b22', alignSelf: 'flex-start'},
  bubbleText: {color: '#fff', fontSize: 15},
  inputRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#21262d',
  },
  input: {
    flex: 1,
    backgroundColor: '#161b22',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  sendBtn: {
    backgroundColor: '#238636',
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {opacity: 0.5},
  sendText: {color: '#fff', fontSize: 18},
});
