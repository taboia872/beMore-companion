import {AppTheme} from '../types';

/**
 * Paleta de cores para cada tema.
 *
 * O tema é aplicado dinamicamente em ChatScreen e App via `useTheme(settings)`.
 * Cada cor corresponde a um elemento específico da UI — não usar hardcoded
 * (#0d1117 etc) em styles; sempre referenciar o tema ativo.
 *
 * Convenção de nomes (mesma chave em ambos os temas para facilitar troca):
 *   bg          — background principal (SafeAreaView)
 *   bgSurface   — background de surfaces (bubbles bot, input bar, header)
 *   bgElevated  — background mais elevado (cards, modais, bottom sheets)
 *   border      — cor de bordas sutis (separadores, action bar)
 *   text        — texto principal
 *   textSecondary — texto secundário (labels, ícones inativos)
 *   textMuted   — texto ainda mais atenuado (timestamps, hints)
 *   accent      — cor de destaque (links, botão send, active states)
 *   accentText  — texto sobre accent (branco no dark, branco no light)
 *   userBubble  — background da bubble do user
 *   userBubbleText — texto na bubble do user
 *   botBubble   — background da bubble do bot
 *   botBubbleText — texto na bubble do bot (via Markdown)
 *   errorBg     — bubble de erro background
 *   errorBorder — borda da bubble de erro
 *   errorText   — texto de erro
 *   codeBg      — background de code blocks
 *   codeText    — texto de code blocks
 *   codeInline  — código inline (cor + bg)
 *   codeInlineBg
 *   thinkingBg  — background do bloco de pensamento
 *   thinkingBorder — borda do bloco de pensamento
 *   tableBorder — borda de tabelas (importante: visível em ambos os temas)
 *   statusBar   — 'light-content' ou 'dark-content' para StatusBar.barStyle
 */
export interface ThemeColors {
  bg: string;
  bgSurface: string;
  bgElevated: string;
  border: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentText: string;
  userBubble: string;
  userBubbleText: string;
  botBubble: string;
  errorBg: string;
  errorBorder: string;
  errorText: string;
  codeBg: string;
  codeText: string;
  codeInline: string;
  codeInlineBg: string;
  thinkingBg: string;
  thinkingBorder: string;
  thinkingText: string;
  tableBorder: string;
  tableHeaderBg: string;
  statusBar: 'light-content' | 'dark-content';
}

export const THEMES: Record<AppTheme, ThemeColors> = {
  dark: {
    bg: '#0d1117',
    bgSurface: '#161b22',
    bgElevated: '#21262d',
    border: '#21262d',
    text: '#e6edf3',
    textSecondary: '#8b949e',
    textMuted: '#6e7681',
    accent: '#58a6ff',
    accentText: '#ffffff',
    userBubble: '#1f6feb',
    userBubbleText: '#ffffff',
    botBubble: '#161b22',
    errorBg: '#3d1f1f',
    errorBorder: '#6e232e',
    errorText: '#f85149',
    codeBg: '#0d1117',
    codeText: '#e6edf3',
    codeInline: '#f0883e',
    codeInlineBg: '#0d1117',
    thinkingBg: '#0d1117',
    thinkingBorder: '#21262d',
    thinkingText: '#8b949e',
    // Tabelas no tema escuro: linhas branco/cinza para visibilidade
    tableBorder: '#8b949e',
    tableHeaderBg: '#21262d',
    statusBar: 'light-content',
  },
  light: {
    bg: '#f6f8fa',
    bgSurface: '#ffffff',
    bgElevated: '#eaeef2',
    border: '#d0d7de',
    text: '#1f2328',
    textSecondary: '#656d76',
    textMuted: '#8c959f',
    accent: '#0969da',
    accentText: '#ffffff',
    userBubble: '#0969da',
    userBubbleText: '#ffffff',
    botBubble: '#ffffff',
    errorBg: '#ffebe9',
    errorBorder: '#ffcecb',
    errorText: '#cf222e',
    codeBg: '#f6f8fa',
    codeText: '#1f2328',
    codeInline: '#ab5b1c',
    codeInlineBg: '#eff1f3',
    thinkingBg: '#f6f8fa',
    thinkingBorder: '#d0d7de',
    thinkingText: '#656d76',
    // Tabelas no tema claro: bordas cinza_escuro para visibilidade
    tableBorder: '#d0d7de',
    tableHeaderBg: '#eaeef2',
    statusBar: 'dark-content',
  },
};

/**
 * Hook simples que extrai o tema ativo das settings.
 * Retorna o objeto ThemeColors pronto para uso em styles.
 */
export function getTheme(theme?: AppTheme): ThemeColors {
  return THEMES[theme ?? 'dark'];
}
