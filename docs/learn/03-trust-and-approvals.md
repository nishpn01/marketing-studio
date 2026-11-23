# 3. Trust and approvals

An approval started as a file: the owner ran a command with a flag, the runner wrote a record, and later steps read it. Anyone with write access to the workspace could create the same file. This chapter covers the change from a file to a signed record, and what is still missing.

This chapter is about the change from a file to a signed record, and about what is still missing.

## Two trust boundaries

There are two separate questions:

1. Can the model or a tool record a decision? It must not.
2. Can the process that owns the state tell whether the record was tampered with? It must be able to.

The first is an architecture rule. [`docs/engineering/ADR-002-studio-service-owns-state-authority-and-mcp.md`](../engineering/ADR-002-studio-service-owns-state-authority-and-mcp.md) states it plainly: MCP tools and model-reachable tools may create pending requests, but only a separate owner channel outside the model's process may write authority records.

The second is implemented in [`studio-runner/src/service/authority-store.ts`](../../studio-runner/src/service/authority-store.ts).

## Signed records and a hash chain

The `AuthorityStore` writes every authority record with an HMAC-SHA256 signature over its fields. A second table, `authority_log`, chains those records: each row signs the previous row's signature. A `head` row pins the latest sequence number and the key fingerprint.

Before authority reads that call `latest` or `active`, and before writes, the store walks the chain. It checks that every record has a valid signature, that the log references each record once, that the sequence numbers are contiguous, that each `previous_signature` matches, and that the head agrees with the log length. The constructor opens and initializes the database but does not itself run `healthy()`. Evidence: [`authority-store.ts`](../../studio-runner/src/service/authority-store.ts:24-46,55-72,74-99).

If any check fails, `writeAll` throws. The store does not repair itself and does not accept a partial history. Deleting a row breaks the length check. Editing a payload breaks its signature. Reordering breaks the chain. The failure is closed, not silent.

Deleting a row from an existing database is detected by the length and chain checks. Deleting the entire database while retaining or replacing the local key can let the Service start a fresh store. Same-OS-user replacement of the key and database is explicitly outside this boundary. Evidence: [`authority-store.ts`](../../studio-runner/src/service/authority-store.ts:24-46); [`docs/security/SCOPED-DISCLOSURE.md`](../security/SCOPED-DISCLOSURE.md).

## What HMAC proves

HMAC-SHA256 is a keyed integrity check, not encryption and not identity. It answers "did the holder of this key produce this exact record?" It does not hide the payload, and it does not say who the key holder is.

Its security depends on protecting the key. This implementation stores the key in `authority.key` with mode 0600 and checks ownership and link count. It does not protect against a same-OS-user attacker who can read that file, and it does not protect against whole-store rollback or key replacement. Those limits are documented in [`docs/security/SCOPED-DISCLOSURE.md`](../security/SCOPED-DISCLOSURE.md).

## The owner channel

[`studio-runner/src/service/owner-channel.ts`](../../studio-runner/src/service/owner-channel.ts) is the only module allowed to write owner decisions. It is deliberately not imported by the MCP tools or the CLI.

The verifier is a WebAuthn passkey. The owner registers once with a setup code printed to the terminal that started the Service. After that, each decision needs a fresh passkey assertion. The challenge is derived from the exact action, target, and content digest the owner was shown:

```ts
const challengeFor = (nonce, binding) =>
  b64(sha256(JSON.stringify([
    "studio.owner-challenge/1", nonce, binding.action, binding.target, binding.digest
  ])));
```

That binding is what stops an approval from being replayed onto a different draft. A signed approval of `v001` is not approval of `v002`, even if both are in the same run. The test suite checks this directly.

`resolve()` verifies the assertion against the binding, then writes the decision and its effects in one transaction. It also refuses a second decision for the same subject. One decision, consumed once.

## What a passkey proves

A valid WebAuthn assertion proves possession of the registered credential, required user presence or verification, and a signature over this action, target, and digest binding. It does not prove legal identity or intent beyond the authenticated UI action. HMAC detects edits only while its key remains secret; a same-OS-user process can read the key and forge a consistent store.

The key is bound to the browser and origin. The model cannot mint its own approval. An unrelated process cannot edit an approval after the fact without breaking the chain, as long as the HMAC key stays secret.

## What is still limited

The Service is local and single-user. The passkey protects the decision from other software, but it does not isolate one operating-system user from another. The process that runs the Service can still read the tenant directory. A compromised local account is outside the threat model.

The documentation is explicit about this in [`docs/security/SCOPED-DISCLOSURE.md`](../security/SCOPED-DISCLOSURE.md) and the README's security section. This is a draft-only local system, not an authenticated multi-tenant service. Chapter 4 covers the transport boundary that would have to exist before any of this is exposed to a remote host.

## Try it yourself

The owner-inbox tests exercise the passkey flow, the digest binding, and the once-only decision rule:

```sh
node --experimental-strip-types --no-warnings \
  --test studio-runner/test/owner-inbox.test.ts
```

Look for the names that matter:

- `the store consumes an owner decision exactly once, even if two completions race past the inbox`
- `a signed approval of v001 is not approval of a later or edited draft`
- `owner setup code is single-use, short-lived and closes registration`

These are not tests of a UI. They are tests of whether an approval can be forged or reused. The assertion they reject is the failure mode this chapter is about.

Next: [MCP and hosts](04-mcp-and-hosts.md).
