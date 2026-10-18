import { FernetService } from "@relayx/shared/fernet";
import { CONFIG_SECRET } from "../config";

/**
 * Upstream: src/services/fernet.ts. The same fernet implementation as
 * packages/shared/src/fernet.ts, keyed with the deployment secret. Used to encrypt the
 * license blob in Redis and every agent config pushed over Socket.IO.
 */
export const fernetService = new FernetService(CONFIG_SECRET);
