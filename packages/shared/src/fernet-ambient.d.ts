/**
 * Ambient types for the `fernet` npm package (v0.3.3), which ships plain JavaScript and
 * no `.d.ts`. Only the surface `packages/shared/src/fernet.ts` uses is declared.
 *
 * The package is CommonJS (`module.exports = { Secret, Token }`), so the declaration uses
 * `export =`; `packages/shared` imports it as a default (`import fernet from "fernet"`)
 * under `esModuleInterop`.
 */
declare module "fernet" {
  namespace fernet {
    class Secret {
      constructor(secret: string | Buffer, ttl?: number);
      secret: string;
      ttl: number;
    }

    interface TokenOptions {
      secret: Secret;
      ttl?: number;
      token?: string;
      time?: number;
      iv?: Buffer;
      message?: Buffer;
    }

    class Token {
      constructor(options: TokenOptions);
      encode(message?: unknown, time?: number, iv?: Buffer): string;
      decode(token?: string, ttl?: number): string;
      toString(): string;
    }
  }
  export = fernet;
}
