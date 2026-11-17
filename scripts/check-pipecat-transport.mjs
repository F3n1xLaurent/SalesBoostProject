import 'dotenv/config';
import WebSocket from 'ws';

async function main() {
  const privateBase = process.env.PIPECAT_HYPOTHESIS_URL?.replace(/\/$/u, '');
  const publicBase = process.env.PIPECAT_HYPOTHESIS_PUBLIC_URL?.replace(/\/$/u, '');
  const token = process.env.PIPECAT_HYPOTHESIS_TOKEN;
  if (!privateBase || !publicBase?.startsWith('https://') || !token) throw new Error('Не настроено локальное/публичное подключение Pipecat.');
  const health = await fetch(publicBase + '/health', { signal: AbortSignal.timeout(10_000) });
  if (!health.ok) throw new Error(`Public health HTTP ${health.status}`);
  const response = await fetch(privateBase + '/transport-probes', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Create transport probe HTTP ${response.status}`);
  const probe = await response.json();
  await new Promise((resolve, reject) => {
    const pcm = Buffer.alloc(640).toString('base64');
    const ws = new WebSocket(publicBase.replace(/^https:/u, 'wss:') + `/media/${probe.id}?token=${encodeURIComponent(probe.token)}`);
    const fail = (reason) => { clearTimeout(timer); reject(new Error(reason)); };
    const timer = setTimeout(() => { ws.terminate(); fail('Public WSS timeout'); }, 10_000);
    ws.on('unexpected-response', (_req, res) => { res.resume(); fail(`Public WSS HTTP ${res.statusCode}`); });
    ws.on('error', () => fail('Public WSS connection failed'));
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.event === 'transport_ready') ws.send(JSON.stringify({ payload: pcm }));
      if (event.event === 'transport_echo') {
        clearTimeout(timer);
        ws.close();
        if (event.payload !== pcm) reject(new Error('PCM transport payload mismatch'));
        else resolve();
      }
    });
  });
  console.log(JSON.stringify({ publicUrl: publicBase, https: true, websocketUpgrade: true, pcmPayloadRoundTrip: true, phoneCallsMade: 0 }, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
