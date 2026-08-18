// ---------------------------------------------------------------------------
// Legacy — LlmConfig (pré-server-manager). Mantido para migration e
// compatibilidade durante a transição. Será removido na Phase 5.
// ---------------------------------------------------------------------------
export type LlmProvider = 'localhost' | 'local';

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;       // ex: http://192.168.0.10:11434/v1
  apiKey: string;        // opcional para localhost
  model: string;         // nome do modelo (ex: qwen2.5, llama3)
  localModelPath?: string; // path no device para modelo GGUF (modo local)
  serverFormat?: ServerFormat; // formato V2 (openai, gemini, etc)
}

// ---------------------------------------------------------------------------
// Server Manager — novos tipos (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Formato de comunicação do servidor.
 * - 'openai':      Bearer auth, /v1/chat/completions, /v1/models (padrão)
 * - 'gemini':       Header x-goog-api-key, /v1beta/openai/chat/completions, /v1beta/models
 * - 'ollama':      Sem auth (localhost), /v1/chat/completions, /v1/models
 * - 'custom':      Mesma estrutura OpenAI, mas o usuário pode definir paths
 * - 'pollinations': GET-based image gen, sem API key, sem POST
 */
export type ServerFormat = 'openai' | 'gemini' | 'ollama' | 'custom' | 'pollinations';

/**
 * Papel / capability que um modelo pode ter.
 * - 'chat':      Geração de texto (LLM padrão — chat completions)
 * - 'vision':    Consumir imagem (input multimodal — image_url no content)
 * - 'stt':       Speech-to-Text (transcrição de áudio)
 * - 'tts':       Text-to-Speech (síntese de áudio)
 * - 'image_gen': Geração de imagem (output — produz imagem a partir de texto)
 *
 * Visão vs Image Gen são opostos: Visão CONSUME imagem, Image Gen PRODUZ imagem.
 */
export type ModelRole = 'chat' | 'vision' | 'stt' | 'tts' | 'image_gen';

/**
 * Estratégia de rotação quando um servidor tem múltiplas API keys.
 * - 'single':      Usa sempre a key ativa (primeira não-exhausted)
 * - 'round-robin': Alterna entre keys a cada requisição
 * - 'failover':    Usa a key ativa; se ela falhar (429/401), tenta a próxima
 */
export type KeyRotationStrategy = 'single' | 'round-robin' | 'failover';

/**
 * Um servidor cadastrado no app.
 * A API key NÃO vive aqui — fica no Keychain, keyed por serverId+keyIndex.
 */
export interface ServerEntry {
  id: string;                      // UUID v4 (utils/uuid.ts uuidv4())
  name: string;                    // Nome amigável ex: "Minha Ollama", "OpenRouter"
  baseUrl: string;                 // URL base ex: "https://api.groq.com/openai/v1"
  format: ServerFormat;            // Determina método de auth e paths
  icon: string;                    // Nome do ícone MaterialIcons
  hasFreeModels: boolean;          // Hint para filtro (override manual possível)
  // Multi-key
  apiKeyCount: number;             // Quantas keys cadastradas (0 = sem key, ex: Ollama local)
  keyRotation: KeyRotationStrategy; // Como alternar entre keys
  activeKeyIndex: number;          // Qual key está em uso agora (0-based)
  keyLabels?: string[];            // Nomes amigáveis para cada key (opcional, por índice)
  cooldownMinutes?: number;         // Minutos de cooldown para failover (default 1)
  // Metadata
  createdAt: number;               // Date.now()
  updatedAt: number;
}

/**
 * Um modelo cadastrado (resultado de fetch de /models).
 */
export interface ModelEntry {
  id: string;                      // UUID do registro
  serverId: string;                // FK → ServerEntry.id
  modelId: string;                 // ID retornado pela API ex: "llama3", "gpt-4o"
  displayName?: string;             // Override editável pelo usuário (se vazio, usa modelId)
  // Badges/capabilities — auto-detectadas no fetch, editáveis manualmente
  isVision?: boolean;
  isStt?: boolean;
  isTts?: boolean;
  isAnyToAny?: boolean;
  isImageGen?: boolean;            // Modelo que GERA imagens (output) — diferente de vision (input)
  isFree?: boolean;                // Override manual se a auto-detecção errou
  // Organização do usuário
  isFavorite: boolean;             // Aparece em lista de favoritos
  isHidden: boolean;               // Removido das listas mas não deletado (soft delete do fetch)
  isUserHidden: boolean;           // Ocultado manualmente pelo usuário (persiste entre fetchs)
  // Metadata de fetch
  lastFetchedAt: number;           // Date.now() do último /models fetch
}

/**
 * Settings V2 — tudo em MMKV, referências por ID.
 * Substitui AppSettings (legado) gradualmente.
 */
export interface AppSettingsV2 {
  // Referências ao servidor/modelo ativos
  activeServerId: string | null;
  activeModelId: string | null;         // FK → ModelEntry.id (chat/texto)
  activeSttModelId: string | null;     // FK → ModelEntry.id (override de STT)
  activeTtsModelId: string | null;     // FK → ModelEntry.id (override de TTS)
  activeImageGenModelId: string | null; // FK → ModelEntry.id (geração de imagem)
  // Servidores override para STT/TTS/ImageGen (null = usa activeServer)
  sttServerId: string | null;
  ttsServerId: string | null;
  imageGenServerId: string | null;
  // Config geral
  systemPrompt: string;
  theme: 'dark' | 'light';
  sttMode: 'on-device' | 'online';
  sttModelPath?: string;               // Path no device para modelo Whisper GGUF
  ttsVoice?: string;
  ttsAutoPlay?: boolean;
  streamingEnabled?: boolean;
  // Flag de migration
  migrated: boolean;
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

export type AppTheme = 'dark' | 'light';

export interface AppSettings {
  systemPrompt: string;
  llm: LlmConfig;
  /** Tema da interface: 'dark' (padrão) ou 'light'. */
  theme?: AppTheme;
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
