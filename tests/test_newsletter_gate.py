import unittest
from tools.newsletter_gate import audit


class NewsletterGateTests(unittest.TestCase):
    def valid(self):
        return {
            "asset_id": "generic-fixture",
            "status": "draft",
            "audience": "Someone reading a practical newsletter",
            "goal": "Explain a documented decision",
            "source_refs": [{"id": "primary", "uri": "private://example/source", "kind": "primary"}],
            "claims": [{"text": "We tested a workflow.", "source_ids": ["primary"], "review": "verified"}]
        }

    def test_valid_is_only_ready_for_editor(self):
        result = audit("# Real finding\n\nA source-linked observation.", self.valid())
        self.assertEqual(result["verdict"], "READY_FOR_EDITOR_REVIEW")
        self.assertIn("metadata only", result["note"])

    def test_missing_source_blocks(self):
        m = self.valid()
        m["claims"][0]["source_ids"] = ["absent"]
        self.assertEqual(audit("# Finding\n\nBody.", m)["verdict"], "BLOCK")

    def test_published_is_not_permitted(self):
        m = self.valid()
        m["status"] = "published"
        self.assertEqual(audit("# Finding\n\nBody.", m)["verdict"], "BLOCK")

    def test_generated_draft_not_evidence(self):
        m = self.valid()
        m["source_refs"][0]["kind"] = "generated-draft"
        self.assertEqual(audit("# Finding\n\nBody.", m)["verdict"], "BLOCK")

    def test_placeholder_warning(self):
        r = audit("# Finding\n\n[NEED: actual result]", self.valid())
        self.assertTrue(any("placeholder" in w for w in r["warnings"]))

    def test_duplicate_source_id_blocks(self):
        m = self.valid()
        m["source_refs"].append({"id": "primary", "uri": "private://duplicate", "kind": "primary"})
        self.assertEqual(audit("# Finding\n\nBody.", m)["verdict"], "BLOCK")


    def test_matching_draft_quote_is_accepted(self):
        m = self.valid()
        m["claims"][0]["draft_quote"] = "A source-linked observation."
        m["claims"][0]["reviewer"] = "independent-reviewer-ref"
        r = audit("# Real finding\n\nA source-linked observation.", m)
        self.assertEqual(r["verdict"], "READY_FOR_EDITOR_REVIEW")
        self.assertEqual(r["errors"], [])

    def test_revised_draft_does_not_inherit_stale_claim_review(self):
        # Regression for a real editorial run: the claim is still marked
        # verified, but editing changed its literal passage.
        m = self.valid()
        m["claims"][0]["draft_quote"] = "Four fixes over about six weeks."
        m["claims"][0]["reviewer"] = "some-reviewer"
        r = audit("# Finding\n\nSeveral changes over about six weeks.", m)
        self.assertEqual(r["verdict"], "BLOCK")
        self.assertTrue(any("stale draft_quote" in e for e in r["errors"]))

    def test_blank_quote_blocks(self):
        m = self.valid()
        m["claims"][0]["draft_quote"] = " "
        self.assertEqual(audit("# Finding\n\nBody.", m)["verdict"], "BLOCK")

    def test_unquoted_legacy_claim_warns_but_remains_draft_compatible(self):
        r = audit("# Finding\n\nA source-linked observation.", self.valid())
        self.assertEqual(r["verdict"], "READY_FOR_EDITOR_REVIEW")
        self.assertTrue(any("placement not checked" in w for w in r["warnings"]))

    def test_review_label_without_reviewer_is_not_silent_success(self):
        r = audit("# Finding\n\nBody.", self.valid())
        self.assertTrue(any("without reviewer reference" in w for w in r["warnings"]))
        self.assertIn("untrusted assertions", r["note"])

    def test_duplicate_claim_id_blocks(self):
        m = self.valid()
        m["claims"][0]["id"] = "claim-one"
        m["claims"].append({"id": "claim-one", "text": "Another claim.", "source_ids": ["primary"], "review": "pending"})
        r = audit("# Finding\n\nBody.", m)
        self.assertEqual(r["verdict"], "BLOCK")
        self.assertTrue(any("Duplicate claim ID" in e for e in r["errors"]))

    def test_malformed_source_id_is_a_block_not_an_exception(self):
        m = self.valid()
        m["claims"][0]["source_ids"] = [["unhashable"]]
        r = audit("# Finding\n\nBody.", m)
        self.assertEqual(r["verdict"], "BLOCK")
        self.assertTrue(any("nonempty strings" in e for e in r["errors"]))

    def test_malformed_source_ref_is_a_block_not_an_exception(self):
        m = self.valid()
        m["source_refs"][0]["id"] = ["bad"]
        r = audit("# Finding\n\nBody.", m)
        self.assertEqual(r["verdict"], "BLOCK")

    def test_claim_non_text_is_blocked(self):
        m = self.valid()
        m["claims"][0]["text"] = {"bad": "value"}
        self.assertEqual(audit("# Finding\n\nBody.", m)["verdict"], "BLOCK")

    def test_bad_draft_input_blocks(self):
        self.assertEqual(audit(None, self.valid())["verdict"], "BLOCK")

    def test_pending_claim_stays_in_review_even_if_quote_matches(self):
        m = self.valid()
        m["claims"][0]["review"] = "pending"
        m["claims"][0]["draft_quote"] = "Body."
        r = audit("# Finding\n\nBody.", m)
        self.assertEqual(r["verdict"], "READY_FOR_EDITOR_REVIEW")
        self.assertTrue(any("needs independent source review" in w for w in r["warnings"]))

    def test_empty_sources_or_claims_blocks(self):
        m = self.valid()
        m["claims"] = []
        self.assertEqual(audit("# Finding\n\nBody.", m)["verdict"], "BLOCK")
        m = self.valid()
        m["source_refs"] = []
        self.assertEqual(audit("# Finding\n\nBody.", m)["verdict"], "BLOCK")



    def test_invalid_evidence_kind_type_blocks_without_crash(self):
        m = self.valid()
        m["source_refs"][0]["kind"] = ["invalid"]
        r = audit("# Finding\n\nBody.", m)
        self.assertEqual(r["verdict"], "BLOCK")
        self.assertTrue(any("evidence kind" in e for e in r["errors"]))

    def test_model_supplied_owner_approval_is_rejected_even_as_text(self):
        m = self.valid()
        m["owner_approved"] = "true"
        r = audit("# Finding\n\nBody.", m)
        self.assertEqual(r["verdict"], "BLOCK")
        self.assertTrue(any("owner approval" in e for e in r["errors"]))



    def test_title_only_draft_is_not_real_content(self):
        r = audit("# Title only", self.valid())
        self.assertEqual(r["verdict"], "BLOCK")
        self.assertTrue(any("H1 and body" in e for e in r["errors"]))

    def test_unknown_claim_reviewer_reference_does_not_count_as_approval(self):
        m = self.valid()
        m["claims"][0]["reviewer"] = "some-model"
        m["claims"][0]["draft_quote"] = "Body."
        r = audit("# Finding\n\nBody.", m)
        self.assertEqual(r["verdict"], "READY_FOR_EDITOR_REVIEW")
        self.assertIn("untrusted assertions", r["note"])



if __name__ == "__main__":
    unittest.main()
