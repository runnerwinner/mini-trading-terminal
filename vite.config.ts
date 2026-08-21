import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (
            id.includes("/@solana/") ||
            id.includes("/decimal.js/") ||
            id.includes("/bs58/") ||
            id.includes("/@noble/") ||
            id.includes("/@coral-xyz/") ||
            id.includes("/rpc-websockets/")
          ) {
            return "solana";
          }
          if (
            id.includes("/recharts/") ||
            id.includes("/victory-vendor/") ||
            id.includes("/d3-")
          ) {
            return "charts";
          }
          if (
            id.includes("/@codex-data/") ||
            id.includes("/graphql") ||
            id.includes("/@graphql-tools/") ||
            id.includes("/dataloader/")
          ) {
            return "codex";
          }
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/react-router/") ||
            id.includes("/react-router-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "react";
          }
          // 其余依赖交给 Rollup 自动分组，避免产生循环 chunk
        },
      },
    },
    chunkSizeWarningLimit: 1100,
  },
});
