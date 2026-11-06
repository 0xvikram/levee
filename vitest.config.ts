import { configDefaults, defineConfig } from "vitest/config";

// The dashboard has its own Vite/Vitest setup (jsdom, React); run it with `cd dashboard && npm test`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "dashboard/**"],
  },
});
