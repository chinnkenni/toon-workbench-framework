import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';

export default defineConfig({
  root:fileURLToPath(new URL('.',import.meta.url)),
  base:'/studio-ui/',
  publicDir:false,
  plugins:[react()],
  build:{
    outDir:'../public/studio-ui',
    emptyOutDir:true,
    assetsDir:'assets',
    rolldownOptions:{output:{entryFileNames:'assets/[name]-[hash].js',chunkFileNames:'assets/[name]-[hash].js',assetFileNames:'assets/[name]-[hash][extname]'}},
  },
});
