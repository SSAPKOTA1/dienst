import { buildApp } from './app';
import { loadConfig } from './config';

const cfg = loadConfig();
const app = await buildApp({ autoCheckout: true });
try {
  await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
