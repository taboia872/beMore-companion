import {Message} from '../types';

/**
 * Extrai texto puro de uma Message, independentemente se content é string
 * ou array de partes multimodais. Usado para exibição na UI (preview da
 * mensagem, copy, etc) onde só importa o texto.
 */
export function getTextContent(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(p => p.type === 'text')
      .map(p => p.text ?? '')
      .join('');
  }
  return '';
}

/**
 * Extrai as URLs de imagem (data URIs base64) de uma Message multimodal.
 * Retorna array vazio se a mensagem não tem imagens.
 */
export function getImageUrls(msg: Message): string[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content
    .filter(p => p.type === 'image_url')
    .map(p => p.image_url?.url ?? '')
    .filter(Boolean);
}

/**
 * Verifica se uma Message tem imagens anexadas (é multimodal).
 */
export function hasImages(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(p => p.type === 'image_url');
}
