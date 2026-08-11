"""
Entropy gate: scan a sidecar JS bundle for credential-shaped strings.

Usage: python3 entropy-gate.py <path-to-server.js>

Exits 1 if a high-entropy string is found; exits 0 if the bundle is clean.

Patterns checked:
  - 64-char lowercase hex string (not adjacent to identifier chars)
  - Relay token pattern: cld_<40+ alnum chars>

NOTE: Written as a standalone script (not a heredoc) so the calling workflow
YAML is valid.  bash heredocs whose body is at column 0 terminate a YAML
run: | block scalar early and cause GitHub Actions to reject the workflow file.
"""

import re
import sys


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: entropy-gate.py <path>\n")
        return 2

    path = sys.argv[1]
    try:
        content = open(path).read()
    except OSError as exc:
        sys.stderr.write(f"entropy-gate: cannot open {path}: {exc}\n")
        return 2

    if re.search(r'(?<![A-Za-z0-9_])[0-9a-f]{64}(?![A-Za-z0-9_])', content):
        sys.stderr.write("ENTROPY GATE FAILED: 64-char hex string found in sidecar bundle\n")
        return 1

    if re.search(r'cld_[A-Za-z0-9]{40,}', content):
        sys.stderr.write("ENTROPY GATE FAILED: Relay token pattern found in sidecar bundle\n")
        return 1

    print("Entropy gate passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
