import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_PREFIX_REGEX = /^\/api/;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        changeOrigin: true,
        rewrite: (path) => path.replace(API_PREFIX_REGEX, ""),
        target: "http://localhost:3000",
      },
    },
  },
});
