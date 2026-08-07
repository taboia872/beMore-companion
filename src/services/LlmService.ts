import {LlmConfig, Message} from '../types';

/**
 * Eventos de stream emitidos para a UI conforme os tokens chegam.
 *
 * - 'reasoning': pedaço de raciocínio vindo do campo `reasoning_content`
 *      do delta SSE (servidores modernos: DeepSeek API, OpenRouter, etc).
 * - 'thinking' : pedaço de raciocínio extraído de tags inline (<thinking>,
 *      ) no `content` — modelos locais via Ollama que nao separam
 *      o raciocnio num campo proprio.
 * - 'token'     : pedaço de conteúdo visível (texto da resposta).
 * - 'done'      : stream terminou normalmente.
 * - 'error'     : erro — carrega `message`.
 * - 'aborted'   : geração cancelada pelo usuário (botão parar).
 *
 * 'reasoning' e 'thinking' sao distintos na fonte mas a UI os trata
 * igual: ambos alimentam `message.thinking`. Manter os tipos separados
 * permite futuras diferenciacoes (ex: reasoning_content tem timestamp,
 * tags inline nao).
 */
export type StreamEvent =
  | {type: 'reasoning'; delta: string}
  | {type: 'thinking'; delta: string}
  | {type: 'token'; delta: string}
  | {type: 'done'}
  | {type: 'error'; message: string}
  | {type: 'aborted'};

/**
 * Callback recebido pelo serviço a cada evento de stream.
 * Retorna `false` para pedir o aborto do stream (cancelamento cooperativo).
 */
export type StreamCallback = (event: StreamEvent) => void;

/**
 * Filtra mensagens marcadas como erro (isError) do contexto enviado ao LLM.
 * Mensagens de erro são feedback visual local — não devem virar prompt.
 * Também descarta campos internos (status, thinking) que não pertencem ao
 * payload enviado ao servidor.
 */
function sanitizeContext(messages: Message[]): Array<{
  role: Message['role'];
  content: string;
}> {
  return messages
    .filter(m => !m.isError && m.content.trim() !== '')
    .map(m => ({role: m.role, content: m.content}));
}

// ---------------------------------------------------------------------------
// Parser de tags de reasoning (thinking) — reutilizado por stream e batch.
// ---------------------------------------------------------------------------
//
// Modelos que suportam reasoning usam duas convenções de tags:
//   1. <thinking>...</thinking>  — genérico, usado por alguns modelos open
//   2.  MacBook / DeepSeek-R1 / Qwen3 / O1-style
//
// Este parser reconhece AMBAS. As tags podem chegar fatiadas entre chunks,
// então mantemos um buffer de bytes suspeitos (fim de chunk que pode ser
// prefixo de uma tag de abertura/fechamento).
//
// A função retorna um objeto com `routeDelta` (alimentar novo texto),
// `flushPending` (esmagar buffer remanescente no fim) e estado `inThinking`.
export function createThinkingParser(onEvent: StreamCallback) {
  // Pares de tags suportados, ordenados para que prefixes mais longos
  // sejam testados primeiro (evita mismatches parciais). Modelos locais
  // (Ollama, llama.cpp) emitem tags inline no `content`:
  //   1.  ( DeepSeek-R1 / Qwen3 / O1-style)
  //   2. <thinking>...</thinking>  (genérico, alguns modelos open)
  // O par canônico  é o mesmo usado pelo open-webui (middleware.py).
  const TAG_PAIRS: Array<[open: string, close: string]> = [
    ['<thinking>', '</thinking>'],
    ['<reasoning>', '</reasoning>'],
    ['<reason>', '</reason>'],
    ['<thought>', '</thought>'],
    ['<Thought>', '</Thought>'],
    ['🧠', '💬'],
  ];

  // Para detectar tags que chegam parcialmente, guardamos até
  // maxOpenTagLen-1 bytes no buffer se eles parecem prefixo de tag.
  const maxOpenTagLen = Math.max(...TAG_PAIRS.map(([o]) => o.length));
  const maxCloseTagLen = Math.max(...TAG_PAIRS.map(([, c]) => c.length));

  let inThinking = false;
  let pending = '';

  function routeDelta(delta: string) {
    if (!delta) return;
    pending += delta;
    while (pending.length > 0) {
      if (inThinking) {
        // Procura a tag de fechamento mais próxima.
        let closeIdx = -1;
        let closeLen = 0;
        for (const [, close] of TAG_PAIRS) {
          const idx = pending.indexOf(close);
          if (idx !== -1 && (closeIdx === -1 || idx < closeIdx)) {
            closeIdx = idx;
            closeLen = close.length;
          }
        }
        if (closeIdx === -1) {
          // Retém até maxCloseTagLen-1 bytes (podem ser prefixo da tag).
          const safe = pending.length - (maxCloseTagLen - 1);
          if (safe > 0) {
            onEvent({type: 'thinking', delta: pending.slice(0, safe)});
            pending = pending.slice(safe);
          }
          return;
        }
        if (closeIdx > 0) {
          onEvent({type: 'thinking', delta: pending.slice(0, closeIdx)});
        }
        pending = pending.slice(closeIdx + closeLen);
        inThinking = false;
      } else {
        // Procura a tag de abertura mais próxima.
        let openIdx = -1;
        let openLen = 0;
        for (const [open] of TAG_PAIRS) {
          const idx = pending.indexOf(open);
          if (idx !== -1 && (openIdx === -1 || idx < openIdx)) {
            openIdx = idx;
            openLen = open.length;
          }
        }
        if (openIdx === -1) {
          // Retém até maxOpenTagLen-1 bytes (podem ser prefixo da tag).
          const safe = pending.length - (maxOpenTagLen - 1);
          if (safe > 0) {
            onEvent({type: 'token', delta: pending.slice(0, safe)});
            pending = pending.slice(safe);
          }
          return;
        }
        if (openIdx > 0) {
          onEvent({type: 'token', delta: pending.slice(0, openIdx)});
        }
        pending = pending.slice(openIdx + openLen);
        inThinking = true;
      }
    }
  }

  /** Esmaga o buffer pendente, emitindo o restante como thinking ou token. */
  function flushPending() {
    if (pending) {
      if (inThinking) onEvent({type: 'thinking', delta: pending});
      else onEvent({type: 'token', delta: pending});
      pending = '';
    }
  }

  return {
    routeDelta,
    flushPending,
    get inThinking() {
      return inThinking;
    },
  };
}

/**
 * Inicia o stream de geração junto à API OpenAI-compatível.
 *
 * Implementação via XMLHttpRequest (e não fetch) porque o fetch do React
 * Native NÃO suporta streaming — ele espera a resposta completa. O XHR expõe
 * o evento `onprogress` com a `responseText` parcial conforme os bytes chegam,
 * permitindo parsear SSE em tempo real.
 *
 * Sem polyfills adicionais: funciona com o XHR já embutido no RN (0.76+).
 *
 * @param messages         contexto (já sanitizado) a enviar
 * @param config           config LLM (baseUrl, apiKey, model)
 * @param onEvent          callback chamado a cada evento de stream
 * @param streamingEnabled se false, faz UMA requisicao sem `stream:true` e
 *                         emite todo o conteudo como um unico `token` (modo
 *                         batch). Default true. Util p/ servidores que nao
 *                         suportam SSE ou quando o usuario prefere esperar.
 * @returns Promise que resolve ao final (com done/error/aborted ja emitidos)
 */
export function streamResponse(
  messages: Message[],
  config: LlmConfig,
  onEvent: StreamCallback,
  streamingEnabled = true,
): Promise<void> {
  if (config.provider === 'localhost') {
    return streamingEnabled
      ? streamNetwork(messages, config, onEvent)
      : fetchBatch(messages, config, onEvent);
  }
  // Modo local (llama.rn) — não implementado ainda. Emite erro e termina.
  onEvent({type: 'error', message: 'Local model ainda não implementado'});
  return Promise.resolve();
}

/**
 * Modo batch (sem stream). Faz UMA requisicao POST sem `stream:true`, aguarda
 * a resposta completa, emite o conteudo como um unico token e finaliza.
 * Reaproveita o mesmo parser de <thinking> do stream pra consistencia.
 */
function fetchBatch(
  messages: Message[],
  config: LlmConfig,
  onEvent: StreamCallback,
): Promise<void> {
  return new Promise<void>(resolve => {
    if (!config.baseUrl) {
      onEvent({type: 'error', message: 'URL do servidor não configurada'});
      resolve();
      return;
    }
    // Parser de thinking reaproveitado (reconhece <thinking> e  tags).
    const parser = createThinkingParser(onEvent);

    let finished = false;
    const finalize = (kind: 'done' | 'error' | 'aborted', msg?: string) => {
      if (finished) return;
      finished = true;
      // Esmaga buffer de tags thinking pendente ANTES de emitir done/error/aborted.
      // Se emitirmos 'done' primeiro, a UI marca status='done' e tokens
      // que chegarem depois podem ser ignorados pelo render (condição
      // isStreamingMsg fica falsa).
      parser.flushPending();
      if (kind === 'done') onEvent({type: 'done'});
      else if (kind === 'error')
        onEvent({type: 'error', message: msg ?? 'Erro desconhecido'});
      else onEvent({type: 'aborted'});
      if (ctrl === xhr) ctrl = null;
      resolve();
    };

    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'text';
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (config.apiKey) {
      xhr.setRequestHeader('Authorization', `Bearer ${config.apiKey}`);
    }
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4 && !finished) {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const json = JSON.parse(xhr.responseText);
            const choice = json?.choices?.[0];
            // reasoning_content em modo batch (non-stream).
            const reasoning: string =
              choice?.message?.reasoning_content ??
              choice?.message?.reasoning ??
              choice?.message?.thinking ??
              '';
            if (reasoning) onEvent({type: 'reasoning', delta: reasoning});
            const content: string = choice?.message?.content ?? '';
            if (content) parser.routeDelta(content);
            finalize('done');
          } catch (e) {
            finalize('error', 'Resposta inválida do servidor');
          }
        } else {
          const errText = xhr.responseText?.slice(0, 200) ?? '';
          finalize('error', `API ${xhr.status}: ${errText}`);
        }
      }
    };
    xhr.onerror = () => {
      if (!finished) {
        const status = xhr.status || 0;
        const errText = xhr.responseText?.slice(0, 200) ?? '';
        finalize('error', `Falha de rede (status ${status})${errText ? ': ' + errText : ''}`);
      }
    };
    xhr.onabort = () => {
      if (!finished) finalize('aborted');
    };
    ctrl = xhr;
    xhr.send(
      JSON.stringify({
        model: config.model || 'local-model',
        messages: sanitizeContext(messages),
        stream: false,
      }),
    );
  });
}

function streamNetwork(
  messages: Message[],
  config: LlmConfig,
  onEvent: StreamCallback,
): Promise<void> {
  return new Promise<void>(resolve => {
    if (!config.baseUrl) {
      onEvent({type: 'error', message: 'URL do servidor não configurada'});
      resolve();
      return;
    }

    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const payload = JSON.stringify({
      model: config.model || 'local-model',
      messages: sanitizeContext(messages),
      stream: true,
    });

    // Parser de thinking: reconhece <thinking> e  tags.
    // As tags podem chegar fatiadas entre chunks — o parser mantém um buffer
    // interno de bytes suspeitos e expõe routeDelta + flushPending.
    const parser = createThinkingParser(onEvent);

    const xhr = new XMLHttpRequest();
    xhr.timeout = 60000; // 60s sem resposta = timeout
    xhr.open('POST', url);
    xhr.responseType = 'text';
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (config.apiKey) {
      xhr.setRequestHeader('Authorization', `Bearer ${config.apiKey}`);
    }

    let consumed = 0; // offset já processado da responseText
    let lineBuffer = ''; // linha SSE parcial entre chunks

    const flush = (final: boolean) => {
      const full = xhr.responseText ?? '';
      if (full.length > consumed) {
        const chunk = full.slice(consumed);
        consumed = full.length;
        // Anexa ao buffer e processa só linhas COMPLETAS (terminadas por nova-linha).
        // Linhas SSE cortadas no meio entre chunks precisam esperar o proximo
        // onprogress para fechar — senao JSON.parse falha e perdemos o token.
        // A ultima linha (sem nova-linha) fica para a proxima rodada ou para o final.
        lineBuffer += chunk;
        let nl: number;
        while ((nl = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.slice(0, nl).trimStart();
          lineBuffer = lineBuffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            // Esmaga buffer de tags thinking pendente ANTES de finalizar.
            // Sem isso, a última retenção (até tagLen-1 bytes) é perdida.
            parser.flushPending();
            finalize('done');
            return;
          }
          try {
            const json = JSON.parse(data);
            const choice = json?.choices?.[0];
            if (choice) {
              const reasoning: string =
                choice?.delta?.reasoning_content ??
                choice?.delta?.reasoning ??
                choice?.delta?.thinking ??
                '';
              if (reasoning) onEvent({type: 'reasoning', delta: reasoning});
              const delta: string = choice?.delta?.content ?? '';
              if (delta) parser.routeDelta(delta);
            }
          } catch {
            // linha parcial / keep-alive — ignora.
          }
        }
      }
      if (final) {
        // Descarrega linha remanescente no buffer.
        const line = lineBuffer.trimStart();
        lineBuffer = '';
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            parser.flushPending();
            finalize('done');
            return;
          }
          try {
            const json = JSON.parse(data);
            const choice = json?.choices?.[0];
            if (choice) {
              const reasoning: string =
                choice?.delta?.reasoning_content ??
                choice?.delta?.reasoning ??
                choice?.delta?.thinking ??
                '';
              if (reasoning) onEvent({type: 'reasoning', delta: reasoning});
              const delta: string = choice?.delta?.content ?? '';
              if (delta) parser.routeDelta(delta);
            }
          } catch {
            /* descarta */
          }
        }
        // Esmaga buffer de tags thinking pendente.
        parser.flushPending();
        finalize('done');
      }
    };

    let finished = false;
    const finalize = (kind: 'done' | 'error' | 'aborted', msg?: string) => {
      if (finished) return;
      finished = true;
      // Esmaga buffer pendente antes de emitir o evento final.
      parser.flushPending();
      if (kind === 'done') onEvent({type: 'done'});
      else if (kind === 'error')
        onEvent({type: 'error', message: msg ?? 'Erro desconhecido'});
      else onEvent({type: 'aborted'});
      // Libera ref global p/ próximas gerações.
      if (ctrl === xhr) ctrl = null;
      resolve();
    };

    xhr.onprogress = () => flush(false);
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4 && !finished) {
        if (xhr.status >= 200 && xhr.status < 300) {
          flush(true);
        } else {
          const errText = xhr.responseText?.slice(0, 200) ?? '';
          finalize('error', `API ${xhr.status}: ${errText}`);
        }
      }
    };
    xhr.onerror = () => {
      if (!finished) {
        const status = xhr.status || 0;
        const errText = xhr.responseText?.slice(0, 200) ?? '';
        finalize('error', `Falha de rede (status ${status})${errText ? ': ' + errText : ''}`);
      }
    };
    xhr.onabort = () => {
      if (!finished) finalize('aborted');
    };
    xhr.ontimeout = () => {
      if (!finished) finalize('error', 'Timeout: servidor não respondeu em 60s');
    };

    ctrl = xhr;
    xhr.send(payload);
  });
}

/**
 * Referência ao XHR vigente — usada por abortGeneration() para cancelar.
 * Mantida fora da Promise porque o consumidor (UI) pode chamar abort a
 * qualquer momento, independentemente do estado interno do stream.
 */
let ctrl: XMLHttpRequest | null = null;

/**
 * Cancela a geração em andamento. Dispara onabort do XHR > onEvent aborted.
 * No-op se não houver geração ativa.
 */
export function abortGeneration(): void {
  const xhr = ctrl;
  if (xhr) {
    ctrl = null;  // limpa ANTES do abort p/ evitar race com onabort async
    try {
      xhr.abort();
    } catch {
      /* no-op */
    }
  }
}
