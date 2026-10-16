import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-time: proxy API calls to the CLI's live dashboard server
// (`ygl-trees webui serve --port 8642`). Prod build is static — host the
// assets anywhere and point /api at a running serve.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8642", changeOrigin: true },
    },
  },
});
