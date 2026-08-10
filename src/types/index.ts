export type LlmProvider = 'localhost' | 'local';

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;       // ex: http://192.168.0.10:11434/v1
  apiKey: string;        // opcional para localhost
  model: string;         // nome do modelo (ex: qwen2.5, llama3)
  localModelPath?: string; // path no device para modelo GGUF (modo local)
}

/**
 * Status de geração de uma mensagem do assistant.
 * - 'thinking' : modelo está produzindo raciocínio (tag <thinking>) — exibir "Pensando..."
 * - 'streaming': modelo está produzindo conteúdo visível — exibir "Processando..."
 * - 'done'      : geração finalizada (estado normal da mensagem persistente)
 * - 'error'     : houve erro — mensagem representada como erro (isError true)
 */
export type MessageStatus = 'thinking' | 'streaming' | 'done' | 'error';

/**
 * Uma parte do conteúdo de uma mensagem multimodal.
 * - 'text'     : texto puro
 * - 'image_url': imagem anexada (base64 data URI ou URL)
 */
export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string; // data:image/jpeg;base64,... ou URL https://
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  /**
   * Conteúdo da mensagem. Pode ser texto puro (string) ou um array de
   * partes (multimodal: texto + imagem). O formato OpenAI-compatível aceita
   * ambos; o LlmService converte para o formato apropriado no payload.
   */
  content: string | ContentPart[];
  /**
   * Identificador único estável — usado p/ atualizar uma mensagem in-place
   * durante o streaming (acumular tokens no assistant placeholder sem
   * ambiguidade de índice). Gerado pelo ChatScreen ao criar a mensagem.
   */
  id?: string;
  /**
   * Marcador de erro: mensagens com isError=true são renderizadas destacadas
   * e EXCLUÍDAS do contexto enviado ao LLM na próxima chamada.
   */
  isError?: boolean;
  /**
   * Conteúdo entre tags <thinking></thinking> extraído do stream.
   * Exibido em campo expansível com fonte menor. Vazio se não houve thinking.
   */
  thinking?: string;
  /**
   * Status atual da geração. Só relevante para mensagens do assistant em fluxo
   * ou recém-finalizadas. undefined para mensagens user/system e históricas.
   */
  status?: MessageStatus;
}

export interface AppSettings {
  systemPrompt: string;
  llm: LlmConfig;
  /**
   * Modo de transcrição de voz (STT):
   * - 'on-device': usa whisper.rn com modelo GGUF local (sttModelPath)
   * - 'online':    usa API de transcrição (Groq/OpenAI-compatível)
   */
  sttMode?: 'on-device' | 'online';
  /**
   * Caminho no device para o modelo Whisper GGUF (STT on-device).
   * Se vazio, transcrição on-device fica indisponível.
   */
  sttModelPath?: string;
  /**
   * Nome do modelo para STT online (ex: 'whisper-large-v3', 'whisper-large-v3-turbo').
   * Usado quando sttMode === 'online'. Se vazio, STT online fica indisponível.
   */
  sttOnlineModel?: string;
  /**
   * Override opcional de servidor para STT online.
   * Se vazio, reutiliza baseUrl+apiKey do servidor LLM atual.
   * Se preenchido, usa esta URL (com apiKey do Keychain para este hostname).
   */
  sttServerOverride?: string;
  /**
   * Nome do modelo para TTS online (ex: 'tts-1', 'tts-1-hd').
   * Se vazio, TTS fica indisponível.
   */
  ttsOnlineModel?: string;
  /**
   * Override opcional de servidor para TTS online.
   * Se vazio, reutiliza baseUrl+apiKey do servidor LLM atual.
   * Se preenchido, usa esta URL (com apiKey do Keychain para este hostname).
   */
  ttsServerOverride?: string;
  /**
   * Voz para TTS (ex: 'alloy', 'nova', 'shimmer', 'echo', 'fable', 'onyx').
   * O padrão depende do provedor. OpenAI/Groq usam estes nomes.
   */
  ttsVoice?: string;
  /**
   * Se true, toca automaticamente o áudio TTS da resposta do assistant
   * assim que a geração termina. O usuário pode ativar/desativar pelo
   * botão na header do chat.
   */
  ttsAutoPlay?: boolean;
  /**
   * Habilita/desabilita o streaming de respostas da IA. Quando true (padrão),
   * tokens aparecem em tempo real conforme chegam (via SSE). Quando false, a
   * resposta completa é aguardada em uma única requisição sem stream — útil
   * em servidores que não suportam SSE ou quando o usuário prefere esperar.
   */
  streamingEnabled?: boolean;
}
