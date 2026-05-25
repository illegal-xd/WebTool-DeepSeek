import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { APP_VERSION } from './config.js';

export default defineConfig({
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'WebTool-DeepSeek',
    description: 'Agentic memory & skill system for DeepSeek',
    version: APP_VERSION,
    permissions: ['sidePanel', 'storage', 'nativeMessaging'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
    host_permissions: [
      '*://chat.deepseek.com/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
