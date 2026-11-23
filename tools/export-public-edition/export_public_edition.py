#!/usr/bin/env python3
"""Build the allowlisted, privacy-scanned Marketing Studio public edition.

The exporter deliberately starts from tracked files in the private repository,
then applies a small, named set of public-edition substitutions.  It never
copies a business workspace, local agent installation, pilot, or run artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


TOP_LEVEL_FILES = {"AGENTS.md", "CLAUDE.md", ".gitignore"}
GENERATED_AGENT_SKILLS = {
    ".agents/skills/marketing-director-cli/SKILL.md",
    ".agents/skills/marketing-director/SKILL.md",
    ".agents/skills/studio-idea/SKILL.md",
}
TOOL_RELATIVE = "tools/export-public-edition/export_public_edition.py"
EXPORT_MANIFEST = "EXPORT-MANIFEST.json"
SCAN_POLICY_VERSION = "msc-public-scan/2"
ALLOWED_DOC_FILES = {
    "AGENT-OR-WORKFLOW.md",
    "ANYWHERE.md",
    "ARCHITECTURE.md",
    "BUILD-LOG.md",
    "DECISIONS.md",
    "DEMO.md",
    "GETTING-STARTED.md",
    "LEARNING-LOOP.md",
    "RELEASE-NOTES-v0.5.md",
    "ROADMAP.md",
}
ALLOWED_OPERATION_FILES = {
    "AUTHORITY-AND-CAPABILITY-STATUS.md",
    "HOST-ACCEPTANCE.md",
    "LINEAR-AND-HANDOFFS.md",
    "QUALITY-EVOLUTION.md",
    "SEPARATE-USER-INSTALL.md",
}
ALLOWED_ENGINEERING_FILES = {
    "ADR-001-runner-execution-stack.md",
    "ADR-002-studio-service-owns-state-authority-and-mcp.md",
    "ADR-003-model-provider-policy-reversal.md",
}
ALLOWED_SECURITY_FILES = {"SCOPED-DISCLOSURE.md"}
EXCLUDED_SKILL_FILES = {"skills/copywriting/FULL-COURSE-STUDY.md"}
EXCLUDED_DIRS = {
    ".opencode",
    "docs/archive",
    "pilots",
    "workspace-private",
    "private",
    "tenant-data",
    "session-transcripts",
    "credentials",
    ".secrets",
}
TEXT_SUFFIXES = {
    ".json",
    ".md",
    ".py",
    ".rules",
    ".sh",
    ".ts",
    ".js",
    ".mjs",
    ".yaml",
    ".yml",
    ".txt",
}

ALLOWLIST_POLICY = {
    "top_level_files": sorted(TOP_LEVEL_FILES),
    "generated_agent_skills": sorted(GENERATED_AGENT_SKILLS),
    "documentation_roots": ["docs/learn", "docs/hosts"],
    "documentation_files": sorted(ALLOWED_DOC_FILES),
    "operation_files": sorted(ALLOWED_OPERATION_FILES),
    "engineering_files": sorted(ALLOWED_ENGINEERING_FILES),
    "security_files": sorted(ALLOWED_SECURITY_FILES),
    "public_roots": [
        "core",
        "evaluations",
        "hosts",
        "packs",
        "skills",
        "specialists/newsletter",
        "specialists/copywriting",
        "studio-runner",
        "templates",
        "tests",
        "tools",
    ],
    "excluded_directories": sorted(EXCLUDED_DIRS),
    "excluded_files": sorted(EXCLUDED_SKILL_FILES),
}

MIT_LICENSE = """MIT License

Copyright (c) 2026 Marketing Studio contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the \"Software\"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


def rel_text(path: Path) -> str:
    return path.as_posix()


def is_under(rel: str, prefix: str) -> bool:
    return rel == prefix or rel.startswith(prefix + "/")


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_output(source: Path, arguments: list[str]) -> str:
    result = subprocess.run(
        ["git", "-C", str(source), *arguments],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout


def source_snapshot(source: Path, approved_readme: Path) -> dict[str, Any]:
    """Resolve the exact committed input and reject index/worktree additions."""
    if not (source / ".git").exists() and not git_output(source, ["rev-parse", "--is-inside-work-tree"]).strip() == "true":
        raise RuntimeError("source is not a Git worktree")
    status = git_output(source, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"])
    if status:
        raise RuntimeError("source must be clean and contain no tracked, untracked, or ignored changes")
    commit = git_output(source, ["rev-parse", "--verify", "HEAD^{commit}"]).strip()
    tree = git_output(source, ["rev-parse", "--verify", "HEAD^{tree}"]).strip()
    entries: dict[str, dict[str, str]] = {}
    raw_tree = subprocess.run(
        ["git", "-C", str(source), "ls-tree", "-r", "-z", commit],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout
    for raw_entry in raw_tree.split(b"\0"):
        if not raw_entry:
            continue
        header, raw_path = raw_entry.split(b"\t", 1)
        mode, kind, object_id = header.decode("ascii").split(" ")
        rel = raw_path.decode("utf-8")
        if kind != "blob":
            raise RuntimeError(f"source contains unsupported Git object at {rel}")
        entries[rel] = {"mode": mode, "object": object_id}

    try:
        approved_rel = approved_readme.relative_to(source).as_posix()
    except ValueError as exc:
        raise RuntimeError("approved README must be a file in the committed source") from exc
    if approved_rel not in entries or not approved_readme.is_file() or approved_readme.is_symlink():
        raise RuntimeError("approved README must be a tracked regular file in the committed source")
    if TOOL_RELATIVE not in entries:
        raise RuntimeError(f"committed source is missing {TOOL_RELATIVE}")
    for rel in entries:
        path = source / rel
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"committed source contains a non-regular path: {rel}")
    return {
        "commit": commit,
        "tree": tree,
        "entries": entries,
        "approved_readme": approved_rel,
    }


def allowed_path(rel: str) -> bool:
    if rel in GENERATED_AGENT_SKILLS:
        return True
    if rel in TOP_LEVEL_FILES or rel.startswith(".github/"):
        return True
    if rel.startswith("docs/"):
        parts = rel.split("/")
        if len(parts) == 2:
            return parts[1] in ALLOWED_DOC_FILES
        if parts[1] in {"learn", "hosts"}:
            return True
        if parts[1] == "operations":
            return len(parts) == 3 and parts[2] in ALLOWED_OPERATION_FILES
        if parts[1] == "engineering":
            return len(parts) == 3 and parts[2] in ALLOWED_ENGINEERING_FILES
        if parts[1] == "research":
            return rel == "docs/research/NEWSLETTER-EDUCATION-ASSESSMENT.md"
        if parts[1] == "security":
            return len(parts) == 3 and parts[2] in ALLOWED_SECURITY_FILES
        return False
    if rel.startswith("core/") or rel.startswith("evaluations/"):
        return True
    if rel.startswith("hosts/") or rel.startswith("packs/"):
        return True
    if rel.startswith("skills/"):
        return rel not in EXCLUDED_SKILL_FILES
    if rel.startswith("specialists/"):
        return is_under(rel, "specialists/newsletter") or is_under(rel, "specialists/copywriting")
    if rel.startswith("studio-runner/"):
        return not is_under(rel, "studio-runner/examples")
    if rel.startswith("templates/") or rel.startswith("tests/") or rel.startswith("tools/"):
        return True
    return False


def tracked_files(snapshot: dict[str, Any]) -> list[Path]:
    return [Path(rel) for rel in sorted(snapshot["entries"])]


def public_course_text(text: str) -> str:
    """Keep method synthesis while removing third-party course provenance/links."""
    text = re.sub(r"\[([^\]]+)\]\((?:https?://[^)]+|FULL-COURSE-STUDY\.md)\)", r"\1", text)
    text = re.sub(r"https?://\S+", "", text)
    text = text.replace("Alex Myatt", "the source instructor")
    text = text.replace("Copy That!", "source-derived copywriting methods")
    text = text.replace("FULL-COURSE-STUDY.md", "the omitted source study")
    text = text.replace("YouTubeToTranscript", "the omitted transcript source")
    return text


def substitute_public_text(rel: str, text: str) -> str:
    if rel in {
        "skills/copywriting/SKILL.md",
        "skills/copywriting/RESEARCH-WORKFLOW.md",
        "skills/copywriting/STRATEGY-CHECK.md",
        "docs/research/NEWSLETTER-EDUCATION-ASSESSMENT.md",
    }:
        text = public_course_text(text)

    # The approved README is copied separately and is only path-adjusted by the
    # caller.  This keeps its approved wording intact.
    if rel != "studio-runner/test/rules-copies.test.ts":
        text = re.sub(r"\bHiredStack\b", "an example tenant", text, flags=re.IGNORECASE)
        text = re.sub(r"\bSimplyCareer\b", "an example product", text, flags=re.IGNORECASE)
        text = re.sub(r"\bnishpn01\b", "example-owner", text, flags=re.IGNORECASE)
        text = re.sub(r"\bPranish\b", "the owner", text, flags=re.IGNORECASE)
    text = re.sub(r"\bCAR-\d+\b", "the tracked authority milestone", text)
    text = re.sub(r"\bDAP-\d+\b", "the tracked review item", text)
    if rel not in {
        "studio-runner/src/separate-user-install.ts",
        "studio-runner/test/separate-user-install.test.ts",
    }:
        text = re.sub(r"/Users/[A-Za-z0-9._-]+", "<user-home>", text)

    if rel == "docs/GETTING-STARTED.md":
        text = text.replace(
            "https://github.com/example-owner/marketing-studio-core.git",
            "https://github.com/example-owner/marketing-studio-core.git",
        )

    if rel == "specialists/newsletter/AGENT.md":
        text = re.sub(r"\s+and \[pilot\]\(../../pilots/newsletter-v1/PLAN\.md\)", "", text)

    if rel == "studio-runner/test/rules-copies.test.ts":
        text = re.sub(r"an example tenant", "source-private-tenant", text, flags=re.IGNORECASE)
        text = text.replace(
            ", '.agents/skills/marketing-director-cli/SKILL.md'",
            "",
        )
        text = text.replace(
            ", 'pilots'",
            "",
        )
        text = text.replace(
            "roots.flatMap(walk)) assert.doesNotMatch",
            "roots.flatMap(walk).filter(file => file !== 'tools/export-public-edition/export_public_edition.py')) assert.doesNotMatch",
        )

    if rel == "studio-runner/test/capability-packs.test.ts":
        golden_hashes = {
            # Public method substitutions deliberately change these pinned
            # system prompts; the corresponding eval recordings are re-keyed.
            "1575310a1fefce93458efb3977504f1974c7f440529bb5c04863fa6b9349250c": "5505dcded93a182c027c6278f34c5f55278498454108e30a007b5354d7fb5ced",
            "eed3712c00d06cc55961942d80663782f11996abe99f9a6c679b21a6bc68456a": "7e94236830c8b747b5f57a457956c69cc72c595ca592b0e6238b271de10926be",
            "6213b4232767f5b42020ed98526cf5fe544dd921e69911acea9533c51ff73f51": "05da4abb859a17b532770fc2923da69f1c04b379d9590910d25fe32d87e599c4",
        }
        for old, new in golden_hashes.items():
            text = text.replace(old, new)

    if rel == "studio-runner/README.md":
        text = text.replace(
            "Results: [E5 results](../docs/engineering/RUNNER-E5-RESULTS-2026-11-11.md).",
            "Results: covered by the checked-in Runner tests.",
        )
        text = text.replace(
            "Results: [E6 results](../docs/engineering/RUNNER-E6-RESULTS-2026-11-11.md).",
            "Results: covered by the checked-in Runner tests.",
        )
        text = text.replace(
            "review [E0–E6 and 30 acceptance cases](../docs/engineering/RUNNER-ACCEPTANCE-PLAN.md)",
            "review the checked-in Runner tests",
        )

    return text


def approved_readme_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    # Only fix links if the approved README points at a path not shipped by the
    # allowlist.  The current approved README needs no wording changes.
    return text


def copy_allowlist(source: Path, target: Path, approved_readme: Path, snapshot: dict[str, Any]) -> list[str]:
    files = tracked_files(snapshot)
    copied: list[str] = []
    for path in files:
        rel = rel_text(path)
        if rel == "README.md":
            continue
        if not allowed_path(rel):
            continue
        if rel in EXCLUDED_SKILL_FILES or any(is_under(rel, d) for d in EXCLUDED_DIRS):
            continue
        src = source / path
        if src.is_symlink() or not src.is_file():
            raise RuntimeError(f"refusing non-regular allowlisted path: {rel}")
        dst = target / path
        dst.parent.mkdir(parents=True, exist_ok=True)
        raw = src.read_bytes()
        try:
            source_text = raw.decode("utf-8")
        except UnicodeDecodeError:
            source_text = None
        if source_text is not None and b"\0" not in raw:
            dst.write_text(substitute_public_text(rel, source_text), encoding="utf-8")
        else:
            shutil.copy2(src, dst)
        os.chmod(dst, stat.S_IMODE(src.stat().st_mode))
        copied.append(rel)

    dst_readme = target / "README.md"
    dst_readme.write_text(approved_readme_text(approved_readme), encoding="utf-8")
    os.chmod(dst_readme, 0o644)
    copied.append("README.md")
    license_path = target / "LICENSE"
    license_path.write_text(MIT_LICENSE, encoding="utf-8")
    os.chmod(license_path, 0o644)
    copied.append("LICENSE")
    return sorted(set(copied))


def output_file_records(target: Path, snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for path in sorted(target.rglob("*")):
        if (
            not path.is_file()
            or ".git" in path.parts
            or "node_modules" in path.parts
            or "__pycache__" in path.parts
            or is_under(path.relative_to(target).as_posix(), "evaluations/results")
        ):
            continue
        rel = path.relative_to(target).as_posix()
        record: dict[str, Any] = {
            "path": rel,
            "mode": format(stat.S_IMODE(path.stat().st_mode), "04o"),
            "sha256": sha256_file(path),
        }
        source_entry = snapshot["entries"].get(rel)
        if source_entry is not None:
            record["source_object"] = source_entry["object"]
            record["source_mode"] = source_entry["mode"]
        else:
            record["generated"] = True
        records.append(record)
    return records


def scan_policy_digest() -> str:
    descriptor = {
        "version": SCAN_POLICY_VERSION,
        "text_detection": "scan every regular UTF-8 file without a NUL byte; report non-UTF-8 files only when their suffix declares text",
        "private_source_names": "source-private identifiers only; public substitution phrases are permitted",
        "secret_detection": "credential-shaped tokens outside synthetic fixtures",
        "path_detection": "denied private path fragments, absolute user paths, internal Linear IDs, and course-material URLs",
        "email_detection": "only example.com, example.org, example.net and t@t.com placeholders are permitted",
    }
    return sha256_bytes(canonical_json(descriptor))


def write_export_manifest(target: Path, snapshot: dict[str, Any]) -> str:
    manifest = {
        "schema_version": "marketing-studio.export/1",
        "source": {
            "commit": snapshot["commit"],
            "tree": snapshot["tree"],
            "status": "clean",
            "approved_readme": snapshot["approved_readme"],
        },
        "tool": {
            "path": TOOL_RELATIVE,
            "source_sha256": sha256_file(Path(__file__).resolve()),
        },
        "policy": {
            "scan_version": SCAN_POLICY_VERSION,
            "scan_sha256": scan_policy_digest(),
            "allowlist_sha256": sha256_bytes(canonical_json(ALLOWLIST_POLICY)),
        },
        "files": output_file_records(target, snapshot),
    }
    manifest_path = target / EXPORT_MANIFEST
    manifest_path.write_bytes(canonical_json(manifest))
    return sha256_file(manifest_path)


def rekey_eval_fixtures(target: Path) -> list[str]:
    """Refresh hash-only eval pins after public substitutions to pinned skills."""
    script = r'''
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPack } from './studio-runner/src/pack-loader.ts';
import { systemPromptForRole } from './studio-runner/src/agent-run.ts';
const roles = ['director', 'writer', 'fact_reviewer', 'craft_reviewer'];
const sha = value => createHash('sha256').update(value).digest('hex');
for (const packId of ['newsletter', 'conversion-copywriting']) {
  const pack = loadPack(packId);
  const hashes = Object.fromEntries(roles.map(role => [role, sha(systemPromptForRole(role, pack))]));
  const dir = join('packs', packId, 'evals');
  for (const name of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const file = join(dir, name);
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.live_only === true || !value.recorded_system_sha256) continue;
    value.recorded_system_sha256 = hashes;
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  }
}
'''
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=target,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode:
        raise RuntimeError(f"could not re-key eval fixtures:\n{result.stderr.strip()}")
    return [p.as_posix() for p in sorted((target / "packs").glob("*/evals/*.json"))]


EMAIL_RE = re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9.-])")
SECRET_RE = re.compile(
    r"(?:(?<![A-Za-z0-9])sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9][A-Za-z0-9_-]{7,}|"
    r"gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})"
)
COURSE_URL_RE = re.compile(
    r"https?://[^\s)<>]*(?:youtube\.com|youtu\.be|youtubetotranscript\.com|"
    r"skillshare\.com|docs\.google\.com/document|drive\.google\.com/drive/folders)[^\s)<>]*",
    re.IGNORECASE,
)
# Build the source-private names from fragments so the scanner's own source is
# safe to scan. Public replacement phrases are intentionally not forbidden.
PRIVATE_NAME_RE = re.compile(
    r"\b(?:%s)\b" % "|".join(
        re.escape(fragment)
        for fragment in (
            "Hired" + "Stack",
            "Simply" + "Career",
            "nish" + "pn01",
            "Pran" + "ish",
            "first" + "mate",
        )
    ),
    re.IGNORECASE,
)
LINEAR_ID_RE = re.compile(r"\b(?:CAR|DAP)-\d+\b")


def is_synthetic_file(rel: str) -> bool:
    return rel.startswith("studio-runner/test/") or rel.startswith("studio-runner/fixtures/")


def scan_privacy(target: Path) -> list[str]:
    violations: list[str] = []
    denied_path_fragments = (
        "docs/archive/",
        "pilots/",
        "studio-runner/examples/",
        "workspace-private/",
        "session-transcripts/",
    )
    for path in sorted(target.rglob("*")):
        if not path.is_file() or ".git" in path.parts or "node_modules" in path.parts:
            continue
        rel = path.relative_to(target).as_posix()
        if any(fragment in rel for fragment in denied_path_fragments):
            violations.append(f"{rel}:1: denied private path")
            continue
        try:
            raw = path.read_bytes()
            if b"\0" in raw:
                if path.suffix in TEXT_SUFFIXES or rel in {"LICENSE", "README.md"}:
                    violations.append(f"{rel}:1: binary data in declared text file")
                continue
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            if path.suffix in TEXT_SUFFIXES or rel in {"LICENSE", "README.md"}:
                violations.append(f"{rel}:1: non-UTF-8 text in declared text file")
            continue
        for line_number, line in enumerate(text.splitlines(), 1):
            where = f"{rel}:{line_number}"
            if PRIVATE_NAME_RE.search(line):
                violations.append(f"{where}: private name or handle")
            if LINEAR_ID_RE.search(line):
                violations.append(f"{where}: internal Linear ID")
            if COURSE_URL_RE.search(line):
                violations.append(f"{where}: course-material URL")
            # URL userinfo in a synthetic credential-stripping test is not an
            # email address and should not be reported as one.
            email_line = re.sub(r"https?://[^/\s]+@", "https://", line)
            email_line = re.sub(r"\b[^\s'\"`]+@github\.com(?=[:/])", "", email_line)
            emails = EMAIL_RE.findall(email_line)
            for email in emails:
                domain = email.rsplit("@", 1)[1].lower()
                if domain not in {"example.com", "example.org", "example.net"} and email.lower() != "t@t.com":
                    violations.append(f"{where}: non-placeholder email")
            if SECRET_RE.search(line) and not is_synthetic_file(rel):
                violations.append(f"{where}: key/token pattern")
            if re.search(r"/Users/[A-Za-z0-9._-]+", line):
                allowed_os_path = rel in {
                    "studio-runner/src/separate-user-install.ts",
                    "studio-runner/test/separate-user-install.test.ts",
                } and re.search(r"/Users/(?:_studio|alice)\b", line)
                if not allowed_os_path:
                    violations.append(f"{where}: absolute user path")
    return violations


def readme_link_check(target: Path) -> list[str]:
    failures: list[str] = []
    link_re = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
    for readme in sorted(target.rglob("README.md")):
        rel_readme = readme.relative_to(target).as_posix()
        for line_number, line in enumerate(readme.read_text(encoding="utf-8").splitlines(), 1):
            for raw in link_re.findall(line):
                link = raw.strip().strip("<>").split("#", 1)[0]
                if not link or re.match(r"^(?:[a-z][a-z0-9+.-]*:|//)", link, re.IGNORECASE):
                    continue
                candidate = (readme.parent / link).resolve()
                try:
                    candidate.relative_to(target.resolve())
                except ValueError:
                    failures.append(f"{rel_readme}:{line_number}: link escapes output: {link}")
                    continue
                if not candidate.exists():
                    failures.append(f"{rel_readme}:{line_number}: missing link target: {link}")
    return failures


def run(command: list[str], cwd: Path, label: str, env: dict[str, str] | None = None) -> None:
    print(f"[export] {label}: {' '.join(command)}")
    result = subprocess.run(command, cwd=cwd, env=env)
    if result.returncode:
        raise RuntimeError(f"{label} failed with exit code {result.returncode}")


def install_output_dependencies(target: Path) -> None:
    run(
        ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
        target / "studio-runner",
        "Node install",
    )


def initialize_output_git(target: Path) -> None:
    if (target / ".git").exists():
        raise RuntimeError("output target already contains .git; export requires a fresh repository")
    run(["git", "init", "-q"], target, "git init")
    run(["git", "add", "-A"], target, "git stage")
    commit = subprocess.run(
        [
            "git",
            "-c",
            "user.name=Marketing Studio",
            "-c",
            "user.email=public-edition@example.org",
            "commit",
            "-qm",
            "Initial public edition",
        ],
        cwd=target,
        check=False,
    )
    if commit.returncode:
        raise RuntimeError("initial public-edition commit failed")


def cleanup_test_artifacts(target: Path) -> None:
    for relative in ("node_modules", "studio-runner/node_modules"):
        node_modules = target / relative
        if node_modules.exists():
            shutil.rmtree(node_modules)
    for path in target.rglob("__pycache__"):
        if path.is_dir():
            shutil.rmtree(path)
    results = target / "evaluations" / "results"
    if results.exists():
        shutil.rmtree(results)


def publish_staged(stage: Path, target: Path, force: bool) -> None:
    """Expose a fully checked tree, preserving an existing target on failure."""
    backup: Path | None = None
    if target.exists() or target.is_symlink():
        if not force:
            raise RuntimeError(f"target exists; pass --force to replace exactly: {target}")
        backup = Path(tempfile.mkdtemp(prefix=f".{target.name}.backup-", dir=target.parent))
        backup.rmdir()
        target.rename(backup)
    try:
        stage.rename(target)
    except Exception:
        if backup is not None and not target.exists():
            backup.rename(target)
        raise
    if backup is not None:
        shutil.rmtree(backup)


def run_output_checks(target: Path) -> None:
    runner = target / "studio-runner"
    # The separate-user-install tests intentionally mutate HOME while probing
    # hostile Git config. Serial execution keeps that process-global probe
    # isolated from the rest of the suite.
    run(["npm", "test", "--", "--test-concurrency=1"], runner, "Node test suite")
    run(["node", "--experimental-strip-types", "src/cli.ts", "doctor"], runner, "fixture doctor")
    for pack in ("newsletter", "conversion-copywriting"):
        run(["node", "--experimental-strip-types", "studio-runner/src/cli.ts", "eval", pack], target, f"{pack} fixture eval")
    run(["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], target, "Python test suite")
    run(["node", "--experimental-strip-types", "hosts/generate.ts", "--check"], target, "host generation check")

    with tempfile.TemporaryDirectory(prefix="msc-public-fixture-") as tmp:
        fixture = Path(tmp) / "sample"
        shutil.copytree(target / "studio-runner" / "fixtures" / "sample", fixture)
        result = subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(target / "studio-runner/src/cli.ts"),
                "run",
                "--workspace",
                str(fixture),
                "--request",
                str(fixture / "request.json"),
            ],
            cwd=target,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode:
            raise RuntimeError(f"fixture demo failed:\n{result.stderr}")
        payload = json.loads(result.stdout)
        if payload.get("status") != "SIMULATION_COMPLETE":
            raise RuntimeError(f"fixture demo did not complete: {payload}")
        print(f"[export] fixture demo: {json.dumps(payload, sort_keys=True)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="private repository root")
    parser.add_argument("--target", type=Path, required=True, help="fresh public-edition output directory")
    parser.add_argument("--approved-readme", type=Path, required=True, help="approved README to install as output README.md")
    parser.add_argument("--force", action="store_true", help="remove an existing target after validating it is not the source")
    parser.add_argument("--run-tests", action="store_true", help="install dependencies and run output checks")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    target = args.target.resolve()
    approved_readme = args.approved_readme.resolve()
    if not approved_readme.is_file():
        raise SystemExit("approved README does not exist")
    if target == source or source in target.parents:
        raise SystemExit("target must be outside the private source repository")
    if target.exists() or target.is_symlink():
        if not args.force:
            raise SystemExit(f"target exists; pass --force to replace exactly: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    stage: Path | None = Path(tempfile.mkdtemp(prefix=f".{target.name}.staging-", dir=target.parent))
    try:
        snapshot = source_snapshot(source, approved_readme)
        copied = copy_allowlist(source, stage, approved_readme, snapshot)
        rekey_eval_fixtures(stage)
        privacy = scan_privacy(stage)
        if privacy:
            print("Privacy scan failed:", file=sys.stderr)
            print("\n".join(privacy), file=sys.stderr)
            return 2
        links = readme_link_check(stage)
        if links:
            print("README link check failed:", file=sys.stderr)
            print("\n".join(links), file=sys.stderr)
            return 3
        if args.run_tests:
            install_output_dependencies(stage)
            # npm install changes only the staged tree; the final scan covers
            # every text file that would actually be shipped.
            privacy = scan_privacy(stage)
            if privacy:
                print("Privacy scan failed after install:", file=sys.stderr)
                print("\n".join(privacy), file=sys.stderr)
                return 2
        manifest_sha256 = write_export_manifest(stage, snapshot)
        privacy = scan_privacy(stage)
        if privacy:
            print("Privacy scan failed after manifest:", file=sys.stderr)
            print("\n".join(privacy), file=sys.stderr)
            return 2
        print(f"[export] copied {len(copied)} allowlisted files")
        print(f"[export] manifest: {EXPORT_MANIFEST} sha256={manifest_sha256}")
        print("[export] privacy scan: PASS")
        print("[export] README link check: PASS")
        initialize_output_git(stage)
        if args.run_tests:
            run_output_checks(stage)
            cleanup_test_artifacts(stage)
            privacy = scan_privacy(stage)
            if privacy:
                print("Privacy scan failed after output checks:", file=sys.stderr)
                print("\n".join(privacy), file=sys.stderr)
                return 2
            result = subprocess.run(["git", "status", "--porcelain=v1"], cwd=stage, check=True, text=True, stdout=subprocess.PIPE)
            if result.stdout:
                raise RuntimeError(f"output checks left a dirty tree:\n{result.stdout}")
            print("[export] output checks: PASS")
        publish_staged(stage, target, args.force)
        stage = None
        print(f"[export] published atomically at {target}")
        return 0
    finally:
        if stage is not None and stage.exists():
            shutil.rmtree(stage)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.CalledProcessError, RuntimeError) as exc:
        print(f"export failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
