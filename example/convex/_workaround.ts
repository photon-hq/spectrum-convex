"use node";

// Convex installs an `externalPackages` entry into the Node action's
// node_modules only if the bundled code actually imports it. `nice-grpc`,
// `nice-grpc-common`, and `@grpc/grpc-js` are *optional peers* of
// `@photon-ai/advanced-imessage`, loaded dynamically from inside that package —
// so nothing in the bundle references them and they are never installed.
// `createGrpcClient` then fails its `import.meta.resolve` peer check.
//
// Re-exporting them here gives the bundler a static reference, which is enough
// for Convex to install them. Nothing imports this module; it exists purely so
// the packages ship.
export * as _grpcJs from "@grpc/grpc-js";
export * as _niceGrpc from "nice-grpc";
export * as _niceGrpcCommon from "nice-grpc-common";
