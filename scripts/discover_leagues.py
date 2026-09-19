"""
discover_leagues.py
-------------------
Lists every NHL fantasy league your Yahoo account has ever joined, across all
seasons, and writes docs/seasons.json -- the season->league_key map that
fetch_data.py uses to build a multi-season dashboard.

Yahoo assigns a new *game key* each season (2025-26 = 449, and so on). The
league ID stays the same year to year, so the full league key is:

    {game_key}.l.{league_id}        e.g. 449.l.1809

That is why the key has to be rediscovered every season rather than guessed.

Run:
    python scripts/discover_leagues.py                 # list + write seasons.json
    python scripts/discover_leagues.py --league 1809   # only that league ID
    python scripts/discover_leagues.py --dry-run       # list only, write nothing

Requires the same .env as fetch_data.py:
    YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REFRESH_TOKEN
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

sys.path.insert(0, str(Path(__file__).parent))
from yahoo_oauth import refresh_access_token

YAHOO_BASE   = "https://fantasysports.yahooapis.com/fantasy/v2"
DOCS_DIR     = Path(__file__).parent.parent / "docs"
SEASONS_FILE = DOCS_DIR / "seasons.json"


def api_get(path, headers, retries=3):
    url = "{}/{}".format(YAHOO_BASE, path)
    for attempt in range(retries):
        try:
            r = requests.get(url, params={"format": "json"}, headers=headers, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            if attempt == retries - 1:
                raise
            wait = 2 ** attempt
            print("    (retry {} in {}s - {})".format(attempt + 1, wait, exc))
            time.sleep(wait)


def _flatten(node):
    """
    Yahoo mixes lists and dicts freely. Collapse a node into a single flat dict
    of its scalar metadata, ignoring nested collections.
    """
    out = {}
    items = node if isinstance(node, list) else [node]
    for item in items:
        if isinstance(item, dict):
            for k, v in item.items():
                if not isinstance(v, (dict, list)):
                    out[k] = v
    return out


def _numbered(collection):
    """Yield each value from a Yahoo {"count": N, "0": ..., "1": ...} dict."""
    if not isinstance(collection, dict):
        return
    for i in range(int(collection.get("count", 0) or 0)):
        entry = collection.get(str(i))
        if entry is not None:
            yield entry


def discover(headers):
    """Return [{season, game_key, league_key, league_id, name, num_teams}] sorted by season."""
    data = api_get("users;use_login=1/games;game_codes=nhl/leagues", headers)

    try:
        user_node = data["fantasy_content"]["users"]["0"]["user"]
    except (KeyError, TypeError):
        print("Unexpected response shape -- dumping for debugging:")
        print(json.dumps(data, indent=2)[:2000])
        return []

    games = {}
    for part in (user_node if isinstance(user_node, list) else [user_node]):
        if isinstance(part, dict) and "games" in part:
            games = part["games"]
            break

    rows = []
    for game_entry in _numbered(games):
        node      = game_entry.get("game") if isinstance(game_entry, dict) else game_entry
        game_meta = _flatten(node)
        game_key  = game_meta.get("game_key")
        season    = game_meta.get("season")
        if not game_key:
            continue

        # The leagues collection sits alongside the game metadata
        leagues = {}
        for part in (node if isinstance(node, list) else [node]):
            if isinstance(part, dict) and "leagues" in part:
                leagues = part["leagues"]
                break

        for lg_entry in _numbered(leagues):
            lg_node = lg_entry.get("league") if isinstance(lg_entry, dict) else lg_entry
            lg_meta = _flatten(lg_node)
            lg_key  = lg_meta.get("league_key")
            if not lg_key:
                continue
            rows.append({
                "season":     str(season) if season else "?",
                "game_key":   str(game_key),
                "league_key": lg_key,
                "league_id":  str(lg_meta.get("league_id", "")),
                "name":       lg_meta.get("name", ""),
                "num_teams":  lg_meta.get("num_teams", ""),
            })

    rows.sort(key=lambda r: r["season"])
    return rows


def season_label(season):
    """Yahoo's season '2025' means the 2025-26 NHL season."""
    try:
        y = int(season)
        return "{}-{}".format(y, str(y + 1)[-2:])
    except (TypeError, ValueError):
        return str(season)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--league", help="Only include this league ID (e.g. 1809)")
    ap.add_argument("--dry-run", action="store_true", help="Print only, do not write seasons.json")
    args = ap.parse_args()

    print("Yahoo NHL League Discovery")
    print("=" * 66)

    headers = {"Authorization": "Bearer {}".format(refresh_access_token())}
    rows    = discover(headers)

    if not rows:
        print("No NHL leagues found for this account.")
        return

    if args.league:
        rows = [r for r in rows if r["league_id"] == str(args.league)]
        if not rows:
            print("No leagues matched league ID {}.".format(args.league))
            return

    print()
    print("{:10s} {:9s} {:14s} {:6s} {}".format(
        "SEASON", "GAME_KEY", "LEAGUE_KEY", "TEAMS", "NAME"))
    print("-" * 66)
    for r in rows:
        print("{:10s} {:9s} {:14s} {:6s} {}".format(
            season_label(r["season"]), r["game_key"], r["league_key"],
            str(r["num_teams"]), r["name"]))

    if args.dry_run:
        print("\n(--dry-run: seasons.json not written)")
        return

    # Group by league ID so a multi-league account still produces a clean map.
    by_league = {}
    for r in rows:
        by_league.setdefault(r["league_id"], {})[season_label(r["season"])] = {
            "league_key": r["league_key"],
            "game_key":   r["game_key"],
            "name":       r["name"],
            "num_teams":  r["num_teams"],
        }

    # Default to the league with the most seasons -- that is the long-running one.
    primary = max(by_league, key=lambda lid: len(by_league[lid]))
    seasons = by_league[primary]
    current = max(seasons, key=lambda s: s)

    DOCS_DIR.mkdir(exist_ok=True)
    SEASONS_FILE.write_text(json.dumps({
        "league_id": primary,
        "current":   current,
        "seasons":   seasons,
    }, indent=2))

    print()
    print("Wrote -> {}".format(SEASONS_FILE))
    print("  league_id : {}".format(primary))
    print("  seasons   : {}".format(len(seasons)))
    print("  current   : {}  ({})".format(current, seasons[current]["league_key"]))
    if len(by_league) > 1:
        others = ", ".join(l for l in by_league if l != primary)
        print("  note: other league IDs also found ({}) -- "
              "rerun with --league to pick a different one.".format(others))


if __name__ == "__main__":
    main()
