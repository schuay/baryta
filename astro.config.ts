import { defineConfig } from 'astro/config';
import baryta from './src/integration.ts';

export default defineConfig({
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  integrations: [baryta()],
});
