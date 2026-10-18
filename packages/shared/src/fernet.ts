/**
 * packages/shared/src/fernet.ts
 *
 * Evidence: relayx-analysis/work/shared/002__packages__shared__src__fernet.ts:1-30
 *
 * Wraps the `fernet` npm package. Two behavioural details are load-bearing for the
 * replica and must not be "fixed":
 *   - `encrypt` uses the library default TTL (60s) metadata inside the token;
 *   - `decrypt` passes `ttl: 0`, i.e. it accepts arbitrarily old tokens.
 * The node agent's config payloads are decrypted through this path, so a stricter
 * TTL would break long-offline nodes.
 */
import fernet from "fernet";

export class FernetService {
  private readonly secret: fernet.Secret;

  constructor(secret: string) {
    this.secret = new fernet.Secret(secret);
  }

  encrypt(data: string): string {
    const token = new fernet.Token({ secret: this.secret });
    return token.encode(data);
  }

  decrypt(data: string): string {
    const token = new fernet.Token({ secret: this.secret, ttl: 0 });
    return token.decode(data);
  }
}
