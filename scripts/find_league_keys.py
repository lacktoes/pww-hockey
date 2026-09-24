"""
find_league_keys.py
-------------------
Scans folders for Yahoo league keys and credentials left in old scripts, then
tests each key to see which this token can actually read.

Written because Yahoo refuses every non-league endpoint for this app
(/users and /game both return 403), so the only way to find a usable league
key is to try ones already lying around on disk.

    python scripts/find_league_keys.py C:\\Users\\shane\\OneDrive\\Fant\\YFAPI ^
                                       C:\\Users\\shane\\OneDrive\\Fant\\PWWWW

    python scripts/find_league_keys.py <dirs> --no-test     # list only, no API calls

SECRETS: league keys are identifiers, not secrets, so they are printed. Client
secrets and refresh tokens are NOT printed -- only the file that holds them,
so you can point YAHOO_ENV at it.
"""

import argparse
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from yahoo_oauth import load_env, refresh_access_token
from discover_leagues import ApiError, league_meta

# 449.l.1809 -- game key, literal ".l.", league id
KEY_RE = re.compile(r"\b(\d{2,4})\.l\.(\d{1,7})\b")
# Credential assignments, in .env files or hardcoded in Python
CRED_RE = re.compile(
    r"""(YAHOO_(?:CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN|LEAGUE_KEY))\s*[=:]""",
    re.IGNORECASE)

SCAN_SUFFIXES = {".py", ".env", ".txt", ".json", ".toml", ".ini", ".cfg",
                 ".bat", ".cmd", ".ps1", ".yaml", ".yml", ".md"}
SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".idea"}
MAX_BYTES = 2_000_000


def scan(roots):
    keys = defaultdict(set)      # league_key -> {files}
    creds = defaultdict(set)     # file -> {var names}
    scanned = 0

    for root in roots:
        rp = Path(root)
        if not rp.exists():
            print("  !! not found: {}".format(root))
            continue
        for path in rp.rglob("*"):
            if not path.is_file():
                continue
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            if path.suffix.lower() not in SCAN_SUFFIXES and path.name != ".env":
                continue
            try:
                if path.stat().st_size > MAX_BYTES:
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            scanned += 1
            for gk, lid in KEY_RE.findall(text):
                keys["{}.l.{}".format(gk, lid)].add(str(path))
            for var in CRED_RE.findall(text):
                creds[str(path)].add(var.upper())

    return keys, creds, scanned


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("roots", nargs="+", help="Folders to scan")
    ap.add_argument("--no-test", action="store_true",
                    help="Only list what was found; make no API calls")
    args = ap.parse_args()

    print("Scanning for Yahoo league keys and credentials")
    print("=" * 70)
    keys, creds, scanned = scan(args.roots)
    print("  {} file(s) scanned".format(scanned))

    if creds:
        print("\nFILES CONTAINING CREDENTIALS (values not shown)")
        for path in sorted(creds):
            print("  {:60s} {}".format(path[-60:], ", ".join(sorted(creds[path]))))
        print("\n  Point the other scripts at one of these:")
        print("    set YAHOO_ENV=<path to the .env among them>")

    if not keys:
        print("\nNo league keys found. Open your league in a browser; the URL is")
        print("  hockey.fantasysports.yahoo.com/hockey/<league_id>/<team_id>")
        return

    print("\nLEAGUE KEYS FOUND ({})".format(len(keys)))
    # Newest game key first -- most likely to be the live season.
    ordered = sorted(keys, key=lambda k: (-int(k.split(".l.")[0]), k))
    for k in ordered:
        print("  {:16s} in {}".format(k, sorted(keys[k])[0]))

    if args.no_test:
        return

    print("\nTESTING WHICH ARE READABLE")
    print("-" * 70)
    load_env()
    try:
        headers = {"Authorization": "Bearer {}".format(refresh_access_token())}
    except SystemExit as exc:
        print(exc)
        return

    readable = []
    for k in ordered:
        try:
            meta = league_meta(k, headers)
        except ApiError as exc:
            print("  {:16s} HTTP {}".format(k, exc.status))
            continue
        except Exception as exc:
            print("  {:16s} {}".format(k, exc))
            continue
        season = meta.get("season", "?")
        print("  {:16s} OK   season {}  {:>2} teams  {}".format(
            k, season, meta.get("num_teams", "?"), meta.get("name", "")))
        readable.append((int(k.split(".l.")[0]), k, season))

    print("-" * 70)
    if not readable:
        print("None readable. Every key on disk is refused, so the league you want")
        print("is probably not among them. Get the league ID from the browser URL.")
        return

    readable.sort(reverse=True)
    _, best, season = readable[0]
    print("\n{} readable. Newest is {} (season {}).".format(len(readable), best, season))
    print("\nRun discovery from it:")
    print("  python scripts/discover_leagues.py --start-key {}".format(best))


if __name__ == "__main__":
    main()
