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

🔴 **Pré-alfa — scaffold em construção.** Ainda não serve para uso diário.

O que já existe e funciona:
- **Tela de chat** escura e simples, com histórico em memória da sessão.
- **LlmService** que conversa com qualquer endpoint OpenAI-compatible (`/v1/chat/completions`) — testado com Ollama e LM Studio.
- **Tela de configurações** persistida em AsyncStorage: tipo de provider (localhost vs. local), URL do servidor, API key, nome do modelo, system prompt.
- **Módulo nativo `PcmRecorder`** (Kotlin) que grava áudio via `AudioRecord` e salva `.wav` com header RIFF válido — pronto para alimentar um STT, **mas ainda desconectado** da UI.

O que está no código mas **não funcional**:
- `fetchLocalModel` é um stub que só lança `"Local model ainda não implementado"`.
- `DownloadScreen` existe como placeholder mas não é alcançável por nenhuma rota.
- O README original listava `whisper.rn`, `llama.rn` e Fish Audio TTS como stack; essas dependências foram removidas temporariamente no commit **B#2** ("remover libs nao usadas") e serão reintroduzidas quando houver UI para usá-las.

Stack técnica real hoje:
- React Native 0.76.7 (Old Arch ativa; a infraestrutura New Arch — `fabricEnabled`, `DefaultNewArchitectureEntryPoint` — já está plugada em `MainApplication.kt`, basta ligar `newArchEnabled=true` quando fizer sentido).
- TypeScript, Hermes, Android-only.
- CI: um workflow que roda `gradlew assembleDebug` para validar o build.

---

## Roadmap

Construção incremental. Sem promessa de datas — isto é projeto de fim de semana, não de startup.

### 🧱 Fase 1 — O essencial (em andamento)
Objetivo: **um app de chat funcional com STT interno e múltiplos backends de LLM.**

- [ ] Conectar `PcmRecorderModule` ao JS via `NativeModules` e expor um `AudioService`
- [ ] Integrar um motor de STT on-device ( candidato: `sherpa-onnx-rn` — Whisper.arw corruptor revisitado)
- [ ] Reintroduzir `llama.rn` para rodar modelos GGUF localmente e substituir o stub `fetchLocalModel`
- [ ] Tela **Models**: baixar GGUFs (Hugging Face ou URL direta), validar espaço, carregar/descarregar
- [ ] Roteabilidade real: React Navigation (Native Stack) liberando `DownloadScreen` e futuras telas
- [ ] Correções imediatas de robustez: `tsconfig` com `lib: ["es2022","dom"]`, tratamento de erro de rede sem poluir histórico, validação de permissão runtime `RECORD_AUDIO`
- [ ] Estado global com Zustand (a substituir `useState` espalhado)
- [ ] CI expandir: `tsc --noEmit` + lint, não só build

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
├── App.tsx              # Root + navegação manual (a ser substituída)
├── data/
│   └── appSettings.ts   # Persistência de config em AsyncStorage
├── screens/
│   ├── ChatScreen.tsx
│   ├── DownloadScreen.tsx   # placeholder
│   └── SettingsScreen.tsx
├── services/
│   └── LlmService.ts    # OpenAI-compatible client (localhost/local)
└── types/
    └── index.ts

android/app/src/main/java/com/bemore/companion/
├── MainActivity.kt
├── MainApplication.kt
├── PcmRecorderModule.kt   # Áudio PCM → WAV, sem dependências externas
└── PcmRecorderPackage.kt
```

---

## Licença

MIT. Faça o que quiser, desde que mantenha os créditos. PRs welcome — mas lembre que isto é projeto pessoal, então nem toda contribuição será mergeada.

## Inspirado por
- [PocketPal AI](https://github.com/a-ghorbani/pocketpal-ai) — privacidade on-device em RN
- [Oxproxion](https://github.com/stardomains3/oxproxion) — multi-provider e UX em Kotlin nativo
