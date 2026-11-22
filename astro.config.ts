import { defineConfig } from 'astro/config';
import folio from './src/integration.ts';

export default defineConfig({
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  integrations: [folio()],
});
