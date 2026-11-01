import { describe, expect, it } from 'vitest';
import { calculateProxyApiUsageAmount, parseProxyApiTariffPage, type ProxyApiRates } from '../economics/proxyApiTariffs';

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

  it('keeps the standard cache price separate from the 272K+ price', () => {
    const html = `<script type="application/ld+json">${JSON.stringify(product)}</script>
      <tr><td>Кэш чтение</td><td>6 ₽</td><td>3 ₽</td><td>за 1М токенов</td></tr>
      <tr><td>Кэш чтение (272K+)</td><td>12 ₽</td><td>6 ₽</td><td>за 1М токенов</td></tr>`;
    const { rates } = parseProxyApiTariffPage(html, 'openai/gpt-test');
    expect(rates.cache_read_input_tokens.price).toBe(6);
    expect(rates.extended_cache_read_input_tokens.price).toBe(12);
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

describe('ProxyAPI reasoning accounting', () => {
  const rates: ProxyApiRates = {
    input_tokens: { price: 60, unit: 'million_tokens' },
    output_tokens: { price: 360, unit: 'million_tokens' },
    cache_read_input_tokens: { price: 6, unit: 'million_tokens' },
    cache_write_input_tokens: { price: 75, unit: 'million_tokens' },
  };
  const usage = { prompt_tokens: 1000, completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 1500 } };
  it('charges reasoning included in completion_tokens only once', () => {
    expect(calculateProxyApiUsageAmount(rates, usage)).toBe(0.78);
  });
  it('supports a separately priced reasoning tariff without charging it as regular output', () => {
    expect(calculateProxyApiUsageAmount({ ...rates, reasoning_tokens: { price: 720, unit: 'million_tokens' } }, usage)).toBe(1.32);
  });
  it('charges cached and cache-write input separately', () => {
    expect(calculateProxyApiUsageAmount(rates, { ...usage, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 200 } })).toBe(0.7614);
  });
});
