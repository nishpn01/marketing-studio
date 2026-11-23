/** Owner channel: the only writer of authority. MCP and CLI never import this module. */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { AuthorityStore, type AuthorityEntry, type AuthorityKind } from "./authority-store.ts";

export type OwnerAssertion = { verifier: string; subject: string; proof: string };
/** What the owner was shown and is deciding: an action on a target, pinned by the digest of the shown content. */
export type OwnerBinding = { action: string; target: string; digest: string };
export interface OwnerAssertionVerifier {
  verify(assertion: OwnerAssertion, binding?: OwnerBinding): boolean;
  readonly testOnly?: boolean;
}

export class OwnerChannel {
  private readonly store: AuthorityStore;
  private readonly verifier: OwnerAssertionVerifier;
  constructor(store: AuthorityStore, verifier: OwnerAssertionVerifier) {
    this.store = store;
    this.verifier = verifier;
  }
  /** Unbound write, kept for test provisioning. A WebAuthn verifier refuses every assertion that has no binding. */
  decide(kind: AuthorityKind, subject: string, payload: Record<string, unknown>, assertion: OwnerAssertion) {
    if (!this.verifier.verify(assertion)) throw new Error("Owner assertion rejected");
    return this.store.write(kind, subject, { ...payload, owner_subject: assertion.subject });
  }
  /** Verifies the assertion against the binding, then records the decision and its effects once, atomically. */
  resolve(binding: OwnerBinding, assertion: OwnerAssertion, effects: AuthorityEntry[], notes?: string) {
    if (!this.verifier.verify(assertion, binding)) throw new Error("Owner assertion rejected");
    const owner = { owner_subject: assertion.subject, owner_binding: binding };
    return this.store.writeAll([
      { kind: "owner_decision", subject: binding.target, payload: { ...binding, ...(notes ? { notes } : {}), owner_subject: assertion.subject, decided_at: new Date().toISOString() } },
      ...effects.map((effect) => ({ ...effect, payload: { ...effect.payload, ...owner } })),
    ], binding.target);
  }
}

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest();
const b64 = (value: Buffer) => value.toString("base64url");
const unb64 = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url");
  return Buffer.from(value, "base64url");
};
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const challengeFor = (nonce: string, binding: OwnerBinding) =>
  b64(sha256(JSON.stringify(["studio.owner-challenge/1", nonce, binding.action, binding.target, binding.digest])));
/** Minimal CBOR reader for a COSE key: unsigned and negative ints, byte and text strings, maps. Returns [value, next offset]. */
function cbor(buf: Buffer, pos: number, depth = 0): [unknown, number] {
  if (pos >= buf.length || depth > 4) throw new Error("Invalid COSE key");
  const major = buf[pos] >> 5, info = buf[pos] & 31;
  pos += 1;
  let n: number;
  if (info < 24) n = info;
  else if (info === 24) { n = buf.readUInt8(pos); pos += 1; }
  else if (info === 25) { n = buf.readUInt16BE(pos); pos += 2; }
  else if (info === 26) { n = buf.readUInt32BE(pos); pos += 4; }
  else throw new Error("Invalid COSE key");
  if (major === 0) return [n, pos];
  if (major === 1) return [-1 - n, pos];
  if (major === 2 || major === 3) {
    if (pos + n > buf.length) throw new Error("Invalid COSE key");
    return [major === 2 ? buf.subarray(pos, pos + n) : buf.toString("utf8", pos, pos + n), pos + n];
  }
  if (major === 5) {
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < n; i++) {
      const [key, afterKey] = cbor(buf, pos, depth + 1);
      const [value, afterValue] = cbor(buf, afterKey, depth + 1);
      map.set(key, value);
      pos = afterValue;
    }
    return [map, pos];
  }
  throw new Error("Invalid COSE key");
}
/** SPKI DER of the COSE EC2 credential public key at offset; refuses anything but ES256 on P-256. */
function coseEs256Spki(data: Buffer, offset: number) {
  const [key] = cbor(data, offset);
  if (!(key instanceof Map)) throw new Error("Invalid COSE key");
  const x = key.get(-2), y = key.get(-3);
  if (key.get(1) !== 2 || key.get(3) !== ES256 || key.get(-1) !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32)
    throw new Error("Only ES256 passkeys are supported");
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(x), y: b64(y) }, format: "jwk" }).export({ format: "der", type: "spki" });
}
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40, ES256 = -7;
const CHALLENGE_TTL_MS = 2 * 60_000, SETUP_TTL_MS = 10 * 60_000, SETUP_ATTEMPTS = 5;
type Credential = { credential_id: string; public_key: string; sign_count: number };
type ClientData = { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };

/**
 * WebAuthn (passkey) verifier, ES256 only, attestation "none". The owner registers once with a setup code printed to
 * the terminal that started the Service; every authority action then needs a fresh assertion whose challenge is
 * derived from the exact action, target and content digest the owner was shown.
 */
export class WebAuthnOwnerVerifier implements OwnerAssertionVerifier {
  readonly rpId = "localhost";
  private origin = "";
  private readonly store: AuthorityStore;
  private readonly challenges = new Map<string, { nonce: string; expires: number }>();
  // Wrong-code attempts are counted per client (inbox CSRF session + address), so another local client cannot lock the owner out.
  // ponytail: no global cap; a 120-bit code that expires in 10 minutes is the brute-force bound. Add a global window if codes get shorter.
  private setup: { codeHash: Buffer; expires: number; failures: Map<string, number>; challenge: string | null } | null = null;
  constructor(store: AuthorityStore) { this.store = store; }

  listening(port: number) { this.origin = "http://localhost:" + port; }
  credential(): Credential | null {
    const row = this.store.latest("owner_credential", "owner");
    return row && typeof row.credential_id === "string" && typeof row.public_key === "string" && Number.isInteger(row.sign_count)
      ? { credential_id: row.credential_id, public_key: row.public_key, sign_count: row.sign_count as number } : null;
  }
  /** A fresh single-use setup code that replaces any earlier one, or null once an owner passkey exists. */
  setupCode() {
    if (this.credential()) return null;
    const code = b64(randomBytes(15));
    this.setup = { codeHash: sha256(code), expires: Date.now() + SETUP_TTL_MS, failures: new Map(), challenge: null };
    return code;
  }
  private setupValid(code: unknown, clientKey: string) {
    const setup = this.setup, failures = setup?.failures.get(clientKey) ?? 0;
    if (!setup || typeof code !== "string" || setup.expires < Date.now() || failures >= SETUP_ATTEMPTS || this.credential()) return false;
    if (sameBytes(sha256(code), setup.codeHash)) return true;
    setup.failures.set(clientKey, failures + 1);
    return false;
  }
  registrationOptions(code: unknown, clientKey = "") {
    if (!this.setupValid(code, clientKey)) throw new Error("Setup code is invalid or expired");
    this.setup!.challenge = b64(randomBytes(32));
    return {
      challenge: this.setup!.challenge,
      rp: { id: this.rpId, name: "Marketing Studio owner inbox" },
      user: { id: b64(randomBytes(16)), name: "owner", displayName: "Studio owner" },
      pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      attestation: "none",
      timeout: CHALLENGE_TTL_MS,
    };
  }
  register(code: unknown, response: Record<string, unknown>, clientKey = "") {
    const challenge = this.setup?.challenge;
    if (!this.setupValid(code, clientKey) || !challenge) throw new Error("Setup code is invalid or expired");
    this.setup!.challenge = null;
    const clientRaw = unb64(response.client_data_json), client = JSON.parse(clientRaw.toString("utf8")) as ClientData;
    if (client.type !== "webauthn.create" || client.challenge !== challenge || client.origin !== this.origin || client.crossOrigin === true) throw new Error("Registration client data does not match");
    const data = unb64(response.authenticator_data), credentialId = unb64(response.credential_id);
    if (data.length < 55 || !sameBytes(data.subarray(0, 32), sha256(this.rpId))) throw new Error("Registration is for another relying party");
    if ((data[32] & (FLAG_UP | FLAG_UV | FLAG_AT)) !== (FLAG_UP | FLAG_UV | FLAG_AT)) throw new Error("Registration needs user presence and verification");
    const length = data.readUInt16BE(53);
    if (!credentialId.length || !sameBytes(data.subarray(55, 55 + length), credentialId)) throw new Error("Credential id does not match");
    // The stored key comes from the authenticator's own COSE credential public key; the browser's SPKI copy must equal it.
    const spki = coseEs256Spki(data, 55 + length);
    if (response.public_key_algorithm !== ES256 || !sameBytes(unb64(response.public_key), spki)) throw new Error("Public key does not match the attested credential");
    this.store.write("owner_credential", "owner", { credential_id: b64(credentialId), public_key: b64(spki), sign_count: data.readUInt32BE(33), registered_at: new Date().toISOString() });
    this.setup = null;
    return { credential_id: b64(credentialId) };
  }
  /** Request options for one assertion; the challenge commits to the binding. */
  challenge(binding: OwnerBinding) {
    const credential = this.credential();
    if (!credential) throw new Error("No owner passkey is registered");
    const now = Date.now();
    for (const [key, value] of this.challenges) if (value.expires < now) this.challenges.delete(key);
    const nonce = b64(randomBytes(32)), challenge = challengeFor(nonce, binding);
    this.challenges.set(challenge, { nonce, expires: now + CHALLENGE_TTL_MS });
    return { challenge, rpId: this.rpId, allowCredentials: [{ type: "public-key", id: credential.credential_id }], userVerification: "required", timeout: CHALLENGE_TTL_MS };
  }
  assertionFrom(response: Record<string, unknown>): OwnerAssertion {
    return { verifier: "webauthn", subject: "passkey:" + String(response.credential_id).slice(0, 22), proof: JSON.stringify(response) };
  }
  verify(assertion: OwnerAssertion, binding?: OwnerBinding) {
    if (!binding || assertion.verifier !== "webauthn") return false;
    try {
      const proof = JSON.parse(assertion.proof) as Record<string, unknown>;
      const clientRaw = unb64(proof.client_data_json), client = JSON.parse(clientRaw.toString("utf8")) as ClientData;
      if (typeof client.challenge !== "string") return false;
      const issued = this.challenges.get(client.challenge);
      this.challenges.delete(client.challenge); // single use, whether or not the rest verifies
      if (!issued || issued.expires < Date.now() || challengeFor(issued.nonce, binding) !== client.challenge) return false;
      if (client.type !== "webauthn.get" || client.origin !== this.origin || client.crossOrigin === true) return false;
      const credential = this.credential();
      if (!credential || proof.credential_id !== credential.credential_id || assertion.subject !== "passkey:" + credential.credential_id.slice(0, 22)) return false;
      const data = unb64(proof.authenticator_data);
      if (data.length < 37 || !sameBytes(data.subarray(0, 32), sha256(this.rpId))) return false;
      if (!(data[32] & FLAG_UP) || !(data[32] & FLAG_UV)) return false;
      const counter = data.readUInt32BE(33);
      if ((counter !== 0 || credential.sign_count !== 0) && counter <= credential.sign_count) return false;
      const key = createPublicKey({ key: unb64(credential.public_key), format: "der", type: "spki" });
      if (!verifySignature("sha256", Buffer.concat([data, sha256(clientRaw)]), key, unb64(proof.signature))) return false;
      if (counter > credential.sign_count) this.store.write("owner_credential", "owner", { ...credential, sign_count: counter });
      return true;
    } catch { return false; }
  }
}
