/** A pretend passkey device for tests: makes real WebAuthn registration and sign-in answers (ES256, "none" attestation). */
import crypto from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | Buffer | string) => crypto.createHash("sha256").update(b).digest();

export class SoftAuthenticator {
  private keys = new Map<string, { priv: crypto.KeyObject; counter: number; userHandle: string; rpId: string }>();
  constructor(public origin: string) {}

  register(options: { challenge: string; rp: { id?: string }; user: { id: string } }) {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const credId = crypto.randomBytes(16);
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))]]));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, Buffer.from(cose)]);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]) as never);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const id = b64u(credId);
    this.keys.set(id, { priv: privateKey, counter: 0, userHandle: options.user.id, rpId });
    return { id, rawId: id, type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] }, clientExtensionResults: {} };
  }

  /** Sign in with the passkey (the newest one unless an id is given). */
  login(options: { challenge: string }, id = [...this.keys.keys()].at(-1)!, opts: { origin?: string } = {}) {
    const k = this.keys.get(id)!;
    k.counter++;
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(k.counter);
    const authData = Buffer.concat([sha256(k.rpId), Buffer.from([0x05]), ctr]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: opts.origin ?? this.origin, crossOrigin: false }));
    const signature = crypto.sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), k.priv);
    return { id, rawId: id, type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: k.userHandle }, clientExtensionResults: {} };
  }
}
