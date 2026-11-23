import type { OwnerAssertion, OwnerAssertionVerifier } from "../../src/service/owner-channel.ts";

/** Test-only owner assertion; production code supplies the M1.4 verifier. */
export class TestOwnerVerifier implements OwnerAssertionVerifier {
  readonly testOnly = true;
  verify(assertion: OwnerAssertion) {
    return assertion.verifier === "test-only" && assertion.subject === "test-owner" && assertion.proof === "test-assertion";
  }
  assertion(): OwnerAssertion {
    return { verifier: "test-only", subject: "test-owner", proof: "test-assertion" };
  }
}
