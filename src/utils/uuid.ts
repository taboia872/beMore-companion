/**
 * Gera um UUID v4 (random) sem depender de crypto.randomUUID(),
 * que não existe no React Native / Android WebView.
 *
 * Usa crypto.getRandomValues() (polyfilled por react-native-get-random-values)
 * fallback para Math.random() se o polyfill não estiver disponível.
 */

/**
 * Gera um UUID v4 (random) no formato:
 * xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 *
 * @returns string UUID v4
 */
export function uuidv4(): string {
  // Usa getRandomValues se disponível (polyfill react-native-get-random-values)
  if (typeof global.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);

    // Version 4 + variant RFC 4122
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'));
    return (
      hex.slice(0, 4).join('') + '-' +
      hex.slice(4, 6).join('') + '-' +
      hex.slice(6, 8).join('') + '-' +
      hex.slice(8, 10).join('') + '-' +
      hex.slice(10, 16).join('')
    );
  }

  // Fallback: Math.random() (menos seguro, mas funciona em qualquer ambiente)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
