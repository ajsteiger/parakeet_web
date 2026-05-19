import { ParakeetModel, getParakeetModel } from 'parakeet.js';

let currentConfig = null;
let currentConfigKey = null;
let model = null;
let modelLoadPromise = null;
let transcribeQueue = Promise.resolve();

function serializeConfig(config) {
  return JSON.stringify(config || null);
}

function disposeModel() {
  if (model) {
    try {
      model.dispose();
    } catch (error) {
      console.warn('[VAD worker] Failed to dispose model:', error);
    }
    model = null;
  }
  modelLoadPromise = null;
}

function applyConfig(config) {
  const nextKey = serializeConfig(config);
  if (nextKey === currentConfigKey) return;
  disposeModel();
  currentConfig = config;
  currentConfigKey = nextKey;
}

async function loadModelFromConfig(config) {
  if (!config?.repoId) {
    throw new Error('VAD ASR worker is missing model configuration.');
  }
  const modelUrls = await getParakeetModel(config.repoId, config.downloadOpts || {});
  const nMels = modelUrls.modelConfig?.featuresSize || 128;
  return ParakeetModel.fromUrls({
    ...modelUrls.urls,
    filenames: modelUrls.filenames,
    backend: config.backend,
    verbose: !!config.verbose,
    cpuThreads: config.cpuThreads,
    preprocessorBackend: modelUrls.preprocessorBackend,
    nMels,
  });
}

async function ensureModel() {
  if (model) return model;
  if (!currentConfig) throw new Error('VAD ASR worker has not been configured yet.');
  if (!modelLoadPromise) {
    modelLoadPromise = loadModelFromConfig(currentConfig)
      .then((loadedModel) => {
        model = loadedModel;
        return loadedModel;
      })
      .catch((error) => {
        modelLoadPromise = null;
        throw error;
      });
  }
  return modelLoadPromise;
}

function postSuccess(requestId, result) {
  self.postMessage({ requestId, ok: true, result });
}

function postFailure(requestId, error) {
  self.postMessage({
    requestId,
    ok: false,
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: error?.stack || null,
    },
  });
}

self.onmessage = (event) => {
  const { type, requestId, config, preload = false, audio, options = {} } = event.data || {};
  const run = async () => {
    switch (type) {
      case 'configure':
        applyConfig(config);
        if (preload) await ensureModel();
        return { ready: true };
      case 'transcribe':
        if (!(audio instanceof Float32Array)) {
          throw new Error('VAD ASR worker received invalid audio payload.');
        }
        transcribeQueue = transcribeQueue
          .catch(() => {})
          .then(async () => {
            const loadedModel = await ensureModel();
            return loadedModel.transcribe(audio, 16000, {
              returnTimestamps: true,
              returnConfidences: true,
              ...options,
            });
          });
        return transcribeQueue;
      case 'dispose':
        disposeModel();
        currentConfig = null;
        currentConfigKey = null;
        transcribeQueue = Promise.resolve();
        return { disposed: true };
      default:
        throw new Error(`Unknown VAD ASR worker message type: ${type}`);
    }
  };

  run().then(
    (result) => postSuccess(requestId, result),
    (error) => postFailure(requestId, error),
  );
};
