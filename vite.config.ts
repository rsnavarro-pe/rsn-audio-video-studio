import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [solidPlugin()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 3025,
    strictPort: true,
  },
  envPrefix: ["VITE_"],
  build: {
    target: "esnext",
    minify: true,
    sourcemap: false,
  },
});
