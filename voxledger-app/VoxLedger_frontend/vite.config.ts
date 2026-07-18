import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const BACKEND = "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  root: ".",
  build: {
    outDir: "dist/public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/health":        { target: BACKEND, changeOrigin: true },
      "/check-user":    { target: BACKEND, changeOrigin: true },
      "/register":                { target: BACKEND, changeOrigin: true },
      "/extract-name-from-voice": { target: BACKEND, changeOrigin: true },
      "/verify-voice":            { target: BACKEND, changeOrigin: true },
      "/login":         { target: BACKEND, changeOrigin: true },
      "/user":          { target: BACKEND, changeOrigin: true },
      "/transactions":  { target: BACKEND, changeOrigin: true },
      "/budget":        { target: BACKEND, changeOrigin: true },
      "/notifications": { target: BACKEND, changeOrigin: true },
      "/voice":         { target: BACKEND, changeOrigin: true },
    },
  },
});
