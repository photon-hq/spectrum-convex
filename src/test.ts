/// <reference types="vite/client" />

import type { GenericSchema, SchemaDefinition } from "convex/server";
import type { TestConvex } from "convex-test";
import schema from "./component/schema.js";

// `import.meta.glob` is how convex-test discovers a component's function
// modules. It is a Vite transform, which is why this entry point resolves to
// source rather than to `dist/` — the glob has to be rewritten by the caller's
// bundler, and a pre-compiled copy would only ever see an empty object.
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the Spectrum component with a `convex-test` instance.
 *
 * An app that installs this component and wants to test against it needs the
 * component's schema and modules registered explicitly:
 *
 * ```ts
 * import { convexTest } from "convex-test";
 * import spectrum from "@spectrum-ts/convex/test";
 * import schema from "./schema.js";
 *
 * const modules = import.meta.glob("./**\/*.ts");
 *
 * export function initConvexTest() {
 *   const t = convexTest(schema, modules);
 *   spectrum.register(t);
 *   return t;
 * }
 * ```
 *
 * @param t - The test instance, e.g. from calling `convexTest`.
 * @param name - The component's name as registered in `convex.config.ts`.
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name = "spectrum"
): void {
  t.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
