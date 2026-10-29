import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Local diagnostic source exports and temporary fixtures are evidence,
    // not a second checkout whose tests should enter the product gate.
    exclude: [...configDefaults.exclude, "output/**", ".local/**"],
  },
});
