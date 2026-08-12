# Server Manager — Documento de Design

> **Status:** Draft v2 — decisões confirmadas com Juliano (13/ago/2026)
> **Branch:** `feature/server-manager` (criada a partir do `main` pós-merge)

## Visão Geral

Substituir a configuração atual (um único `LlmConfig` hardcoded em `AppSettings`) por um **banco de dados interno** que cadastra servidores (endpoints + API keys + formato de comunicação) e um **catálogo persistente de modelos** buscados de cada servidor.

Objetivo: fluxo parecido com OpenRouter/9router — cadastrar servidores, fazer fetch dos modelos uma única vez, persistir a lista, marcar favoritos, esconder os irrelevantes, corrigir badges manualmente, e selecionar modelos de servidores diferentes sem precisar re-fetch.

---

## 1. Decisões Confirmadas

| # | Decisão | Detalhe |
|---|---|---|
| 1 | **UUID** (`crypto.randomUUID()`) | Sem risco de colisão. Atualizar o app (overwrite install) preserva os dados — MMKV e Keychain sobrevivem a updates. |
| 2 | **MMKV para tudo** | Migrar settings + servers + models para `react-native-mmkv`. Abandonar AsyncStorage completamente. |
| 3 | **Presets expandidos** | Lista maior de presets com URLs corretas, ícones, e flag `hasFreeModels`. Usuário pode cadastrar URL personalizada com ícone custom. Ver seção 3. |
| 4 | **STT/TTS como FK** | `sttServerId: string \| null` e `ttsServerId: string \| null` — referenciam `ServerEntry.id`. |
| 5 | **Multi-key + rotação** | Um servidor pode ter múltiplas API keys. Estratégias de rotação: round-robin, failover. Ver seção 5. |
| 6 | **Badge offline só no ativo** | Não pingar todos os servidores. Só verificar status do servidor do modelo selecionado. Ver seção 6. |
| 7 | **Sem limite de servidores** | App pessoal — sem cap. |
| 8 | **Fetch/re-fetch manual** | Botão 🔄 explícito. Sem auto-fetch a cada abertura. |

---

## 2. Arquitetura de Dados

### 2.1 Tecnologia: MMKV + Keychain (sem SQLite, sem AsyncStorage)

- **react-native-mmkv** para TUDO (settings, servers, models) — JSON serializado, síncrono, ultra rápido
- **react-native-keychain** para API keys — uma entrada por key, keyed por `bemore-apikey-<serverId>-<keyIndex>`
- **AsyncStorage** → abandonado. Migration lê o legado uma única vez e migra para MMKV.
- **react-native-get-random-values** — polyfill para `crypto.randomUUID()` no RN

Notas:
- MMKV é síncrono (sem `await`) — simplifica a UI, sem loading states para ler config
- MMKV sobrevive a updates do app (overwrite install) — os dados ficam no sandbox do app
- Keychain (Android Keystore) também sobrevive a updates — as API keys não se perdem
- Se o projeto crescer (chats persistidos, histórico), aí sim migrar para op-sqlite

### 2.2 Storage Layout

```
MMKV (single instance):
  @bemore_settings_v2  → JSON: AppSettingsV2
  @bemore_servers      → JSON: ServerEntry[]
  @bemore_models       → JSON: ModelEntry[]

Keychain (Android Keystore):
  bemore-apikey-<serverId>-<keyIndex>  → apiKey individual
  (cada servidor pode ter N keys, keyIndex = 0, 1, 2, ...)

AsyncStorage (legado — migrado e abandonado):
  @bemore_settings  → lido uma vez na migration, nunca mais escrito
```

### 2.3 Schema

```typescript
// src/types/index.ts (extensão)

/**
 * Formato de comunicação do servidor.
 * - 'openai':    Bearer auth, /v1/chat/completions, /v1/models (padrão)
 * - 'gemini':    Header x-goog-api-key, /v1beta/openai/chat/completions, /v1beta/models
 * - 'ollama':    Sem auth (localhost), /v1/chat/completions, /v1/models
 * - 'custom':    Mesma estrutura OpenAI, mas o usuário pode definir paths
 */
export type ServerFormat = 'openai' | 'gemini' | 'ollama' | 'custom' | 'pollinations';

/**
 * Papel / capability que um modelo pode ter.
 * - 'chat':     Geração de texto (LLM padrão — chat completions)
 * - 'vision':   Consumir imagem (input multimodal — image_url no content)
 * - 'stt':      Speech-to-Text (transcrição de áudio)
 * - 'tts':      Text-to-Speech (síntese de áudio)
 * - 'image_gen': Geração de imagem (output — produz imagem a partir de texto)
 *
 * Visão vs Image Gen são opostos: Visão CONSUME imagem, Image Gen PRODUZ imagem.
 * Um modelo pode ter múltiplas capabilities (ex: GPT-4o tem chat + vision).
 * Image generation tem endpoint/payload diferente de chat (ver ServerService).
 */
export type ModelRole = 'chat' | 'vision' | 'stt' | 'tts' | 'image_gen';

/**
 * Estratégia de rotação quando um servidor tem múltiplas API keys.
 * - 'single':    Usa sempre a key ativa (primeira não-exhausted)
 * - 'round-robin': Alterna entre keys a cada requisição
 * - 'failover':  Usa a key ativa; se ela falhar (429/401), tenta a próxima
 */
export type KeyRotationStrategy = 'single' | 'round-robin' | 'failover';

/**
 * Um servidor cadastrado no app.
 */
export interface ServerEntry {
  id: string;                    // UUID (crypto.randomUUID())
  name: string;                  // Nome amigável ex: "Minha Ollama", "OpenRouter"
  baseUrl: string;               // URL base ex: "https://api.groq.com/openai/v1"
  format: ServerFormat;          // Determina método de auth e paths
  icon: string;                  // Nome do ícone MaterialIcons
  hasFreeModels: boolean;        // Hint para filtro (override manual possível)
  // Multi-key
  apiKeyCount: number;           // Quantas keys cadastradas (0 = sem key, ex: Ollama local)
  keyRotation: KeyRotationStrategy; // Como alternar entre keys
  activeKeyIndex: number;        // Qual key está em uso agora (0-based)
  // Metadata
  createdAt: number;             // Date.now()
  updatedAt: number;
  // NOTA: API keys NÃO vivem aqui — ficam no Keychain, keyed por serverId+keyIndex
}

/**
 * Um modelo cadastrado (resultado de fetch de /models).
 */
export interface ModelEntry {
  id: string;                    // UUID do registro
  serverId: string;              // FK → ServerEntry.id
  modelId: string;               // ID retornado pela API ex: "llama3", "gpt-4o"
  displayName?: string;          // Override editável pelo usuário (se vazio, usa modelId)
  // Badges/capabilities — auto-detectadas no fetch, editáveis manualmente
  isVision?: boolean;
  isStt?: boolean;
  isTts?: boolean;
  isAnyToAny?: boolean;
  isImageGen?: boolean;          // Modelo que GERA imagens (output) — diferente de vision (input)
  isFree?: boolean;              // Override manual se a auto-detecção errou
  // Organização do usuário
  isFavorite: boolean;           // Aparece em lista de favoritos
  isHidden: boolean;             // Removido das listas mas não deletado (soft delete)
  // Metadata de fetch
  lastFetchedAt: number;         // Date.now() do último /models fetch
}

/**
 * Settings V2 — tudo em MMKV, referencias por ID.
 */
export interface AppSettingsV2 {
  // Referências ao servidor/modelo ativos
  activeServerId: string | null;
  activeModelId: string | null;     // FK → ModelEntry.id
  activeSttModelId: string | null;  // FK → ModelEntry.id (override de STT)
  activeTtsModelId: string | null;  // FK → ModelEntry.id (override de TTS)
  activeImageGenModelId: string | null;  // FK → ModelEntry.id (geração de imagem)
  // Servidores override para STT/TTS/ImageGen (null = usa activeServer)
  sttServerId: string | null;
  ttsServerId: string | null;
  imageGenServerId: string | null;  // Servidor para geração de imagem (pode ser diferente do chat)
  // Config geral
  systemPrompt: string;
  theme: 'dark' | 'light';
  sttMode: 'on-device' | 'online';
  sttModelPath?: string;           // Path no device para modelo Whisper GGUF
  ttsVoice?: string;
  ttsAutoPlay?: boolean;
  streamingEnabled?: boolean;
  // Flag de migration
  migrated: boolean;
}
```

---

## 3. Presets de Servidores (expandidos)

Lista de presets com URLs corretas, ícones MaterialIcons, e flag de free tier.
Servidores com **apenas modelos fechados** ou **API paga sem free tier** são excluídos por enquanto.

```typescript
const SERVER_PRESETS: ServerPreset[] = [
  // --- Free tier generoso ---
  {
    name: 'Google AI Studio',
    url: 'https://generativelanguage.googleapis.com/v1beta',
    icon: 'auto-awesome',
    format: 'gemini',
    hasFreeModels: true,
    description: 'Gemini 2.0/2.5 Flash, Pro — free tier generoso',
  },
  {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1',
    icon: 'bolt',
    format: 'openai',
    hasFreeModels: true,
    description: 'LPU ultra-rápido. Llama, Mixtral, Whisper STT — free sem cartão',
  },
  {
    name: 'Cerebras',
    url: 'https://api.cerebras.ai/v1',
    icon: 'memory',
    format: 'openai',
    hasFreeModels: true,
    description: '1M tokens/dia free. Llama 3.1, Qwen — inference ultra-rápido',
  },
  {
    name: 'SambaNova',
    url: 'https://api.sambanova.ai/v1',
    icon: 'developer-board',
    format: 'openai',
    hasFreeModels: true,
    description: 'DeepSeek-V3.1, Llama — free tier OpenAI-compatível',
  },
  {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1',
    icon: 'route',
    format: 'openai',
    hasFreeModels: true,
    description: 'Agregador — 100s de modelos, vários com :free',
  },
  {
    name: 'AIHorde',
    url: 'https://oai.aihorde.net/v1',
    icon: 'groups',
    format: 'openai',
    hasFreeModels: true,
    description: 'Crowdsourced — tudo gratuito, modelos da comunidade',
  },
  {
    name: 'Ollama Cloud',
    url: 'https://ollama.com/v1',
    icon: 'cloud-queue',
    format: 'openai',
    hasFreeModels: true,
    description: 'gemma, gpt-oss, qwen3 — free tier cloud',
  },
  {
    name: 'HuggingFace',
    url: 'https://router.huggingface.co/v1',
    icon: 'hub',
    format: 'openai',
    hasFreeModels: true,
    description: 'Router HF — modelos open com free tier',
  },
  // --- Image Generation ---
  {
    name: 'Pollinations',
    url: 'https://image.pollinations.ai/prompt',
    icon: 'image',
    format: 'pollinations',
    hasFreeModels: true,
    description: 'Geração de imagem FREE — sem API key, sem cadastro. Flux, GPT Image, etc',
  },
  // --- Local (sem API key) ---
  {
    name: 'Ollama Local',
    url: 'http://localhost:11434/v1',
    icon: 'dns',
    format: 'ollama',
    hasFreeModels: true,
    description: 'Servidor local — modelos GGUF na sua máquina',
  },
  {
    name: 'LM Studio',
    url: 'http://localhost:1234/v1',
    icon: 'laptop',
    format: 'openai',
    hasFreeModels: true,
    description: 'Servidor local — qualquer modelo GGUF',
  },
];
```

**Custom:** usuário pode cadastrar qualquer URL. Ao escolher "Personalizado",
pode selecionar um ícone da lista de MaterialIcons (picker visual) ou usar
`'dns'` como default.

---

## 4. Fluxos de Telas

### 4.1 Onboarding (primeira abertura)

```
┌─────────────────────────┐
│   Bem-vindo ao BeMore   │
│                         │
│   ████ (logo/icone)      │
│                         │
│  Como ira se conectar?  │
│                         │
│  ┌─────────────────┐    │
│  │ ☁ Servidor Online│   │
│  │   (Groq, OpenR…) │   │
│  └─────────────────┘    │
│  ┌─────────────────┐    │
│  │ 🖥 Servidor Local │   │
│  │  (Ollama/LM St.) │   │
│  └─────────────────┘    │
└─────────────────────────┘
```

**Se "Servidor Online":**
1. Mostrar grid de presets (com ícone, nome, descrição curta)
2. Usuário seleciona preset OU escolhe "Personalizado" (digita URL + escolhe ícone)
3. Campo(s) de API key aparece(m) — pode adicionar mais de uma (ver seção 5)
4. Botão "Buscar modelos" → fetch `/models`
5. Modelos aparecem em lista → usuário marca favoritos, esconde os que não quer
6. "Concluir" → salva server + models + seta active

**Se "Servidor Local":**
1. Campo de URL (default conforme preset: `http://localhost:11434/v1`)
2. Sem API key (Ollama local não precisa)
3. Botão "Buscar modelos" → fetch
4. Modelos aparecem → marca favoritos
5. "Concluir"

### 4.2 Tela de Seleção de Modelo (no chat)

```
┌───────────────────────────┐
│ Modelo: llama3       ▼    │  ← botão no header do chat
│                           │
│  Ao tocar, abre modal:    │
│  ┌─────────────────────┐  │
│  │ ⭐ Favoritos      🔍 │  │
│  ├─────────────────────┤  │
│  │ ○ Minha Ollama   ▼  │  │  ← agrupado por servidor
│  │   • qwen2.5        ✗ │  │  ← ✗ = hidden
│  │   ⭐ llama3          │  │  ← ⭐ = favorite
│  │   • deepseek-r1      │  │
│  ├─────────────────────┤  │
│  │ ○ OpenRouter      ▼  │  │
│  │   ⭐ gpt-4o FREE      │  │
│  │   • claude-3.5-son   │  │
│  │   • gemini-2-flash   │  │
│  ├─────────────────────┤  │
│  │ + Adicionar servidor  │  │
│  └─────────────────────┘  │
└───────────────────────────┘
```

Filtros no topo do modal:
- **Todos** | **⭐ Favoritos** | **FREE** | **Visão** | **STT** | **TTS**
- Ordenação agrupada por servidor (como OpenRouter)

Ações por modelo (menu de 3 pontos):
- ⭐ Favoritar/Desfavoritar
- 👁 Mostrar/Ocultar (hidden)
- ✏️ Editar badges (corrigir visão/STT/TTS/free)
- 🗑 Deletar (remove do catálogo — re-fetch traz de volta)
- 🔄 Re-fetch deste servidor (atualiza lista de modelos do server inteiro)

### 4.3 Badge Offline — somente modelo ativo

- **NÃO** fazer health check de todos os servidores ao abrir o app
- **Somente** quando o usuário tenta usar o modelo ativo e a requisição falha:
  - Mostrar badge "offline" no botão de modelo do header do chat
  - Badge some assim que a próxima requisição tiver sucesso
- Privacidade: o app não "anuncia" a todos os servidores que está ativo
- Implementação: native do XHR error handling do LlmService (já existe), só adicionar flag visual

### 4.4 Settings — Seção "Servidores"

```
┌─────────────────────────────┐
│  Configurações              │
│                             │
│  ┌─ Servidores ───────────┐ │
│  │ Ex: 2 servidores       │ │
│  │                        │ │
│  │ ● Minha Ollama     ⚙  │ │  ← tocar abre edição
│  │   localhost:11434      │ │
│  │   3 modelos (1⭐ 1✗)   │ │
│  │                        │ │
│  │ ● OpenRouter       ⚙  │ │
│  │   openrouter.ai       │ │
│  │   47 modelos (3⭐)     │ │
│  │   2 API keys (rot: RR) │ │  ← mostra multi-key + estratégia
│  │                        │ │
│  │  + Adicionar servidor   │ │
│  └────────────────────────┘ │
│                             │
│  ┌─ Outras configs ───────┐ │
│  │ Prompt do sistema       │ │
│  │ Tema                    │ │
│  │ Streaming               │ │
│  │ STT                     │ │
│  │ TTS                     │ │
│  └────────────────────────┘ │
└─────────────────────────────┘
```

**Touch no servidor → tela de edição:**
```
┌─────────────────────────────┐
│  ← Editar Servidor          │
│                             │
│  Nome: [Minha Ollama      ] │
│  URL:  [http://192.168... ] │
│  Formato: [Ollama      ▼]  │
│  Ícone:  [dns          ▼]  │  ← picker visual de MaterialIcons
│                             │
│  API Keys (2):              │
│  ┌───────────────────────┐  │
│  │ Key 1: ●●●●●●●● [↓]  │  │  ← ativa (● = dots, não mostra a key)
│  │ Key 2: ●●●●●●●● [×]  │  │  ← remover
│  │ [+ Adicionar key]      │  │
│  └───────────────────────┘  │
│  Rotação: [Round-robin ▼]  │
│                             │
│  Modelos (3):               │
│  ┌───────────────────────┐  │
│  │ ⭐ llama3          ⚙  │  │
│  │ • deepseek-r1      ⚙  │  │
│  │ • qwen2.5  (hidden) ⚙ │  │
│  └───────────────────────┘  │
│  [🔄 Re-fetch modelos]      │
│  [🗑 Deletar servidor]      │
└─────────────────────────────┘
```

---

## 5. Multi-Key + Rotação de API Keys

### 5.1 Motivação

Serviços free tier têm rate limits (ex: Groq 30 RPM, Cerebras 30 RPM). Ter
múltiplas API keys do mesmo serviço permite dobrar/triplicar a quota efetiva.

### 5.2 Storage

Cada key é armazenada individualmente no Keychain:
```
bemore-apikey-<serverId>-0  → primeira key
bemore-apikey-<serverId>-1  → segunda key
bemore-apikey-<serverId>-2  → terceira key
```

O `ServerEntry` rastreia `apiKeyCount` e `activeKeyIndex` (qual está em uso).

### 5.3 Estratégias de Rotação

```typescript
export type KeyRotationStrategy = 'single' | 'round-robin' | 'failover';

/**
 * Retorna a API key a usar para a próxima requisição.
 */
function getKeyForRequest(server: ServerEntry): string {
  switch (server.keyRotation) {
    case 'single':
      // Sempre usa activeKeyIndex
      return loadApiKeyFromKeychain(server.id, server.activeKeyIndex);

    case 'round-robin':
      // Alterna a cada chamada: 0 → 1 → 2 → 0 → 1 → ...
      const nextIndex = (server.activeKeyIndex + 1) % server.apiKeyCount;
      updateServer({...server, activeKeyIndex: nextIndex});
      return loadApiKeyFromKeychain(server.id, server.activeKeyIndex);

    case 'failover':
      // Usa a ativa. Se falhar (429/401), tenta a próxima não-exhausted.
      // Implementado no LlmService via retry:
      //   1. Tentar com key ativa
      //   2. Se 429/401 → marcar key como "exhausted" (timestamp + cooldown)
      //   3. Avançar activeKeyIndex para próxima
      //   4. Retriar com nova key
      //   5. Se todas exhausted → erro "Todas as API keys deste servidor
      //      atingiram o rate limit. Aguarde ou adicione mais keys."
      return loadApiKeyFromKeychain(server.id, server.activeKeyIndex);
  }
}
```

### 5.4 Failover — Cooldown de Keys Exhausted

```typescript
// Em memória (não persistido) — reseta ao reiniciar o app
const exhaustedKeys: Map<string, number> = new Map();
// key: `${serverId}-${keyIndex}`, value: Date.now() do cooldown

function isKeyExhausted(serverId: string, keyIndex: number): boolean {
  const key = `${serverId}-${keyIndex}`;
  const exhaustedAt = exhaustedKeys.get(key);
  if (!exhaustedAt) return false;
  // Cooldown de 60s — depois tenta de novo
  if (Date.now() - exhaustedAt > 60_000) {
    exhaustedKeys.delete(key);
    return false;
  }
  return true;
}

function markKeyExhausted(serverId: string, keyIndex: number): void {
  exhaustedKeys.set(`${serverId}-${keyIndex}`, Date.now());
}
```

### 5.5 UI para Multi-Key

No `ServerEditorScreen`:
- Lista de keys numeradas (mascaradas: `●●●●●●●●`)
- Botão para adicionar nova key
- Botão (×) para remover key individual
- Dropdown de estratégia de rotação
- Indicador visual de qual key está ativa (●)
- Se failover: mostrar quais keys estão em cooldown (cinza + timestamp)

---

## 5.5. Image Generation — Papel separado de Visão

### Conceito

- **Visão** (badge `isVision`): modelo CONSUME imagem no input (image_url no chat).
  Já é suportado pelo chat atual — se o modelo ativo tem visão, você anexa foto.
- **Image Generation** (badge `isImageGen`): modelo PRODUZ imagem no output.
  É um endpoint/payload totalmente diferente de chat completions.

### Endpoints de Image Generation

Cada formato de servidor tem um endpoint diferente:

```typescript
// ServerService.ts — adicionar buildImageGenUrl()

export function buildImageGenUrl(server: ServerEntry): string {
  const clean = server.baseUrl.replace(/\/+$/, '');
  switch (server.format) {
    case 'openai':
      // OpenAI: POST /v1/images/generations
      // Body: { model: "gpt-image-2", prompt: "...", size: "1024x1024" }
      // Response: { data: [{ b64_json: "..." }] } ou { data: [{ url: "..." }] }
      return `${clean}/images/generations`;

    case 'gemini':
      // Gemini: POST /v1beta/models/<model>:generateContent
      // com responseModalities: ["IMAGE"] no generationConfig
      // Response: inlineData.base64 (PNG) no candidates[0].content.parts
      return `${clean}/models`; // + /<model>:generateContent

    case 'pollinations':
      // Pollinations: GET https://image.pollinations.ai/prompt/<encoded_prompt>
      //   ?width=1024&height=1024&model=flux&nologo=true
      // Sem API key, sem POST — é só um GET que retorna a imagem PNG
      // Response: imagem PNG no body (não JSON)
      return clean; // a URL base já é o endpoint

    default: // ollama, custom
      return `${clean}/images/generations`; // assume OpenAI-compatível
  }
}
```

### Payload por formato

```typescript
export function buildImageGenPayload(
  server: ServerEntry,
  model: ModelEntry,
  prompt: string,
): Record<string, unknown> {
  switch (server.format) {
    case 'gemini':
      return {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      };

    case 'pollinations':
      // Pollinations não tem POST — é GET com query params
      // buildImageGenUrl já é a URL base, só append query
      return {}; // payload vazio — tudo na URL

    default: // openai, ollama, custom
      return {
        model: model.modelId,
        prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      };
  }
}
```

### Fluxo no Chat

Quando o usuário quer gerar uma imagem:

1. **Comando no chat:** usuário digita algo como `/imagine <prompt>` ou toca num botão de imagem
2. App identifica que `activeImageGenModelId` está setado
3. Resolve o `ModelEntry` → acha o `serverId` → acha o `ServerEntry`
4. Busca a API key (via KeyRotation se multi-key)
5. Chama `ImageGenService.generate(server, model, apiKey, prompt)`
6. Recebe a imagem (base64 ou URL)
7. Renderiza a imagem no chat como uma mensagem do assistant

### Integration no ChatScreen

```
┌───────────────────────────┐
│ 💬 [input bar normal]      │
│ 📎 🖥️ 🖼️ [botão imagem]    │  ← botão de gerar imagem (só aparece se activeImageGenModelId setado)
└───────────────────────────┘

Ao tocar 🖼️:
  ┌──────────────────────┐
  │ Gerar imagem         │
  │                      │
  │ [Prompt da imagem..] │
  │                      │
  │ Modelo: gemini-flash │  ← activeImageGenModelId
  │ Servidor: Google AI   │
  │                      │
  │ [    Gerar    ]      │
  └──────────────────────┘
```

### Servers que suportam Image Generation (free)

| Server | Format | Modelos | Free? |
|---|---|---|---|
| Google AI Studio | `gemini` | `gemini-3.1-flash-image`, `gemini-3-pro-image` | ✅ free tier |
| OpenRouter | `openai` | `flux`, `sdxl`, `gpt-image-2` (via /images/generations) | alguns `:free` |
| Pollinations | `pollinations` | `flux`, `turbo` (sem API key!) | ✅ gratuito |
| OpenAI | `openai` | `gpt-image-2` | ❌ pago (excluído por enquanto) |

**Pollinations** é especialmente interessante — não precisa de API key, é um GET simples que retorna PNG. Ideal para demo/onboarding de image gen sem cadastro.

---

## 6. Migration Strategy

Na primeira abertura após o update:

1. Verificar se `migrated === true` em settings_v2 → se sim, pular migration
2. Ler `@bemore_settings` do **AsyncStorage** (formato antigo legado)
3. Se existir `llm.baseUrl` não-vazio:
   - Criar um `ServerEntry` com:
     - `id`: novo UUID
     - `name`: derivado do hostname ou "Servidor migrado"
     - `baseUrl`: do `llm.baseUrl` antigo
     - `format`: detectar (`gemini` se googleapis, `ollama` se localhost, senão `openai`)
     - `icon`: matching preset ou `'dns'`
     - `apiKeyCount`: 1, `keyRotation`: `'single'`, `activeKeyIndex`: 0
   - Migrar a apiKey do Keychain legado (`bemore-apikey-<hostname>`) → `bemore-apikey-<newServerId>-0`
   - Criar um `ModelEntry` com o `llm.model` antigo (único modelo, favorito)
   - Setar `activeServerId` e `activeModelId` para os novos IDs
4. Se `sttServerOverride` não-vazio → criar outro `ServerEntry` para STT, setar `sttServerId`
5. Mesmo para `ttsServerOverride` → `ttsServerId`
6. Migrar `systemPrompt`, `theme`, `sttMode`, `sttModelPath`, `ttsVoice`, `ttsAutoPlay`, `streamingEnabled`
7. Setar `migrated: true`
8. Salvar tudo em MMKV (settings_v2 + servers + models)
9. **NÃO** limpar AsyncStorage ainda — manter como backup por 1 versão

---

## 7. Módulos de Código (estrutura proposta)

```
src/
  data/
    appSettings.ts         → MIGRATION + compat layer (lê legado, escreve V2 em MMKV)
    serverDb.ts            → CRUD de ServerEntry (MMKV)
    modelDb.ts             → CRUD de ModelEntry (MMKV)
    keychainDb.ts           → Multi-key CRUD no Keychain (substitui appSettings.ts atual)
  services/
    ServerService.ts       → fetchModels(server), buildChatUrl(server), buildAuthHeaders(server),
                              buildImageGenUrl(server), buildImageGenPayload(server, model, prompt)
    KeyRotation.ts         → Lógica de rotação/failover de API keys
    LlmService.ts          → refactor: recebe ServerEntry + ModelEntry + apiKey em vez de LlmConfig
    ImageGenService.ts     → NOVO — generateImage(server, model, apiKey, prompt) → base64 | URL
    SttService.ts          → existe
    SttOnlineService.ts    → ajusta para ServerEntry/ModelEntry
    TtsService.ts          → ajusta para ServerEntry/ModelEntry
  screens/
    ChatScreen.tsx         → header com botão de modelo → ModelPickerModal
    SettingsScreen.tsx     → seção "Servidores" substitui card "Modelo de Linguagem"
    OnboardingScreen.tsx   → NOVO — primeira abertura
    ServerEditorScreen.tsx → NOVO — editar servidor + multi-key
    ModelPickerModal.tsx   → NOVO — lista de modelos agrupada por servidor
  types/
    index.ts               → ServerEntry, ModelEntry, AppSettingsV2, ServerFormat, KeyRotationStrategy
  utils/
    modelCapabilities.ts   → badge detection (já existe, reutilizado no fetch)
    modelName.ts           → shortModelName (já existe)
    theme.ts               → (já existe)
```

### 7.1 serverDb.ts (esboço)

```typescript
import { MMKV } from 'react-native-mmkv';
import { ServerEntry } from '../types';

const storage = new MMKV();
const SERVERS_KEY = '@bemore_servers';

export function getAllServers(): ServerEntry[] {
  const raw = storage.getString(SERVERS_KEY);
  return raw ? JSON.parse(raw) : [];
}

export function getServer(id: string): ServerEntry | null {
  return getAllServers().find(s => s.id === id) ?? null;
}

export function saveServer(server: ServerEntry): void {
  const servers = getAllServers();
  const idx = servers.findIndex(s => s.id === server.id);
  const updated = {...server, updatedAt: Date.now()};
  if (idx >= 0) servers[idx] = updated;
  else servers.push(updated);
  storage.set(SERVERS_KEY, JSON.stringify(servers));
}

export function deleteServer(id: string): void {
  // Cascade: deleta todos os ModelEntry com serverId === id
  deleteModelsByServer(id);
  // Deleta TODAS as API keys do Keychain para este servidor
  const server = getServer(id);
  if (server) {
    for (let i = 0; i < server.apiKeyCount; i++) {
      resetApiKey(id, i);
    }
  }
  // Remove da lista
  const servers = getAllServers().filter(s => s.id !== id);
  storage.set(SERVERS_KEY, JSON.stringify(servers));
}
```

### 7.2 keychainDb.ts (multi-key)

```typescript
import * as Keychain from 'react-native-keychain';
import { serverKey } from '../data/appSettings'; // reutiliza ou refatora

const KEY_PREFIX = 'bemore-apikey-';

export async function loadApiKey(serverId: string, keyIndex: number): Promise<string> {
  try {
    const key = `${KEY_PREFIX}${serverId}-${keyIndex}`;
    const creds = await Keychain.getInternetCredentials(key);
    return creds?.password ?? '';
  } catch { return ''; }
}

export async function saveApiKey(serverId: string, keyIndex: number, apiKey: string): Promise<void> {
  if (!apiKey) { await resetApiKey(serverId, keyIndex); return; }
  const key = `${KEY_PREFIX}${serverId}-${keyIndex}`;
  await Keychain.setInternetCredentials(key, 'apiKey', apiKey);
}

export async function resetApiKey(serverId: string, keyIndex: number): Promise<void> {
  try {
    await Keychain.resetInternetCredentials({server: `${KEY_PREFIX}${serverId}-${keyIndex}`});
  } catch { /* no-op */ }
}
```

### 7.3 KeyRotation.ts

```typescript
import { ServerEntry } from '../types';
import { loadApiKey } from './keychainDb';
import { saveServer } from './serverDb';

const exhaustedKeys = new Map<string, number>();

export async function getKeyForRequest(server: ServerEntry): Promise<string> {
  switch (server.keyRotation) {
    case 'single':
      return loadApiKey(server.id, server.activeKeyIndex);

    case 'round-robin': {
      const next = (server.activeKeyIndex + 1) % server.apiKeyCount;
      saveServer({...server, activeKeyIndex: next});
      return loadApiKey(server.id, next);
    }

    case 'failover': {
      // Procura primeira key não-exhausted a partir do índice ativo
      for (let i = 0; i < server.apiKeyCount; i++) {
        const idx = (server.activeKeyIndex + i) % server.apiKeyCount;
        if (!isKeyExhausted(server.id, idx)) {
          if (idx !== server.activeKeyIndex) {
            saveServer({...server, activeKeyIndex: idx});
          }
          return loadApiKey(server.id, idx);
        }
      }
      throw new Error('Todas as API keys deste servidor estão em cooldown (rate limit).');
    }
  }
}

export function isKeyExhausted(serverId: string, keyIndex: number): boolean {
  const key = `${serverId}-${keyIndex}`;
  const at = exhaustedKeys.get(key);
  if (!at) return false;
  if (Date.now() - at > 60_000) { exhaustedKeys.delete(key); return false; }
  return true;
}

export function markKeyExhausted(serverId: string, keyIndex: number): void {
  exhaustedKeys.set(`${serverId}-${keyIndex}`, Date.now());
}
```

### 7.4 ServerService.ts

```typescript
import { ServerEntry } from '../types';

export function buildModelsUrl(server: ServerEntry): { url: string; useHeader: boolean } {
  const clean = server.baseUrl.replace(/\/+$/, '');
  switch (server.format) {
    case 'gemini':
      return { url: `${clean}/models`, useHeader: true };
    // OpenRouter tem endpoint público mas com auth retorna pricing info
    default:
      return { url: `${clean}/models`, useHeader: false };
  }
}

export function buildChatUrl(server: ServerEntry): string {
  const clean = server.baseUrl.replace(/\/+$/, '');
  if (server.format === 'gemini') return `${clean}/openai/chat/completions`;
  return `${clean}/chat/completions`;
}

export function buildAuthHeaders(server: ServerEntry, apiKey: string): Record<string, string> {
  if (!apiKey) return {};
  if (server.format === 'gemini') return { 'x-goog-api-key': apiKey }; // FIX: header em vez de query param
  return { 'Authorization': `Bearer ${apiKey}` };
}

export function getReasoningFormat(server: ServerEntry): string | null {
  if (server.format === 'ollama' || isLocalServer(server.baseUrl)) return null;
  if (server.format === 'gemini') return null;
  const url = server.baseUrl.toLowerCase();
  if (url.includes('groq.com') || url.includes('openrouter.ai') || url.includes('nvidia.com')) {
    return 'parsed';
  }
  return null;
}

export async function fetchModels(server: ServerEntry, apiKey: string): Promise<string[]> {
  const { url, useHeader } = buildModelsUrl(server);
  const headers: Record<string, string> = {};
  if (useHeader && apiKey) headers['x-goog-api-key'] = apiKey;
  else if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const models = data?.data ?? data?.models ?? [];
  return models
    .map((m: any) => (m.id ?? m.name ?? '').replace(/^models\//, ''))
    .filter((s: string) => s.length > 0)
    .sort((a: string, b: string) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
}
```

---

## 8. Security Fixes

### 8.1 Gemini API Key — header em vez de query param

**Problema atual:** `?key=...` na URL — API key vaza em logs, crash reports, histórico.

**Fix:** Gemini suporta header `x-goog-api-key: <key>`. Usar sempre o header,
nunca a query param. Implementado em `buildAuthHeaders()` e `fetchModels()`.

### 8.2 Validação de URL no cadastro

```typescript
export function validateServerUrl(url: string): { valid: boolean; error?: string } {
  if (!url?.trim()) return { valid: false, error: 'URL vazia' };
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Protocolo deve ser http ou https' };
    }
    if (parsed.protocol === 'http:' && !isLocalAddress(parsed.hostname)) {
      return { valid: false, error: 'HTTP so permitido para servidores locais. Use HTTPS.' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'URL inválida' };
  }
}

function isLocalAddress(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)
  );
}
```

### 8.3 Network Security Config — adicionar ollama.com

Adicionar `<domain includeSubdomains="true">ollama.com</domain>` ao
`network_security_config.xml` (forçar HTTPS para Ollama Cloud).

E adicionar os novos provedores que têm HTTPS obrigatório:
- `cerebras.ai`
- `sambanova.ai`
- `huggingface.co`

### 8.4 API keys TextArea — mascarar sempre

No `ServerEditorScreen`, as keys são exibidas como `●●●●●●●●` (nunca plaintext).
Botão违法违规 "mostrar" opcional (toggle `secureTextEntry`), mas default é oculto.

---

## 9. Novas Dependências

```
npm install react-native-mmkv react-native-get-random-values
```

- `react-native-mmkv`: storage síncrono para settings + servers + models
- `react-native-get-random-values`: polyfill para `crypto.randomUUID()` no RN

Não precisa de SQLite, WatermelonDB, ou Realm para este escopo.

---

## 10. Ordem de Implementação (phases)

### Phase 1 — Foundation (sem mudanças visíveis)
1. Instalar `react-native-mmkv` + `react-native-get-random-values`
2. Criar `src/data/serverDb.ts`, `src/data/modelDb.ts`, `src/data/keychainDb.ts`
3. Criar `src/services/ServerService.ts` (consolida lógica de URL/auth)
4. Criar `src/services/KeyRotation.ts`
5. Criar migration em `appSettings.ts` (legado AsyncStorage → MMKV V2)
6. Test: migration funciona, CRUD de servers/models funciona, multi-key funciona

### Phase 2 — UI: Onboarding
7. Criar `OnboardingScreen.tsx`
8. App.tsx: se `!settings.migrated` ou sem servers → OnboardingScreen
9. Onboarding: grid de presets → cadastro → fetch modelos → favoritos → concluir

### Phase 3 — UI: Model Picker no Chat
10. Criar `ModelPickerModal.tsx` (lista agrupada por servidor, filtros, ações)
11. ChatScreen: botão no header abre ModelPickerModal
12. Trocar modelo = trocar activeModelId em settings
13. Badge offline no modelo ativo (quando XHR falha)

### Phase 4 — UI: Settings Redesign
14. SettingsScreen: novo card "Servidores" (lista + adicionar)
15. Criar `ServerEditorScreen.tsx` (editar server, multi-key, re-fetch, deletar)
16. Remover card "Modelo de Linguagem" antigo
17. STT/TTS settings: selecionar de lista de servers/models cadastrados

### Phase 5 — Refactor dos Services
18. LlmService: recebe `ServerEntry + apiKey + modelId` em vez de `LlmConfig`
19. Integrar KeyRotation no LlmService (failover automático em 429/401)
20. SttOnlineService: mesmo refactor
21. TtsService: mesmo refactor
22. Remover `LlmConfig` do types/index.ts (deprecated → removido)

### Phase 6 — Security Fixes
23. Gemini: header `x-goog-api-key` em vez de query param
24. Validação de URL no cadastro
25. Atualizar `network_security_config.xml` com novos domínios

### Phase 7 — Polish
26. Filtros no ModelPickerModal (Favoritos / Free / Visão / STT / TTS)
27. Editar badges manualmente (corrigir auto-detecção)
28. Indicador visual de servidor ativo no chat header
29. Indicador de keys em cooldown (failover)
30. Empty states (sem servers, sem models, sem favoritos)

---

## 11. Decisões Futuras (não bloqueantes)

- **Chats persistidos:** Salvar histórico de conversas no MMKV ou SQLite? (futuro)
- **Sync entre dispositivos:** Export/import de configuração via JSON? (futuro)
- **Compartilhar servidores:** QR code ou link compartilhável? (futuro)
- **Custom paths para formato 'custom':** Hoje usa paths OpenAI padrão. Se precisar
  de paths diferentes (ex: Azure OpenAI tem URLs diferentes), adicionar campos
  `chatPath` e `modelsPath` no `ServerEntry`. (futuro, se需求 surgir)
