export function createVadAsrWorkerClient() {
  const worker = new Worker(new URL('./vadAsrWorker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let nextRequestId = 1;

  const rejectAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  worker.onmessage = (event) => {
    const { requestId, ok, result, error } = event.data || {};
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    if (ok) {
      entry.resolve(result);
      return;
    }
    const err = new Error(error?.message || 'VAD ASR worker request failed');
    err.name = error?.name || 'Error';
    if (error?.stack) err.stack = error.stack;
    entry.reject(err);
  };

  worker.onerror = (event) => {
    rejectAll(new Error(event.message || 'VAD ASR worker crashed'));
  };

  const call = (type, payload = {}, transfer = []) => new Promise((resolve, reject) => {
    const requestId = nextRequestId++;
    pending.set(requestId, { resolve, reject });
    try {
      worker.postMessage({ type, requestId, ...payload }, transfer);
    } catch (error) {
      pending.delete(requestId);
      reject(error);
    }
  });

  return {
    configure(config, { preload = false } = {}) {
      return call('configure', { config, preload });
    },
    transcribe(audio, options = {}) {
      if (!(audio instanceof Float32Array)) {
        return Promise.reject(new Error('VAD ASR worker expects Float32Array audio.'));
      }
      return call('transcribe', { audio, options }, [audio.buffer]);
    },
    terminate() {
      rejectAll(new Error('VAD ASR worker terminated'));
      worker.terminate();
    },
  };
}
