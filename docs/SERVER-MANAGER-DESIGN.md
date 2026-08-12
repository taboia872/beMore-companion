# Server Manager — Documento de Design

## Visão Geral

Substituir a configuração atual (um único `LlmConfig` hardcoded em `AppSettings`) por um **banco de dados interno** que cadastro servidores (endpoints + API keys + formato de comunicação) e um **catálogo persistente de modelos** buscados de cada servidor.

Objetivo: fluxo parecido com OpenRouter/9router — cadastrar servidores, fazer fetch dos modelos uma única vez,.persistir a lista, marcar favoritos, esconder os irrelevantes, corrigir badges manualmente, e selecionar modelos de servers diferentes sem precisar re-fetch.

---

## 1. Arquitetura de Dados

### 1.1 Tecnologia: MMKV + Keychain (sem SQLite)

Para app pessoal com ~2 tabelas e queries simples, SQLite é overkill. Escolha:

- **react-native-mmkv** para metadados de servers e models (JSON serializado, síncrono, ultra rápido)
- **react-native-keychain** (já em uso) para API keys — uma entrada por server, keyed por `server.id`

Notas:
- MMKV é síncrono (sem `await`), o que simplifica a UI — não precisa de loading states para ler config
- AsyncStorage permanece para `AppSettings` (theme, systemPrompt, streaming, STT/TTS config) — não precisa migrar tudo
- Se o projeto crescer (chats persistidos, histórico), aí sim migrar para op-sqlite

### 1.2 Schema

```typescript
// src/types/index.ts (extensão)

/**
 * Formato de comunicação do servidor.
 * - 'openai':    Bearer auth, /v1/chat/completions, /v1/models (padrão)
 * - 'gemini':    Query param ?key=, /v1beta/openai/chat/completions, /v1beta/models
 * - 'ollama':    Sem auth (localhost), /v1/chat/completions, /api/tags (ou /v1/models)
 * - 'custom':    Mesma estrutura OpenAI, mas o usuário define paths manualmente
 */
export type ServerFormat = 'openai' | 'gemini' | 'ollama' | 'custom';

/**
 * Um servidor cadastrado no app.
 */
export interface ServerEntry {
  id: string;           // UUID (crypto.randomUUID() ou react-native-get-random-values)
  name: string;         // Nome amigável ex: "Minha Ollama", "OpenRouter"
  baseUrl: string;      // URL base ex: "https://api.groq.com/openai/v1"
  format: ServerFormat; // Determina método de auth e paths
  icon?: string;        // Nome do ícone MaterialIcons (preset) ou undefined
  hasFreeModels?: boolean; // Hint para filtro (pode ser override manual)
  createdAt: number;    // Date.now()
  updatedAt: number;
  // NOTA: apiKey NÃO vive aqui — fica no Keychain, keyed por server.id
}

/**
 * Um modelo cadastrado (resultado de fetch de /models).
 */
export interface ModelEntry {
  id: string;           // UUID do registro
  serverId: string;     // FK → ServerEntry.id
  modelId: string;      // ID retornado pela API ex: "llama3", "gpt-4o"
  displayName?: string;  // Override editável pelo usuário (se vazio, usa modelId)
  // Badges/capabilities — auto-detectadas no fetch, editáveis manualmente
  isVision?: boolean;
  isStt?: boolean;
  isTts?: boolean;
  isAnyToAny?: boolean;
  isFree?: boolean;     // Override manual se a auto-detecção errou
  // Organização do usuário
  isFavorite: boolean;  // Aparece em lista de favoritos
  isHidden: boolean;    // Removido das listas mas não deletado (soft delete)
  // Metadata de fetch
  lastFetchedAt: number; // Date.now() do último /models fetch
}

/**
 * Settings que referenciam servers/models por ID.
 * Substitui o LlmConfig solteiro atual.
 */
export interface AppSettingsV2 {
  // Referências ao servidor/modelo ativos
  activeServerId: string | null;
  activeModelId: string | null;    // FK → ModelEntry.id
  activeSttModelId: string | null;  // FK → ModelEntry.id (override de STT)
  activeTtsModelId: string | null;  // FK → ModelEntry.id (override de TTS)
  // Servidores override para STT/TTS (opcional — null = usa activeServer)
  sttServerId?: string | null;
  ttsServerId?: string | null;
  // Tudo mais permanece igual
  systemPrompt: string;
  theme: 'dark' | 'light';
  sttMode: 'on-device' | 'online';
  sttModelPath?: string;
  ttsVoice?: string;
  ttsAutoPlay?: boolean;
  streamingEnabled?: boolean;
}
```

### 1.3 Storage Layout

```
MMKV\Storage:
  @bemore_servers      → JSON: ServerEntry[]
  @bemore_models       → JSON: ModelEntry[]
  @bemore_settings_v2  → JSON: AppSettingsV2

Keychain (Keystore Android):
  bemore-apikey-<serverId>  → apiKey daquele servidor

AsyncStorage (legado — migrado):
  @bemore_settings  → migrado para @bemore_settings_v2
```

### 1.4 Migration Strategy

Na primeira abertura após o update:

1. Ler `@bemore_settings` (AsyncStorage, formato antigo)
2. Se existir `llm.baseUrl` não-vazio:
   - Criar um `ServerEntry` com a URL/provider antigos
   - Migrar a apiKey do Keychain legado (`bemore-apikey-<hostname>` → `bemore-apikey-<newServerId>`)
   - Criar um `ModelEntry` com o `llm.model` antigo
   - Setar `activeServerId` e `activeModelId` para os novos IDs
3. Se NÃO houver settings antigos → fluxo de onboarding (primeira abertura)
4. Marcar migration como completa (flag em settings_v2)

---

## 2. Fluxos de Telas

### 2.1 Onboarding (primeira abertura)

```
┌─────────────────────────┐
│   Bem-vindo ao BeMore   │
│                         │
│   ████ (logo/icone)      │
│                         │
│  Como irá se conectar?  │
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
1. Mostrar lista de presets (OpenRouter, Groq, Gemini, NVIDIA, AIHorde...) + "Personalizado"
2. Usuário seleciona preset OU digita URL
3. Campo de API key aparece
4. Botão "Buscar modelos" → fetch `/models`
5. Modelos aparecem em lista → usuário marca favoritos
6. "Concluir" → salva server + models + seta active

**Se "Servidor Local":**
1. Campo de URL (default: `http://localhost:11434/v1`)
2. Sem API key (Ollama local não precisa)
3. Botão "Buscar modelos" → fetch `/v1/models` (ou `/api/tags`)
4. Modelos aparecem → marca favoritos
5. "Concluir"

### 2.2 Tela de Seleção de Modelo (no chat)

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
- Ordenação agrupada por servidor (como OpenRouter), não lista plana

Ações por modelo (swipe ou menu de 3 pontos):
- ⭐ Favoritar/Desfavoritar
- 👁 Mostrar/Ocultar (hidden)
- ✏️ Editar badges (corrigir visão/STT/TTS/free)
- 🗑 Deletar (remove do catálogo — re-fetch traz de volta)
- 🔄 Re-fetch deste servidor (atualiza lista de modelos do server)

### 2.3 Tela de Settings — Seção "Servidores"

```
┌─────────────────────────────┐
│  Configurações              │
│                             │
│  ┌─ Servidores ───────────┐ │
│  │ Eis: 2 servidores      │ │
│  │                        │ │
│  │ ● Minha Ollama     ⚙  │ │  ← tocar abre edição
│  │   localhost:11434      │ │
│  │   3 modelos (1⭐ 1✗)   │ │
│  │                        │ │
│  │ ● OpenRouter       ⚙  │ │
│  │   openrouter.ai       │ │
│  │   47 modelos (3⭐)     │ │
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
│  API Key: [********      ]  │
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

## 3. Módulos de Código (estrutura proposta)

```
src/
  data/
    appSettings.ts        → migration + compat layer (legado)
    serverDb.ts           → CRUD de ServerEntry (MMKV)
    modelDb.ts            → CRUD de ModelEntry (MMKV)
    serverKeychain.ts     → API keys per-server (Keychain, migra do appSettings.ts atual)
  services/
    ServerService.ts     → fetchModels(server), buildChatUrl(server), getReasoningFormat(server)
    LlmService.ts         → refactor: recebe ServerEntry + ModelEntry em vez de LlmConfig
    SttService.ts         →_EXISTE
    SttOnlineService.ts   → ajusta para usar ServerEntry/ModelEntry
    TtsService.ts         → ajusta para usar ServerEntry/ModelEntry
  screens/
    ChatScreen.tsx        → header tem botão de modelo que abre ModelPickerModal
    SettingsScreen.tsx    → seção "Servidores" substitui card "Modelo de Linguagem"
    OnboardingScreen.tsx  → NOVO — primeira abertura
    ServerEditorScreen.tsx → NOVO — editar um servidor
    ModelPickerModal.tsx  → NOVO — lista de modelos agrupada por servidor
  types/
    index.ts              → extendido com ServerEntry, ModelEntry, AppSettingsV2
```

### 3.1 serverDb.ts (pseudo-código)

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
  if (idx >= 0) servers[idx] = server;
  else servers.push(server);
  storage.set(SERVERS_KEY, JSON.stringify(servers));
}

export function deleteServer(id: string): void {
  // Cascade: deleta todos os ModelEntry com serverId === id
  deleteModelsByServer(id);
  // Deleta a API key do Keychain
  resetApiKeyForServer(id);
  // Remove da lista
  const servers = getAllServers().filter(s => s.id !== id);
  storage.set(SERVERS_KEY, JSON.stringify(servers));
}
```

### 3.2 modelDb.ts (pseudo-código)

```typescript
const MODELS_KEY = '@bemore_models';

export function getAllModels(): ModelEntry[] {
  const raw = storage.getString(MODELS_KEY);
  return raw ? JSON.parse(raw) : [];
}

export function getModelsByServer(serverId: string): ModelEntry[] {
  return getAllModels().filter(m => m.serverId === serverId);
}

export function getVisibleModels(): ModelEntry[] {
  return getAllModels().filter(m => !m.isHidden);
}

export function getFavoriteModels(): ModelEntry[] {
  return getAllModels().filter(m => m.isFavorite && !m.isHidden);
}

export function saveModel(model: ModelEntry): void { /* upsert */ }
export function deleteModel(id: string): void { /* remove */ }

/**
 * Recebe lista de modelIds do fetch e sincroniza com o catálogo:
 * - Novos modelIds → cria ModelEntry com badges auto-detectadas
 * - Existentes → atualiza lastFetchedAt
 * - modelIds que sumiram da API → marca isHidden (não deleta)
 */
export function syncModelsFromFetch(serverId: string, fetchedIds: string[]): void {
  const existing = getModelsByServer(serverId);
  const existingIds = new Set(existing.map(m => m.modelId));
  const fetchedSet = new Set(fetchedIds);

  // Novos: cria entries
  for (const id of fetchedIds) {
    if (!existingIds.has(id)) {
      const entry: ModelEntry = {
        id: uuid(),
        serverId,
        modelId: id,
        isFavorite: false,
        isHidden: false,
        isVision: detectVision(id),
        isStt: detectStt(id),
        isTts: detectTts(id),
        isAnyToAny: detectAnyToAny(id),
        lastFetchedAt: Date.now(),
      };
      saveModel(entry);
    }
  }

  // Sumiram: marca hidden
  for (const m of existing) {
    if (!fetchedSet.has(m.modelId) && !m.isHidden) {
      m.isHidden = true;
      saveModel(m);
    }
  }

  // Existentes: atualiza timestamp
  for (const m of existing) {
    if (fetchedSet.has(m.modelId)) {
      m.lastFetchedAt = Date.now();
      saveModel(m);
    }
  }
}
```

### 3.3 ServerService.ts (consolida lógica de formato)

```typescript
import { ServerEntry, ServerFormat } from '../types';

export function buildModelsUrl(server: ServerEntry): { url: string; useQueryParamKey: boolean } {
  const clean = server.baseUrl.replace(/\/+$/, '');
  switch (server.format) {
    case 'gemini':
      return { url: `${clean}/models`, useQueryParamKey: true };
    case 'openrouter':
      return { url: 'https://openrouter.ai/api/v1/models', useQueryParamKey: false };
    case 'ollama':
      // Ollama suporta /v1/models (OpenAI-compat) e /api/tags (nativo)
      return { url: `${clean}/models`, useQueryParamKey: false };
    default: // openai, custom
      return { url: `${clean}/models`, useQueryParamKey: false };
  }
}

export function buildChatUrl(server: ServerEntry): string {
  const clean = server.baseUrl.replace(/\/+$/, '');
  if (server.format === 'gemini') {
    return `${clean}/openai/chat/completions`;
  }
  return `${clean}/chat/completions`;
}

export function buildAuthHeaders(server: ServerEntry, apiKey: string): Record<string, string> {
  if (server.format === 'gemini') return {}; // Gemini usa ?key= na URL
  if (!apiKey) return {};
  return { 'Authorization': `Bearer ${apiKey}` };
}

export function getReasoningFormat(server: ServerEntry): string | null {
  // Lógica que hoje está em LlmService.getReasoningFormat()
  // mas baseada em ServerEntry em vez de string URL
  if (server.format === 'ollama' || isLocalServer(server.baseUrl)) return null;
  if (server.format === 'gemini') return null;
  const url = server.baseUrl.toLowerCase();
  if (url.includes('groq.com') || url.includes('openrouter.ai') || url.includes('nvidia.com')) {
    return 'parsed';
  }
  return null;
}

export async function fetchModels(server: ServerEntry, apiKey: string): Promise<string[]> {
  const { url, useQueryParamKey } = buildModelsUrl(server);
  let finalUrl = url;
  const headers: Record<string, string> = {};
  if (!useQueryParamKey && apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  if (useQueryParamKey && apiKey) {
    finalUrl = `${url}?key=${encodeURIComponent(apiKey)}`;
  }
  const res = await fetch(finalUrl, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const models = data?.data ?? data?.models ?? [];
  return models
    .map((m: any) => (m.id ?? m.name ?? '').replace(/^models\//, ''))
    .filter((s: string) => s.length > 0)
    .sort((a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
```

---

## 4. Mudanças no LlmService

O `streamResponse()` e `fetchBatch()` hoje recebem `LlmConfig` (baseUrl, apiKey, model, provider). Com o Server Manager, passam a receber:

```typescript
interface LlmRequest {
  server: ServerEntry;  // baseUrl, format
  apiKey: string;       // lida do Keychain pelo chamador
  modelId: string;       // model.modelId do ModelEntry ativo
}
```

A função `buildChatUrl()` e `getReasoningFormat()` migram de `LlmService` para `ServerService`.

O `sanitizeContext()` e `createThinkingParser()` não mudam — são independentes do servidor.

---

## 5. Fix de Segurança: Gemini API Key na URL

**Problema atual:** API key do Gemini vai na URL como query param (`?key=...`).

**Fix:** O Gemini também aceita header `x-goog-api-key: <key>`. Mudar `buildModelsUrl` e `buildChatUrl` para usar o header em vez de query param:

```typescript
if (server.format === 'gemini' && apiKey) {
  headers['x-goog-api-key'] = apiKey;
  // NÃO colocar ?key= na URL
}
```

Isso evita que a API key apareça em logs de rede, URLs de crash reports, etc.

---

## 6. Fix de Segurança: Validação de URL

Adicionar validação no cadastro de servidor:

```typescript
export function validateServerUrl(url: string): { valid: boolean; error?: string } {
  if (!url?.trim()) return { valid: false, error: 'URL vazia' };
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Protocolo deve ser http ou https' };
    }
    if (parsed.protocol === 'http:' && !isLocalAddress(parsed.hostname)) {
      return { valid: false, error: 'HTTP só permitido para servidores locais (localhost/LAN). Use HTTPS.' };
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

---

## 7. Network Security Config — Atualização

O `network_security_config.xml` atual lista domínios hardcoded. Com o Server Manager, usuários podem cadastrar servidores em domínios não listados. Opções:

**A) Adicionar `ollama.com` à lista de cleartext-proibido** (já que Ollama Cloud HTTPS):
```xml
<domain includeSubdomains="true">ollama.com</domain>
```

**B) Manter abordagem atual** — o usuário pode cadastrar qualquer URL HTTPS, e o cleartext só é permitido porque o base-config permite tudo. O filtro de validação de URL (item 6) já bloqueia HTTP não-local no nível do app.

Recomendo **A+B**: adicionar ollama.com ao XML + manter validação no app.

---

## 8. Novas Dependências

```
npm install react-native-mmkv react-native-get-random-values
```

- `react-native-mmkv`: storage síncrono para servers/models
- `react-native-get-random-values`: polyfill para `crypto.randomUUID()` no RN

Não precisa de SQLite, WatermelonDB, ou Realm para este escopo.

---

## 9. Ordem de Implementação (phases)

### Phase 1 — Foundation (sem mudanças visíveis)
1. Instalar `react-native-mmkv` + `react-native-get-random-values`
2. Criar `src/data/serverDb.ts`, `src/data/modelDb.ts`, `src/data/serverKeychain.ts`
3. Criar `src/services/ServerService.ts` (consolida lógica de URL/auth)
4. Criar migration em `appSettings.ts` (legado → V2)
5. Tests: migration funciona, CRUD de servers/models funciona

### Phase 2 — UI: Onboarding
6. Criar `OnboardingScreen.tsx`
7. App.tsx: se não há servers → mostra OnboardingScreen, senão ChatScreen
8. Onboarding cadastra primeiro servidor + fetch modelos + marca favoritos

### Phase 3 — UI: Model Picker no Chat
9. Criar `ModelPickerModal.tsx` (lista agrupada por servidor, filtros, swipe actions)
10. ChatScreen: botão no header abre ModelPickerModal
11. Trocar modelo = trocar activeModelId em settings

### Phase 4 — UI: Settings Redesign
12. SettingsScreen: novo card "Servidores" (lista de servers + adicionar)
13. Criar `ServerEditorScreen.tsx` (editar server, ver/editar models, re-fetch, deletar)
14. Remover o card "Modelo de Linguagem" antigo

### Phase 5 — Refactor dos Services
15. LlmService: recebe `LlmRequest` (server + apiKey + modelId) em vez de `LlmConfig`
16. SttOnlineService: mesmo refactor
17. TtsService: mesmo refactor
18. Remover `LlmConfig` do types/index.ts (ou marcar como deprecated)

### Phase 6 — Security Fixes
19. Gemini: header `x-goog-api-key` em vez de query param
20. Validação de URL no cadastro
21. Adicionar `ollama.com` ao network_security_config.xml

### Phase 7 — Polish
22. Filtros no ModelPickerModal (Favoritos / Free / Visão / STT / TTS)
23. Editar badges manualmente (corrigir auto-detecção)
24. Indicador visual de servidor ativo no chat header
25. Empty states (sem servers, sem models, sem favoritos)

---

## 10. Decões Pendentes (para revisar amanhã)

1. **UUID vs incremental ID?** Recomendo UUID (`crypto.randomUUID()`) — sem risco de colisão, simples.

2. **MMKV vs AsyncStorage para settings?** Recomendo migrar tudo para MMKV (settings + servers + models) e abandonar AsyncStorage. Mas isso é uma mudança maior — pode ser Phase 8 (cleanup).

3. **Manter presets hardcoded?** Sim, mas como sugestões no onboarding (não como lista fechada). O usuário pode cadastrar qualquer URL.

4. **O que acontece com STT/TTS server override?** Hoje é `sttServerOverride: string` (URL). Mudar para `sttServerId: string | null` (FK para ServerEntry). Mais limpo.

5. **Deletar servidor: o que acontece com modelos?** Cascade delete dos ModelEntry + reset da API key. Não pode deletar o servidor ativo sem primeiro trocar para outro (ou voltar para onboarding).

6. **Model ainda visível mas servidor offline?** Mostrar badge "offline" no ModelPickerModal. O usuário tenta usar → erro de rede (já tratado pelo LlmService).

7. **Limite de servidores?** Sem limite — app pessoal. Mas na prática 3-5 servidores é o esperado.

8. **Buscar modelos: re-fetch automático vs manual?** Recomendo MANUAL (botão 🔄). Auto-fetch a cada abertura seria lento e gastaria quota. O catálogo persiste — o usuário só re-fetch quando quer atualizar.

---

## 11. Estado Atual desta Branch

- ✅ Merge de `feature/chat-streaming-thinking-ui` → `main` (42 commits)
- ✅ Branch `feature/server-manager` criada a partir do main
- 📄 Este documento de design

Próximo passo: implementar Phase 1 (foundation — DB modules) a partir deste documento, após revisão do Juliano.
