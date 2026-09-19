import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://agentuniver.com',
  output: 'static',
  integrations: [tailwind()]
});


