import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API и ML поднимаются отдельно (pnpm dev в корне); веб проксирует /api на API.
const api = process.env.INSPECTOR_API_URL ?? "http://127.0.0.1:8810";
const port = Number(process.env.WEB_PORT ?? 45810);

export default defineConfig({
  base:process.env.VITE_VERIFICATION_ONLY==='true'?'/verification/':'/',
  plugins: [react()],
  server: { port, host: "127.0.0.1", strictPort: true, proxy: { "/api": api, "/health": api } },
  build: { chunkSizeWarningLimit: 1500 },
});
