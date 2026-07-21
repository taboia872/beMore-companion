import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import {AppSettings} from '../types';

interface Props {
  settings: AppSettings;
  onBack: () => void;
}

/**
 * DownloadScreen — Fase futura.
 * Placeholder para download de modelos GGUF para uso offline (llama.rn).
 * Aparece apenas quando LLM provider = 'local' e nenhum modelo está baixado.
 */
export function DownloadScreen({settings, onBack}: Props) {
  return (
    <View style={s.container}>
      <Text style={s.title}>Modelos locais</Text>
      <Text style={s.hint}>
        Em breve. Por enquanto, use Localhost nas configurações.
      </Text>
      <TouchableOpacity style={s.btn} onPress={onBack}>
        <Text style={s.btnText}>Voltar</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0d1117', padding: 24},
  title: {fontSize: 24, fontWeight: 'bold', color: '#fff', marginBottom: 16},
  hint: {color: '#6e7681', fontSize: 14, marginBottom: 32},
  btn: {
    backgroundColor: '#21262d',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnText: {color: '#fff', fontWeight: '600'},
});
