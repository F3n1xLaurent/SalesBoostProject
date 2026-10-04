import { describe, expect, it } from 'vitest';
import { parseProxyApiTariffPage } from '../economics/proxyApiTariffs';

describe('ProxyAPI public tariff parser', () => {
  const product = {
    '@context': 'https://schema.org',
    '@graph': [{
      '@type': 'Product',
      sku: 'openai/gpt-test',
      offers: [
        { '@type': 'Offer', price: '60.00', priceCurrency: 'RUB', description: 'Ввод, за 1М токенов' },
        { '@type': 'Offer', price: '360.00', priceCurrency: 'RUB', description: 'Вывод, за 1М токенов' },
      ],
    }],
  };

  it('reads normal token and cache prices, ignoring the batch price column', () => {
    const html = `<script type="application/ld+json">${JSON.stringify(product)}</script>
      <table><tbody>
        <tr><td><span>Ввод</span></td><td>60&nbsp;₽</td><td>30&nbsp;₽</td><td>за 1М токенов</td></tr>
        <tr><td>Вывод</td><td>360 ₽</td><td>180 ₽</td><td>за 1М токенов</td></tr>
        <tr><td>Кэш чтение</td><td>6 ₽</td><td>3 ₽</td><td>за 1М токенов</td></tr>
        <tr><td>Кэш запись</td><td>75 ₽</td><td>37,50 ₽</td><td>за 1М токенов</td></tr>
      </tbody></table>`;
    expect(parseProxyApiTariffPage(html, 'openai/gpt-test').rates).toEqual({
      input_tokens: { price: 60, unit: 'million_tokens' },
      output_tokens: { price: 360, unit: 'million_tokens' },
      cache_read_input_tokens: { price: 6, unit: 'million_tokens' },
      cache_write_input_tokens: { price: 75, unit: 'million_tokens' },
    });
  });

  it('rejects a page for another model', () => {
    expect(() => parseProxyApiTariffPage(`<script type="application/ld+json">${JSON.stringify(product)}</script>`, 'openai/other'))
      .toThrow(/model mismatch/);
  });

  it('supports speech recognition priced per minute', () => {
    const speechProduct = {
      '@graph': [{
        '@type': 'Product', sku: 'openai/stt-test',
        offers: [{ price: '0.77', priceCurrency: 'RUB', description: 'Входящее аудио, за 1 минуту' }],
      }],
    };
    const html = `<script type="application/ld+json">${JSON.stringify(speechProduct)}</script>
      <tr><td>Входящее аудио</td><td>0,77 ₽</td><td>за 1 минуту</td></tr>`;
    expect(parseProxyApiTariffPage(html, 'openai/stt-test').rates).toEqual({
      input_audio: { price: 0.77, unit: 'minute' },
    });
  });

  it('does not misclassify TTS characters as input tokens', () => {
    const speechProduct = {
      '@graph': [{
        '@type': 'Product', sku: 'openai/tts-test',
        offers: [{ price: '3866.00', priceCurrency: 'RUB', description: 'Ввод, за 1М символов' }],
      }],
    };
    const html = `<script type="application/ld+json">${JSON.stringify(speechProduct)}</script>
      <tr><td>Ввод</td><td>3 866 ₽</td><td>за 1М символов</td></tr>`;
    expect(parseProxyApiTariffPage(html, 'openai/tts-test').rates).toEqual({
      input_characters: { price: 3866, unit: 'million_characters' },
    });
  });
});
