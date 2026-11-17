/** Root .env controls this isolated service, including removal of proxy settings. */
export function pipecatDockerEnv(fileEnv, inherited = process.env) {
  const env = { ...inherited, ...fileEnv };
  env.ELEVENLABS_PROXY_URL = fileEnv.ELEVENLABS_PROXY_URL || '';
  if (Object.hasOwn(fileEnv, 'PIPECAT_ELEVENLABS_PROXY_URL')) {
    // An explicit empty value disables the proxy for Docker only.
    env.PIPECAT_ELEVENLABS_PROXY_URL = fileEnv.PIPECAT_ELEVENLABS_PROXY_URL || '';
  } else {
    let proxy = env.ELEVENLABS_PROXY_URL;
    if (proxy) {
      const url = new URL(proxy);
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        url.hostname = 'host.docker.internal';
        proxy = url.toString();
      }
    }
    env.PIPECAT_ELEVENLABS_PROXY_URL = proxy;
  }
  return env;
}
