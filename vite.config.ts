import { defineConfig } from 'vite';
export default defineConfig({server:{host:'0.0.0.0',port:1420,strictPort:true},clearScreen:false,envPrefix:['VITE_','TAURI_ENV_*']});
