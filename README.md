# Be More Companion

**Um assistente pessoal privacy-first para Android.**
Converse com modelos de linguagem *no próprio aparelho* (GGUF) ou conecte a servidores locais e APIs compatíveis com OpenAI — você escolhe.

Inspirado em projetos como [PocketPal AI](https://github.com/a-ghorbani/pocketpal-ai) (privacidade + inferência on-device) e [Oxproxion](https://github.com/stardomains3/oxproxion) (multi-provider, personas, visão), o Be More Companion nasce como um projeto pessoal, **não comercial**, código aberto no GitHub — sem conta, sem telemetria, sem Play Store.

---

## Por que mais um app de IA?

A maioria dos apps de IA é uma casca fina sobre o servidor de outra pessoa: cada mensagem sai do seu aparelho, é logada e analisada em algum lugar você não vê. O Be More Companion inverte isso — o **modelo vive no seu telefone**, e suas conversas não saem dele.

- **🔒 Privado por padrão** — prompts, respostas, áudio e histórico ficam no dispositivo. Nada é enviado a não ser que você explicitamente escolha um provider em nuvem.
- **✈️ Funciona offline** — baixe um modelo GGUF uma vez e conversa de verdade, sem conexão, sem conta.
- **🔌 Híbrido quando precisar** — mesma tela permite apontar para Ollama/LM Studio/llama.cpp server na sua LAN, ou qualquer API OpenAI-compatible (OpenAI, OpenRouter, Groq, etc.).
- **🆓 Livre e open source** — sem assinatura, sem "pro tier". MIT-licensed, sempre.

> **Nota de privacidade:** quando você configura um provider externo, apenas o que você digita *naquela conversa* trafega para ele. A configuração do seu escolha e seus históricos nunca saem do aparelho.

---

## Estado atual do projeto

🟡 **Pré-alfa — chat funcional com servidores externos.** O app já conversa de verdade quando você aponta pra um backend na sua LAN (Ollama, LM Studio, llama.cpp server) ou qualquer API OpenAI-compatible. O modo local (GGUF on-device) ainda é stub.

### O que funciona hoje

- **Tela de chat** escura, com histórico **que persiste entre trocas de aba** (estado lifted up no `App.tsx`) — virar pra Settings e voltar não destroi mais a conversa.
- **LlmService** que faz POST `/v1/chat/completions` em qualquer endpoint OpenAI-compatible. Validado pelo usuário com Ollama e servidor externo.
- **Tela de configurações** persistida em AsyncStorage (`@bemore_settings`):
  - tipo de provider (localhost vs. local), URL do servidor, API key, nome do modelo, system prompt
  - **botão "Buscar modelos"** que faz `GET {baseUrl}/models` e abre um modal pra escolher — em vez de digitar o nome à mão
  -campo "caminho do modelo Whisper" para STT on-device (vazio = STT desabilitado)
- **Ícones MD3** via `@react-native-vector-icons/material-icons` v13.1.2 (Material Icons genuíno do Google, não mais a versão legacy).
- **Header do chat** mostra só o nome curto do modelo (basename do `id` completo que o servidor retorna — ex: `llama3.2:3b` em vez de `/home/user/.../llama3.2:3b`).
- **Microfone defensivo**: checa se o modelo STT está configurado **antes** de iniciar a gravação — sem modelo, mostra Alert em vez de aparentemente travar. O módulo nativo Kotlin também verifica permissão `RECORD_AUDIO` em runtime antes de instanciar `AudioRecord` (não confia só no check do JS).
- **Módulo nativo `PcmRecorder`** (Kotlin) que grava áudio via `AudioRecord` (16 kHz, mono, PCM 16-bit) e salva `.wav` com header RIFF/WAVE de 44 bytes válido — pronto para alimentar um STT quando integrado.
- **CI verde**: workflow em GitHub Actions com Node 24 + actions v5, rodando `npm install` → `tsc --noEmit` → `react-native bundle` → `gradlew assembleDebug` → upload do APK como artifact.

### O que está no código mas **não funcional**

- `fetchLocalModel` em `LlmService.ts` é um stub que só lança `"Local model ainda não implementado"` — aguardando reintrodução do `llama.rn`.
- `DownloadScreen.tsx` existe como placeholder mas não é alcançável por nenhuma rota (o `App.tsx` só navega chat ⇄ settings).
- `SttService.ts` + hook `useWhisper` existem com lazy-load e mensagens amigáveis, mas `whisper.rn` foi removido do `package.json` no commit B#2 e ainda não foi reintroduzido — sem a lib o STT real não transcreve, só exibe a mensagem "defina o caminho do modelo Whisper".
- O README original listava `whisper.rn`, `llama.rn` e Fish Audio TTS como stack; essas libs foram removidas temporariamente e serão reintroduzidas quando houver UI e modelo real para usá-las.

### Stack técnica real hoje

- **React Native 0.76.7** (Old Arch ativa; a infraestrutura New Arch — `fabricEnabled`, `DefaultNewArchitectureEntryPoint` — já está plugada em `MainApplication.kt`, basta ligar `newArchEnabled=true` quando `llama.rn`/`sherpa-onnx-rn` estiverem prontos).
- **TypeScript** (strict mode) com `lib: ["es2022", "dom"]` (DOM p/ ter tipos de `fetch`, `Response`, `console`).
- **Hermes**, Android-only, AsyncStorage p/ settings, sem telemetria.
- **Ícones**: `@react-native-vector-icons/material-icons` v13.1.2 (import root, não `/static` — Metro 0.81 do RN 0.76 não resolve subpath exports; a lib bundla a fonte `.ttf` via task `copyFonts` no `android/build.gradle` do próprio pacote, linkado por autolink).
- **CI**: GitHub Actions (`.github/workflows/android-build.yml`) com Node 24 + actions v5 — typecheck → bundle → APK → artifact.

---

## Roadmap

Construção incremental. Sem promessa de datas — isto é projeto de fim de semana, não de startup.

### 🧱 Fase 1 — O essencial (em andamento)
Objetivo: **um app de chat funcional com STT interno e múltiplos backends de LLM.**

- [x] Conectar `PcmRecorderModule` ao JS via `NativeModules` e expor um `AudioService` — PR #5
- [x] `tsconfig` com `lib: ["es2022","dom"]` (DOM p/ `fetch`/`Response`/`console`) — PR #5
- [x] Validação de permissão runtime `RECORD_AUDIO` antes de instanciar `AudioRecord` (kotlin + JS) — PR #6
- [x] Tratamento de erro de rede sem poluir histórico (`isError` flag nas mensagens de erro) — PR #6
- [x] Ícones MD3 (`@react-native-vector-icons/material-icons` v13) + botão voltar em Settings + botão "Buscar modelos" — PR #6
- [x] Histórico de conversa persiste ao trocar de aba (lift state up no `App.tsx`) — PR #6
- [x] Microfone defensivo: checa modelo STT antes de gravar (em vez de "travar") — PR #6
- [x] CI completo: `tsc --noEmit` → `react-native bundle` → `gradlew assembleDebug` → upload APK artifact (Node 24 + actions v5) — PR #6
- [ ] Reintroduzir `whisper.rn` (ou candidato estável) para STT on-device — SttService já existe como wrap defensive, falta a lib
- [ ] Reintroduzir `llama.rn` e implementar `fetchLocalModel` (rodar modelos GGUF no aparelho)
- [ ] Tela **Models**: baixar GGUFs (Hugging Face ou URL direta), validar espaço, carregar/descarregar
- [ ] Roteabilidade real: React Navigation (Native Stack) liberando `DownloadScreen` e futuras telas
- [ ] Estado global com Zustand (a substituir `useState` espalhado)

### 🧠 Fase 2 — Talentos
Objetivo: dar memória e ferramentas ao companion, sem abrir mão da privacidade.

- [ ] **Memória persistente** entre sessões — resumo/recall sem vazar o histórico para o servidor
- [ ] **Busca na internet** opcional (opt-in explícito por mensagem, nunca automática)
- [ ] **TTS on-device** (candidatos: Piper, Coqui, sherpa-onnx TTS — sem nuvem por padrão)
- [ ] **Visão** — enviar imagens para modelos multimodais (Phi-Vision, Qwen-VL no GGUF, ou API externa)
- [ ] **Personas / system prompts** gerenciáveis como entidades separadas (inspirado em Oxproxion)
- [ ] Histórico de conversas armazenado localmente (MMKV para hot path, considere WatermelonDB se volume crescer)

### ✨ Fase 3 — Refino
- [ ] Hardware acceleration: OpenCL/Adreno para acceleração GPU no Android (se viável)
- [ ] Tools/function calling nativo (calculator, calendar, files — inspirado nos "Tools" do Oxproxion)
- [ ] Import/export de conversas em Markdown
- [ ] Migrar para New Architecture quando `llama.rn` / `sherpa-onnx-rn` estiverem prontos

---

## Visão final

Um companion de IA que cabe no seu bolso e respeita você. Por padrão tudo roda no aparelho — áudio, modelo, memória. Nada passa por servidores de terceiros sem que você explicitamente configure isso.

Quando você quiser usar a nuvem, está a um botão de distância (configuração única); quando estiver offline ou só não quiser compartilhar, está no modo privado sem nenhuma concessão.

Não é comercial, não tem anúncios, não coleta nada. É software livre que faz o que diz — e diz o que faz.

---

## Para desenvolvedores

### Pré-requisitos
- Node.js ≥ 18
- Android Studio + SDK + NDK
- React Native environment ([setup oficial](https://reactnative.dev/docs/set-up-your-environment))

### Clone e build
```bash
git clone https://github.com/taboia872/beMore-companion.git
cd beMore-companion
npm install
cd android && ./gradlew assembleDebug
```

### Scripts
| Comando | Ação |
|:--|:--|
| `npm start` | Inicia Metro bundler |
| `npm run android` | Builda e instala no device/emulador conectado |
| `npm run build:android` | Apenas `gradlew assembleDebug` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

### Estrutura atual
```
src/
├── App.tsx              # Root + state lift (messages persiste entre abas)
├── data/
│   └── appSettings.ts   # Persistência de config em AsyncStorage (@bemore_settings)
├── hooks/
│   ├── useRecorder.ts   # Wrapper sobre PcmRecorder nativo, pede permissão runtime
│   └── useWhisper.ts    # Lazy-load STT, mensagens amigáveis (defensive)
├── screens/
│   ├── ChatScreen.tsx       # Chat + header com nome curto do modelo + botões mic/send MD3
│   ├── DownloadScreen.tsx   # placeholder — a ser conectado via React Navigation
│   └── SettingsScreen.tsx   # Config + botão "Buscar modelos" + modal de seleção
├── services/
│   ├── AudioService.ts  # Ponte JS → NativeModules.PcmRecorder
│   ├── LlmService.ts    # OpenAI-compatible client (localhost mode funciona; local = stub)
│   └── SttService.ts    # Wrap whisper.rn (require() dinâmico — não quebra tsc sem a lib)
├── types/
│   ├── index.ts
│   └── react-native-vector-icons.d.ts   # module augmentation p/ import root dos ícones
└── utils/
    └── modelName.ts     # shortModelName — basename do id completo retornado pelo servidor

android/app/src/main/java/com/bemore/companion/
├── MainActivity.kt
├── MainApplication.kt
├── PcmRecorderModule.kt   # Áudio PCM → WAV, checa permissão runtime antes de AudioRecord
└── PcmRecorderPackage.kt

.github/workflows/
└── android-build.yml      # CI: typecheck → bundle → assembleDebug → upload APK (Node 24)
```

---

## Licença

MIT. Faça o que quiser, desde que mantenha os créditos. PRs welcome — mas lembre que isto é projeto pessoal, então nem toda contribuição será mergeada.

## Inspirado por
- [PocketPal AI](https://github.com/a-ghorbani/pocketpal-ai) — privacidade on-device em RN
- [Oxproxion](https://github.com/stardomains3/oxproxion) — multi-provider e UX em Kotlin nativo
