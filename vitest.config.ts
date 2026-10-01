import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Lets tests import modules that use the app's "@/..." import alias.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
});
