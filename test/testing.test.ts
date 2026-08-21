import { defineSchema } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import spectrum, { register } from "../src/test.js";

/**
 * Guards the `@spectrum-ts/convex/test` entry point.
 *
 * This export was declared in `package.json` long before the module behind it
 * existed, so every install that imported it got `ERR_MODULE_NOT_FOUND`. The
 * remaining risk is quieter: `import.meta.glob` is a build-time transform, so a
 * wrong glob path silently yields `{}`, and every component function a consumer
 * calls then 404s inside their own tests. Asserting the glob actually matched
 * is the only way to catch that from here.
 */
describe("test entry point", () => {
  it("globs the component's function modules", () => {
    const paths = Object.keys(spectrum.modules);
    expect(paths).toEqual(
      expect.arrayContaining([
        "./component/inbound.ts",
        "./component/outbox.ts",
        "./component/pipeline.ts",
        // convex-test locates a module root by finding this directory in the
        // map, so a glob that misses it fails at `convexTest`, not at call time.
        "./component/_generated/server.ts",
      ])
    );
  });

  it("registers against a host test instance", () => {
    // convex-test boots from a host app's module map, and this package has no
    // app in it — the component's own map stands in, since all `register` needs
    // from the host is a live instance to attach to.
    const t = convexTest(defineSchema({}), spectrum.modules);
    expect(() => register(t)).not.toThrow();
  });

  it("defaults to the name the component is defined with", () => {
    const names: string[] = [];
    const stub = {
      registerComponent: (name: string) => names.push(name),
    } as unknown as Parameters<typeof register>[0];

    register(stub);
    register(stub, "aliased");

    // Must match `defineComponent("spectrum")`, or an app that installs under
    // the default name gets a component the tests never populated.
    expect(names).toEqual(["spectrum", "aliased"]);
  });
});
