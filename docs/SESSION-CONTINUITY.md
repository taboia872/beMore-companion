# Server Manager — Plano de Continuidade

> **Objetivo:** Permitir continuar o trabalho em nova sessão sem perda de contexto.
> Este arquivo é o ponto de entrada para qualquer sessão nova que pegue este projeto.

## Estado Atual (snapshot: 13/ago/2026)

### Repositório
- **Repo:** `github.com/taboia872/beMore-companion`
- **Branch:** `feature/server-manager` (criada a partir do `main` pós-merge)
- **Main:** atualizado com 42 commits da `feature/chat-streaming-thinking-ui` (merge --no-ff)
- **Branch atual tem:** apenas o documento de design (`docs/SERVER-MANAGER-DESIGN.md`)
- **Caminho local:** `/root/beMore-companion`

### O que já foi feito
1. ✅ Merge `feature/chat-streaming-thinking-ui` → `main` (42 commits, pushado)
2. ✅ Branch `feature/server-manager` criada e pushada
3. ✅ Documento de design v2 escrito com TODAS as decisões confirmadas

### O que falta fazer (próxima sessão)

**Phase 1 — Foundation** (primeira coisa a fazer):

1. Instalar dependências:
   ```bash
   cd /root/beMore-companion
   npm install react-native-mmkv react-native-get-random-values
   ```

2. Criar estes arquivos (esboços completos estão no design doc):
   - `src/types/index.ts` — adicionar `ServerEntry`, `ModelEntry`, `AppSettingsV2`, `ServerFormat`, `KeyRotationStrategy`, `ModelRole`
   - `src/data/serverDb.ts` — CRUD de ServerEntry (MMKV)
   - `src/data/modelDb.ts` — CRUD de ModelEntry (MMKV)
   - `src/data/keychainDb.ts` — multi-key no Keychain
   - `src/services/ServerService.ts` — buildChatUrl, buildAuthHeaders, fetchModels, getReasoningFormat, buildImageGenUrl, buildImageGenPayload
   - `src/services/KeyRotation.ts` — single/round-robin/failover + cooldown
   - `src/services/ImageGenService.ts` — generateImage(server, model, apiKey, prompt)
   - `src/data/appSettings.ts` — migration legado (AsyncStorage) → MMKV V2

3. Marcar `migrated: false` antes da migration, `true` depois

**Phases 2-7:** Ver `docs/SERVER-MANAGER-DESIGN.md` seção 10.

---

## Decisões Confirmadas (não re-abrir)

1. **UUID** (`crypto.randomUUID()`) — sobrevive a updates do app
2. **MMKV para tudo** — abandonar AsyncStorage completamente
3. **Presets expandidos** — 11 presets (ver design doc seção 3), sem OpenAI/Mistral/DeepSeek/Together/Fireworks (só models fechados ou sem free tier)
4. **STT/TTS como FK** — `sttServerId`/`ttsServerId: string | null`
5. **Multi-key + rotação** — single, round-robin, failover (cooldown 60s)
6. **Badge offline só no ativo** — não pingar todos os servidores
7. **Sem limite de servidores**
8. **Fetch/re-fetch manual** — botão 🔄 explícito

---

## Estrutura dos Arquivos de Referência

```
docs/
  SERVER-MANAGER-DESIGN.md    ← Documento de design completo (schema, fluxos, código)
  SESSION-CONTINUITY.md       ← ESTE ARQUIVO — ponto de entrada para nova sessão
```

## Como Continuar em Nova Sessão

Se o contexto da sessão encher (ou gateway reiniciar), abrir nova sessão e dizer:

> "Continua o projeto server-manager do beMore-companion. Lê o arquivo
> `docs/SESSION-CONTINUITY.md` no repo `/root/beMore-companion` para retomar
> de onde paramos."

O agente deve:
1. `skill_view(name='react-native-ai-app-dev')` — carregar skill do projeto
2. `read_file('/root/beMore-companion/docs/SESSION-CONTINUITY.md')` — este arquivo
3. `read_file('/root/beMore-companion/docs/SERVER-MANAGER-DESIGN.md')` — design completo
4. Verificar estado do git: `git branch && git status && git log --oneline -5`
5. Continuar da próxima phase pendente

## Progresso

- [x] Merge para main
- [x] Branch feature/server-manager criada
- [x] Documento de design v2 (com decisões)
- [x] Plano de continuidade (este arquivo)
- [ ] Phase 1 — Foundation (MMKV, DB modules, migration)
- [ ] Phase 2 — Onboarding
- [ ] Phase 3 — Model Picker
- [ ] Phase 4 — Settings Redesign
- [ ] Phase 5 — Refactor Services
- [ ] Phase 6 — Security Fixes
- [ ] Phase 7 — Polish

## Convenções do Projeto (do memory do usuário)

- Commits: sempre commit + push após alterações. `Assisted-by: Hermes Agent` no message
- Builds: NÃO monitorar CI automaticamente após push. Aguardar verificação manual
- TTS: dual-backend (OpenAI MP3 | Gemini PCM→WAV)
- Keys: Keychain (Android Keystore) — nunca AsyncStorage/MMKV em cleartext
- Framework: React Native 0.76.7, build na nuvem via GitHub Actions (não compila local)
- Repos: `github.com/taboia872/` — PATs removidos, re-obter com usuário se necessário
