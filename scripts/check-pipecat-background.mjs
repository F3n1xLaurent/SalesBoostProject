import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// No call: a temporary synthetic WAV goes through the real Docker conversion,
// signed HTTP download and public HTTPS gateway. No source pack is modified.
async function main() {
  const program = `
import os,tempfile,json,wave
from pathlib import Path
from array import array
from background_audio import prepare_file,signature,cache_root
with tempfile.TemporaryDirectory() as directory:
    os.environ['PIPECAT_BACKGROUND_DIR']=directory
    path=Path(directory)/'probe.wav'
    with wave.open(str(path),'wb') as wav:
        wav.setparams((1,2,16000,0,'NONE','not compressed'))
        wav.writeframes(array('h',[10000,-10000]*8000).tobytes())
    asset=prepare_file(path,.2)
    with wave.open(str(cache_root()/asset),'rb') as wav:
        pcm=array('h',wav.readframes(wav.getnframes()))
    assert all(abs(v)==2000 for v in pcm)
    print(json.dumps({'asset':asset,'token':signature(asset)}))
`;
  const asset = JSON.parse(execFileSync('docker', ['exec', 'salesboost-pipecat-pipecat-1', 'python', '-c', program], { encoding: 'utf8', timeout: 40_000 }));
  const privateBase = process.env.PIPECAT_HYPOTHESIS_URL?.replace(/\/$/u, '');
  const publicBase = process.env.PIPECAT_HYPOTHESIS_PUBLIC_URL?.replace(/\/$/u, '');
  if (!privateBase || !publicBase?.startsWith('https://')) throw new Error('Missing Pipecat private/public URL');
  const path = `/background/${asset.asset}?token=${asset.token}`;
  const [local, remote] = await Promise.all([privateBase, publicBase].map(async base => {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok || !r.headers.get('content-type')?.startsWith('audio/wav')) throw new Error(`Background download HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }));
  if (!local.equals(remote)) throw new Error('HTTPS WAV differs from converted WAV');
  const head = await fetch(publicBase + path, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
  const range = await fetch(publicBase + path, { headers: { Range: 'bytes=0-43' }, signal: AbortSignal.timeout(10_000) });
  if (!head.ok || Number(head.headers.get('content-length')) !== local.length || range.status !== 206
      || !Buffer.from(await range.arrayBuffer()).equals(local.subarray(0, 44))) throw new Error('HEAD/Range forwarding failed');
  const denied = await fetch(publicBase + path.replace(asset.token, 'x'.repeat(64)), { signal: AbortSignal.timeout(10_000) });
  if (denied.status !== 403) throw new Error('Invalid audio credentials accepted');
  console.log(JSON.stringify({ phoneCalls: 0, amplitude: .2, wavBytes: local.length,
    sha256: createHash('sha256').update(local).digest('hex'), publicHTTPS: true, exactBytes: true, head: true, range: true, invalidTokenRejected: true }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
