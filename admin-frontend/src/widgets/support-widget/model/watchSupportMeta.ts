/** Follow the first background cache refresh, then stop fetching metadata. */
export function watchSupportMeta<T extends { categoriesPending?: boolean }>(load: () => Promise<T>, receive: (meta: T) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 2000;
  const poll = async () => {
    try {
      const meta = await load();
      if (stopped) return;
      receive(meta);
      if (meta.categoriesPending) {
        timer = setTimeout(poll, delay);
        delay = Math.min(30_000, delay * 2);
      }
    } catch { /* Keep fallback choices when the metadata endpoint is unavailable. */ }
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
