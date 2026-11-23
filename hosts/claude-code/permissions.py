"""Merge Marketing Studio permission rules into <.claude dir>/settings.json (target project only).
Usage: python3 permissions.py <.claude dir> <studio_bin>
Host UX guidance, not enforcement: see docs/hosts/HOST-PERMISSIONS.md."""
import json, sys
from pathlib import Path

# Commands that carry owner authority, spend model calls, or change a grant/approval. Always ask.
ASK = ["source-disclosure-grant", "source-disclosure-revoke", "capture-disclosure-grant", "capture-disclosure-revoke",
       "capture-disclosure-read", "capture-import", "capture-annotate", "direction-approve", "approve", "improvement-decide",
       "improvement-propose", "session-run", "session-rerun", "run", "resume", "revise", "cancel", "handoff-check", "eval", "onboard"]
# Read-only or discussion-state commands. Allowed only for the installed studio binary.
ALLOW = ["session-start", "session-status", "session-note", "context-sync", "context-search", "evidence-add",
         "evidence-remove", "improvement-list", "improvement-handoff", "improvement-record", "improvement-close",
         "capture-list", "capture-show", "source-disclosure-list", "status", "inspect", "doctor", "handoff-prompt", "handoff-score"]
FLAGS = ["--allow-dirty-pins", "--owner-quote", "--visibility", "--authorization"]

def rules(bin_):
    ask = [f"Bash(*studio* {c}*)" for c in ASK] + [f"Bash(*{f}*)" for f in FLAGS]
    allow = []
    for c in ALLOW:  # bare and quoted-path forms, so a path with spaces still matches
        allow += [f"Bash({bin_} {c}*)", f'Bash("{bin_}" {c}*)']
    return ask, allow

if __name__ == "__main__":
    d, bin_ = Path(sys.argv[1]), sys.argv[2]
    f = d / "settings.json"
    s = json.loads(f.read_text()) if f.exists() else {}
    p = s.setdefault("permissions", {})
    ask, allow = rules(bin_)
    for k, v in (("ask", ask), ("allow", allow)):
        p[k] = list(dict.fromkeys(p.get(k, []) + v))
    d.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(s, indent=2) + "\n")
