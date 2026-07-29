/**
 * Helpers para exibição de nomes de modelo LLM.
 *
 * Servidores OpenAI-compatíveis (Ollama, LM Studio, llama.cpp server) costumam
 * retornar `id` com caminho absoluto do sistema de arquivos, ex:
 *   "/home/runner/ollama/models/llama3.2:3b"
 *   "C:\\Users\\foo\\AppData\\lmstudio\\models\\qwen2.5-7b.gguf"
 *
 * Para a UI queremos só a última parte — "llama3.2:3b" / "qwen2.5-7b.gguf" — que é
 * o que o usuário reconhece. O valor completo continua sendo guardado em settings
 * (porque é isso que mandamos no campo `model` da requisição).
 */

/**
 * Extrai o "basename" de um id de modelo — lida com caminhos Unix e Windows,
 * e com ids sem barra ("llama3" → "llama3").
 *
 * @example
 *   shortModelName('/home/user/ollama/llama3.2:3b')      → 'llama3.2:3b'
 *   shortModelName('C:\\Users\\foo\\qwen2.5-7b.gguf')         → 'qwen2.5-7b.gguf'
 *   shortModelName('qwen2.5')                              → 'qwen2.5'
 *   shortModelName('')                                     → ''
 */
export function shortModelName(id: string | undefined | null): string {
  if (!id) return '';
  const trimmed = id.trim();
  if (!trimmed) return '';
  // Normaliza barras Windows para Unix antes de quebrar.
  const parts = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return last || trimmed;
}
