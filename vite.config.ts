import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks: { react: ["react", "react-dom"], validation: ["zod"] },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/.tools/**",
        "**/artifacts/**",
        "**/releases/**",
      ],
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
