"""Conservative newsletter provenance/metadata gate.

This does NOT check factual truth, independent reviewer identity, editorial quality,
source permissions, or owner approval. A clean result is NOT publication clearance.

Run: python3 -m tools.newsletter_gate --draft FILE.md --manifest FILE.json
"""
import argparse
import json
import re
from pathlib import Path

REQUIRED = ("asset_id", "status", "audience", "goal", "source_refs", "claims")
EVIDENCE_KINDS = {"primary", "external", "owner-attested"}


def _nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def audit(draft_text, manifest):
    """Check the manifest's shape and its literal relationship to the draft.

    This function intentionally accepts older manifests without draft_quote, but
    warns that their claim placement is not mechanically checked. An explicit
    draft_quote must match verbatim; changed copy must not inherit stale review.
    """
    errors, warnings = [], []
    if not isinstance(manifest, dict):
        return {"verdict": "BLOCK", "errors": ["Manifest must be an object."], "warnings": []}
    if not isinstance(draft_text, str):
        return {"verdict": "BLOCK", "errors": ["Draft must be text."], "warnings": []}

    for field in REQUIRED:
        value = manifest.get(field)
        if value is None or value == "" or value == []:
            errors.append("Missing or empty field: " + field)
    for field in ("asset_id", "audience", "goal"):
        if field in manifest and not _nonempty_string(manifest[field]):
            errors.append(field + " must be nonempty text.")

    if manifest.get("status") != "draft":
        errors.append("Pilot permits drafts only; it does not authorize publishing.")
    if "owner_approved" in manifest and manifest["owner_approved"] is not False:
        errors.append("A metadata flag cannot claim independently verified owner approval.")

    sources = manifest.get("source_refs", [])
    if not isinstance(sources, list):
        errors.append("source_refs must be a list.")
        sources = []
    source_ids = set()
    for i, entry in enumerate(sources):
        if not isinstance(entry, dict):
            errors.append("source_refs[%s] must be an object." % i)
            continue
        sid = entry.get("id")
        if not _nonempty_string(sid) or not _nonempty_string(entry.get("uri")):
            errors.append("source_refs[%s] requires nonempty string id and uri." % i)
        else:
            if sid in source_ids:
                errors.append("Duplicate source ID: " + sid)
            source_ids.add(sid)
        kind = entry.get("kind")
        if not isinstance(kind, str) or kind not in EVIDENCE_KINDS:
            errors.append("source_refs[%s] must be an approved evidence kind." % i)

    claims = manifest.get("claims", [])
    if not isinstance(claims, list):
        errors.append("claims must be a list.")
        claims = []
    claim_ids = set()
    for i, claim in enumerate(claims):
        if not isinstance(claim, dict):
            errors.append("claims[%s] must be an object." % i)
            continue
        if not _nonempty_string(claim.get("text")):
            errors.append("claims[%s] needs nonempty text." % i)

        if "id" in claim:
            cid = claim["id"]
            if not _nonempty_string(cid):
                errors.append("claims[%s] id must be nonempty text." % i)
            elif cid in claim_ids:
                errors.append("Duplicate claim ID: " + cid)
            else:
                claim_ids.add(cid)

        refs = claim.get("source_ids", [])
        if not isinstance(refs, list) or not refs:
            errors.append("claims[%s] requires source_ids." % i)
        else:
            for sid in refs:
                if not _nonempty_string(sid):
                    errors.append("claims[%s] source_ids must be nonempty strings." % i)
                elif sid not in source_ids:
                    errors.append("claims[%s] unknown source: %s" % (i, sid))

        if "draft_quote" in claim:
            quote = claim["draft_quote"]
            if not _nonempty_string(quote):
                errors.append("claims[%s] draft_quote must be nonempty text." % i)
            elif quote not in draft_text:
                errors.append("claims[%s] stale draft_quote: exact text absent from draft." % i)
        else:
            warnings.append("claims[%s] has no draft_quote; placement not checked." % i)

        if claim.get("review") != "verified":
            warnings.append("claims[%s] needs independent source review." % i)
        elif not _nonempty_string(claim.get("reviewer")):
            warnings.append("claims[%s] claims verification without reviewer reference." % i)

    has_h1 = bool(re.search(r"^#\s+\S", draft_text, re.M))
    body_without_h1 = re.sub(r"^#\s+.*$", "", draft_text, flags=re.M).strip()
    if not has_h1 or not body_without_h1:
        errors.append("Draft needs a Markdown H1 and body.")
    if re.search(r"\[(?:NEED|TODO)(?::|\])", draft_text, re.I):
        warnings.append("Draft contains an explicit source gap or placeholder.")
    if re.search(r"\b(?:in today's world|game-changer|unlock the power)\b", draft_text, re.I):
        warnings.append("Possible hype/generic phrasing requires an editorial check.")

    return {
        "verdict": "BLOCK" if errors else "READY_FOR_EDITOR_REVIEW",
        "errors": errors,
        "warnings": warnings,
        "note": (
            "Checks metadata only, plus exact draft-quote matching. Review labels and reviewer "
            "references are untrusted assertions; independent source verification, "
            "voice, privacy clearance and owner approval remain separate."
        ),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--draft", required=True, type=Path)
    p.add_argument("--manifest", required=True, type=Path)
    args = p.parse_args()
    try:
        result = audit(args.draft.read_text(encoding="utf-8"),
                       json.loads(args.manifest.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError) as exc:
        result = {"verdict": "BLOCK", "errors": [str(exc)], "warnings": []}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 1 if result["verdict"] == "BLOCK" else 0


if __name__ == "__main__":
    raise SystemExit(main())
