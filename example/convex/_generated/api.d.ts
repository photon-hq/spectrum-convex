/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _workaround from "../_workaround.js";
import type * as agent from "../agent.js";
import type * as http from "../http.js";
import type * as sender from "../sender.js";
import type * as spectrum from "../spectrum.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  _workaround: typeof _workaround;
  agent: typeof agent;
  http: typeof http;
  sender: typeof sender;
  spectrum: typeof spectrum;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  spectrum: import("@spectrum-ts/convex/_generated/component.js").ComponentApi<"spectrum">;
};
