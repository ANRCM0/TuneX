/**
 * OpenAPI plumbing.
 *
 * Upstream imports `describeRoute` / `h2` from `hono-openapi` and `zValidator` from
 * `@hono/zod-validator` in every route module. Newer `hono-openapi` renamed `h2` to
 * `openAPIRouteHandler` and its own `validator` is a Standard-Schema validator rather
 * than the zod one the original code uses, so the replica keeps upstream's `zValidator`
 * and re-exports the renamed handler under the original name to keep call sites
 * byte-comparable with the decompiled source.
 */
export { describeRoute, openAPIRouteHandler as h2 } from "hono-openapi";
export { zValidator } from "@hono/zod-validator";
export { resolver } from "hono-openapi";
