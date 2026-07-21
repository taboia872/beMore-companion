export type LlmProvider = 'localhost' | 'local';

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;       // ex: http://192.168.0.10:11434/v1
  apiKey: string;        // opcional para localhost
  model: string;         // nome do modelo (ex: qwen2.5, llama3)
  localModelPath?: string; // path no device para modelo GGUF (modo local)
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AppSettings {
  systemPrompt: string;
  llm: LlmConfig;
}
