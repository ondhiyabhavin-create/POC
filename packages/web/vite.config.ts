import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :4000 and is proxied, so the browser sees one origin
// (the same way CloudFront routes /api/* to API Gateway in AWS).
export default defineConfig({
  plugins: [react()],
  define: { global: 'globalThis' }, // needed by amazon-cognito-identity-js
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
