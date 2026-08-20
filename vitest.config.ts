import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // convex-test evaluates the component's function modules in a V8-like
    // sandbox; edge-runtime is the closest match to the real Convex runtime,
    // and it is what catches accidental Node-builtin usage in component code.
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
