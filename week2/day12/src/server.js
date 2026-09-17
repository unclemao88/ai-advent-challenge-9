import path from 'node:path';

import { ROOT_DIR, loadConfig } from './config.js';
import { createApp } from './app.js';
import { DeepSeekClient } from './api/deepseekClient.js';

// Local development reads .env from the project root. Variables that are
// already set (e.g. by systemd's EnvironmentFile) take precedence over it.
try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const config = loadConfig();
const client = new DeepSeekClient(config.deepseek);

if (client.configured) {
  console.log(`DeepSeek: ${client.model} at ${client.endpoint}`);
} else {
  // Start anyway, so the UI can load and explain what is missing.
  console.warn('DEEPSEEK_API_KEY is not set. The UI will load, but questions will fail until it is.');
}

let app;
try {
  ({ app } = await createApp({ dataDir: config.dataDir, client }));
} catch (err) {
  console.error(`Could not initialise the data directory ${config.dataDir}: ${err.message}`);
  process.exit(1);
}

const server = app.listen(config.port, config.host, () => {
  console.log(`Data: ${config.dataDir}`);
  console.log(`Listening on http://${config.host}:${config.port}`);
});

server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down.`);
    // Stop accepting connections; in-flight requests finish and their writes land.
    server.close(() => process.exit(0));
    setTimeout(() => {
      console.error('Shutdown timed out, forcing exit.');
      process.exit(1);
    }, 15_000).unref();
  });
}
