import { defineConfig } from 'vite';

const isTauriCli = Boolean(
  process.env.TAURI_ENV_PLATFORM ||
  process.env.TAURI_ENV_ARCH ||
  process.env.TAURI_ENV_DEBUG
);
const port = isTauriCli ? 1420 : Number(process.env.PORT || 3000);

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port,
    strictPort: isTauriCli,
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
});
