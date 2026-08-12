/**
 * Heurística para detectar modelos com capacidade de visão (image input).
 *
 * A API OpenAI-compatível não expõe capabilities nos /models — só o id.
 * Por isso, a detecção é por padrões de nome conhecidos. A lista cobre os
 * principais provedores (OpenAI, Google, Meta, Qwen, Anthropic, HuggingFace,
 * Ollama, llama.cpp, OpenRouter suffixes, etc).
 *
 * Falso-positivos aceitáveis (melhor pecar por otimismo — o usuário
 * descobre rapidamente se o modelo não aceita imagem: a API retorna erro).
 * Falso-negativos são o problema (modelo suporta mas não marcamos).
 */

// Substrings (lowercase) que indicam capacidade de visão no id do modelo.
const VISION_PATTERNS: string[] = [
  // --- OpenAI ---
  'gpt-4o', // gpt-4o, gpt-4o-mini, gpt-4o-2024-...
  'gpt-4-vision', // gpt-4-vision-preview
  'gpt-4-turbo', // gpt-4-turbo (vision desde turbo)
  // --- Google Gemini (todos menos o gemini-1.0-pro puro) ---
  'gemini-1.5', // gemini-1.5-pro, gemini-1.5-flash
  'gemini-2.0', // gemini-2.0-flash
  'gemini-2.5',
  'gemini-pro-vision',
  'gemini-experimental',
  // --- Meta Llama Vision ---
  'llama-3.2-11b', // llama-3.2-11b-vision-preview
  'llama-3.2-90b',
  'llama-3.2-vision',
  'llama-4', // llama-4-scout, llama-4-maverick (multimodal nativo)
  // --- Qwen VL ---
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen2vl',
  'qwen-vl',
  'qvq', // Qwen-VL reasoning
  // --- Qwen 3.x multimodal — Qwen3.6-27B é confirmadamente vision no Groq ---
  // Groq model id: qwen/qwen3.6-27b. Qwen3.6 dense (27B) é multimodal nativo;
  // outros Qwen3.x podem não ser, mas o filtro "Visão" é opt-in: melhor pecar
  // por otimismo (falso-positivo aceitável — usuário descobre rapidamente).
  'qwen3.6',
  // --- InternVL / DeepSeek VL ---
  'internvl',
  'intern-vl',
  'deepseek-vl',
  // --- Moondream, LLaVA,ella, Bunny, SmolVLM ---
  'llava',
  'moondream',
  'bunny-vision',
  'smolvlm',
  'smolvlm2',
  'smol-vlm',
  // --- Pixtral (Mistral Vision) ---
  'pixtral',
  // --- CogVLM / CogAgent ---
  'cogvlm',
  'cogagent',
  // --- Idefics (HuggingFace) ---
  'idefics2',
  'idefics3',
  'idefics-2',
  'idefics-3',
  // --- Phi-3 / Phi-4 multimodal ---
  'phi-3.5-vision',
  'phi-3-vision',
  'phi-4-vision',
  'phi4-vision',
  // --- Molmo (Allen) ---
  'molmo',
  // --- Llama 3.2 Vision (variantes NC/IT) ---
  '-vision',
  '-vl-', // ex: mini-vlm-x, suffix -vl-
  // --- OpenAssistant / Openchat vision ---
  'openchat-vision',
  // --- UIX / Kosmos / Florence ---
  'kosmos',
  'florence',
  // --- Aya Vision ---
  'aya-vision',
  'aya-23-vision',
  // --- GLM-4V (Zhipu) ---
  'glm-4v',
  'glm-4.1v',
  'glm4v',
  // --- Skywork Vision ---
  'skywork-vision',
  // --- Olmoe vision (allen) ---
  'olmoe-vision',
  // --- OpenRouter suffix conventions ---
  '-vision',
  // --- NeVA (NVIDIA NeMo Vision) ---
  'neva',
  // --- GPT-5 (assume multimodal nativo) ---
  'gpt-5',
];

// Substrings que EXCLUEM o modelo de ser vision (overrides).
// Ex: gemini-1.0-pro SEM -vision é text-only; mesmo assim gemini-1.5+ já é.
const NON_VISION_PATTERNS: string[] = [
  // (placeholder para futuro — hoje não há padrão negativo confiável
  //  que não conflite com os positivos)
];

/**
 * Verifica se um modelo (pelo id) provavelmente suporta visão (image input).
 * Heurística por substring — não é 100% precisa, mas cobre os modelos
 * mais comuns nos provedores suportados (Google, OpenAI, Meta, Qwen, etc).
 *
 * @param id ID do modelo (ex: 'gpt-4o-mini', 'gemini-2.0-flash')
 * @returns true se o modelo provavelmente aceita imagem como input
 */
export function isVisionModel(id: string): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();

  // Substring override — nenhum padrão negativo por enquanto, mas mantém
  // a estrutura por extensibilidade.
  for (const neg of NON_VISION_PATTERNS) {
    if (lower.includes(neg)) return false;
  }

  for (const pattern of VISION_PATTERNS) {
    if (lower.includes(pattern)) return true;
  }

  return false;
}
