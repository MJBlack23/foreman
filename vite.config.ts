import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.PORT ?? 7896);

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    proxy: { "/api": { target: `http://127.0.0.1:${port}`, changeOrigin: false } },
  },
});
