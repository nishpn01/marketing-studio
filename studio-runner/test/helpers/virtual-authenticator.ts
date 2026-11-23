/** Software WebAuthn authenticator (ES256, attestation "none") for tests. Each override breaks one property. */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest();
const b64 = (value: Buffer) => value.toString("base64url");
export type AssertOverrides = { origin?: string; rpId?: string; flags?: number; counter?: number; type?: string; challenge?: string; resign?: boolean; foreignKey?: boolean; coseAlg?: number };

export class VirtualAuthenticator {
  readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly credentialId = randomBytes(16);
  readonly origin: string;
  readonly rpId: string;
  counter: number;
  constructor(origin: string, counter = 0, rpId = "localhost") {
    this.origin = origin;
    this.counter = counter;
    this.rpId = rpId;
  }
  private authData(rpId: string, flags: number, counter: number, attested?: Buffer) {
    const head = Buffer.alloc(37);
    sha256(rpId).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(counter, 33);
    return attested ? Buffer.concat([head, attested]) : head;
  }
  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  register(options: { challenge: string }, o: AssertOverrides = {}) {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    // COSE EC2 key {1:2, 3:-7, -1:1, -2:x, -3:y}, CBOR-encoded by hand.
    const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, o.coseAlg === undefined ? 0x26 : 0x20 + (-1 - o.coseAlg), 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x!, "base64url"), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y!, "base64url")]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), length, this.credentialId, cose]);
    return {
      credential_id: b64(this.credentialId),
      client_data_json: b64(this.clientData(o.type ?? "webauthn.create", o.challenge ?? options.challenge, o.origin ?? this.origin)),
      authenticator_data: b64(this.authData(o.rpId ?? this.rpId, o.flags ?? 0x45, o.counter ?? this.counter, attested)),
      public_key: b64((o.foreignKey ? generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey : this.keys.publicKey).export({ format: "der", type: "spki" })),
      public_key_algorithm: -7,
    };
  }
  /** Signs an assertion over authenticatorData || sha256(clientDataJSON), advancing the counter like hardware would. */
  assert(options: { challenge: string }, o: AssertOverrides = {}) {
    if (o.counter === undefined && this.counter > 0) this.counter += 1;
    const data = this.authData(o.rpId ?? this.rpId, o.flags ?? 0x05, o.counter ?? this.counter);
    const client = this.clientData(o.type ?? "webauthn.get", o.challenge ?? options.challenge, o.origin ?? this.origin);
    const key = o.resign ? generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey : this.keys.privateKey;
    return {
      credential_id: b64(this.credentialId),
      client_data_json: b64(client),
      authenticator_data: b64(data),
      signature: b64(sign("sha256", Buffer.concat([data, sha256(client)]), key)),
    };
  }
}
