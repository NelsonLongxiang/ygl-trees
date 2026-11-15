import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-time: proxy API calls (including the /api/events SSE stream) to the
// CLI's live data server (`ygl-trees webui serve --port 8642`). The
// production build is static — `webui serve` hosts it and answers /api.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8642", changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          antd: ["antd", "@ant-design/icons"],
          xyflow: ["@xyflow/react"],
          markdown: ["react-markdown"],
          router: ["react-router"],
        },
      },
    },
  },
});
