import {LlmConfig, Message} from '../types';

/**
 * Eventos de stream emitidos para a UI conforme os tokens chegam.
 *
 * - 'thinking' : pedaço de raciocínio (entre <thinking></thinking>)
 * - 'token'     : pedaço de conteúdo visível (texto da resposta)
 * - 'done'      : stream terminou normalmente
 * - 'error'     : erro — carrega `message`
 * - 'aborted'   : geração cancelada pelo usuário (botão parar)
 */
export type StreamEvent =
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
  if (ctrl) abortGeneration();
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
    // Parser de <thinking> reaproveitado (mesma logica do stream).
    let inThinking = false;
    let pending = '';
    const routeDelta = (delta: string) => {
      if (!delta) return;
      pending += delta;
      while (pending.length > 0) {
        if (inThinking) {
          const close = pending.indexOf('</thinking>');
          if (close === -1) {
            const tagLen = '</thinking>'.length - 1;
            const safe = pending.length - tagLen;
            if (safe > 0) {
              onEvent({type: 'thinking', delta: pending.slice(0, safe)});
              pending = pending.slice(safe);
            }
            return;
          }
          if (close > 0) onEvent({type: 'thinking', delta: pending.slice(0, close)});
          pending = pending.slice(close + '</thinking>'.length);
          inThinking = false;
        } else {
          const open = pending.indexOf('<thinking>');
          if (open === -1) {
            const tagLen = '<thinking>'.length - 1;
            const safe = pending.length - tagLen;
            if (safe > 0) {
              onEvent({type: 'token', delta: pending.slice(0, safe)});
              pending = pending.slice(safe);
            }
            return;
          }
          if (open > 0) onEvent({type: 'token', delta: pending.slice(0, open)});
          pending = pending.slice(open + '<thinking>'.length);
          inThinking = true;
        }
      }
    };

    let finished = false;
    const finalize = (kind: 'done' | 'error' | 'aborted', msg?: string) => {
      if (finished) return;
      finished = true;
      if (kind === 'done') onEvent({type: 'done'});
      else if (kind === 'error')
        onEvent({type: 'error', message: msg ?? 'Erro desconhecido'});
      else onEvent({type: 'aborted'});
      if (pending) {
        if (inThinking) onEvent({type: 'thinking', delta: pending});
        else onEvent({type: 'token', delta: pending});
        pending = '';
      }
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
            const content: string = json?.choices?.[0]?.message?.content ?? '';
            if (content) routeDelta(content);
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
      if (!finished) finalize('error', 'Falha de rede ao conectar no servidor');
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

    // Parser de <thinking>: estado p/ rotear delta p/ thinking vs content.
    // As tags podem chegar fatiadas entre chunks, então mantemos um buffer de
    // bytes suspeitos (fim de chunk que pode ser prefixo de <thinking>).
    let inThinking = false;
    let pending = '';

    const routeDelta = (delta: string) => {
      if (!delta) return;
      pending += delta;
      while (pending.length > 0) {
        if (inThinking) {
          const close = pending.indexOf('</thinking>');
          if (close === -1) {
            // Reta o que certamente NÃO é parte da tag de fechamento.
            const tagLen = '</thinking>'.length - 1;
            const safe = pending.length - tagLen;
            if (safe > 0) {
              onEvent({type: 'thinking', delta: pending.slice(0, safe)});
              pending = pending.slice(safe);
            }
            return;
          }
          if (close > 0) {
            onEvent({type: 'thinking', delta: pending.slice(0, close)});
          }
          pending = pending.slice(close + '</thinking>'.length);
          inThinking = false;
        } else {
          const open = pending.indexOf('<thinking>');
          if (open === -1) {
            const tagLen = '<thinking>'.length - 1;
            const safe = pending.length - tagLen;
            if (safe > 0) {
              onEvent({type: 'token', delta: pending.slice(0, safe)});
              pending = pending.slice(safe);
            }
            return;
          }
          if (open > 0) {
            onEvent({type: 'token', delta: pending.slice(0, open)});
          }
          pending = pending.slice(open + '<thinking>'.length);
          inThinking = true;
        }
      }
    };

    const xhr = new XMLHttpRequest();
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
            finalize('done');
            return;
          }
          try {
            const json = JSON.parse(data);
            const delta: string = json?.choices?.[0]?.delta?.content ?? '';
            if (delta) routeDelta(delta);
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
            finalize('done');
            return;
          }
          try {
            const json = JSON.parse(data);
            const delta: string = json?.choices?.[0]?.delta?.content ?? '';
            if (delta) routeDelta(delta);
          } catch {
            /* descarta */
          }
        }
        // Esmaga buffer de tags thinking pendente.
        if (pending) {
          if (inThinking) onEvent({type: 'thinking', delta: pending});
          else onEvent({type: 'token', delta: pending});
          pending = '';
        }
        finalize('done');
      }
    };

    let finished = false;
    const finalize = (kind: 'done' | 'error' | 'aborted', msg?: string) => {
      if (finished) return;
      finished = true;
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
      if (!finished) finalize('error', 'Falha de rede ao conectar no servidor');
    };
    xhr.onabort = () => {
      if (!finished) finalize('aborted');
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
  if (ctrl) {
    try {
      ctrl.abort();
    } catch {
      /* no-op */
    }
  }
}
