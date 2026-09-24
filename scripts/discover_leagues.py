"""
discover_leagues.py
-------------------
Lists every NHL fantasy league your Yahoo account has ever joined, across all
seasons, and writes docs/league_keys.json -- the season->league_key map that
fetch_data.py uses to build a multi-season dashboard.

Yahoo assigns a new *game key* each season (2025-26 = 449, and so on). The
league ID stays the same year to year, so the full league key is:

    {game_key}.l.{league_id}        e.g. 449.l.1809

That is why the key has to be rediscovered every season rather than guessed.

Run:
    python scripts/discover_leagues.py                 # list + write league_keys.json
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

sys.path.insert(0, str(Path(__file__).parent))
from yahoo_oauth import load_env, refresh_access_token

load_env()   # searches YAHOO_ENV, the repo root, then parent directories

YAHOO_BASE   = "https://fantasysports.yahooapis.com/fantasy/v2"
DOCS_DIR     = Path(__file__).parent.parent / "docs"
KEYS_FILE    = DOCS_DIR / "league_keys.json"


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


def api_get(path, headers, retries=3, quiet=False):
    """
    GET a Yahoo endpoint. 4xx other than 429 are permanent answers, not blips,
    so they are raised immediately rather than retried.
    """
    url = "{}/{}".format(YAHOO_BASE, path)
    for attempt in range(retries):
        try:
            r = requests.get(url, params={"format": "json"}, headers=headers, timeout=20)
            if 400 <= r.status_code < 500 and r.status_code != 429:
                raise ApiError(r.status_code, "HTTP {} for {}".format(r.status_code, path))
            r.raise_for_status()
            return r.json()
        except ApiError:
            raise
        except Exception as exc:
            if attempt == retries - 1:
                raise
            wait = 2 ** attempt
            if not quiet:
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


def current_game_key(headers):
    """Current NHL game key via the game-scoped endpoint."""
    data = api_get("game/nhl", headers)
    meta = _flatten(data["fantasy_content"]["game"])
    return meta.get("game_key"), meta.get("season")


def probe_game_keys(league_id, headers, lo=380, hi=500):
    """
    Last resort: find this season's league key by trying {gk}.l.{league_id}
    across a range of game keys.

    Only needed when even /game/nhl is refused, which happens when an app is
    restricted to league-scoped reads. The league ID in a Yahoo league URL
    belongs to the CURRENT season, so exactly one game key should answer.
    """
    print("  probing game keys {}-{} for league {} "
          "(this takes a minute)...".format(lo, hi, league_id))
    for gk in range(hi, lo - 1, -1):          # newest first
        key = "{}.l.{}".format(gk, league_id)
        try:
            meta = league_meta(key, headers)
        except Exception:
            continue
        if meta.get("league_key") or meta.get("name"):
            print("  hit: {}  season {}  {}".format(
                key, meta.get("season", "?"), meta.get("name", "")))
            return str(gk), meta.get("season")
    return None, None


def resolve_start_key(league_id, headers, explicit=None):
    """
    Work out which league key to start the renew walk from, cheapest first:

      1. --start-key
      2. $YAHOO_LEAGUE_KEY  -- the working key an existing tool already uses
      3. /game/nhl + league_id
      4. probing game keys against league_id
    """
    if explicit:
        print("  start key from --start-key: {}".format(explicit))
        return explicit

    env_key = os.environ.get("YAHOO_LEAGUE_KEY")
    if env_key and ".l." in env_key:
        print("  start key from YAHOO_LEAGUE_KEY: {}".format(env_key))
        return env_key

    try:
        gk, season = current_game_key(headers)
        if gk:
            print("  current NHL game key: {} (season {})".format(gk, season))
            return "{}.l.{}".format(gk, league_id)
    except ApiError as exc:
        print("  /game/nhl refused ({}) -- this app is limited to "
              "league-scoped reads.".format(exc))

    if not league_id:
        return None
    gk, _ = probe_game_keys(league_id, headers)
    return "{}.l.{}".format(gk, league_id) if gk else None


def _renew_to_key(renew):
    """Yahoo writes the previous season as '427_1809'; we need '427.l.1809'."""
    if not renew or "_" not in str(renew):
        return None
    gk, _, lid = str(renew).partition("_")
    if not gk.isdigit() or not lid.isdigit():
        return None
    return "{}.l.{}".format(gk, lid)


def league_meta(league_key, headers):
    data = api_get("league/{}/".format(league_key), headers, quiet=True)
    node = data["fantasy_content"]["league"]
    return _flatten(node)


def discover_by_renew_chain(league_id, headers, max_hops=25, start_key=None):
    """
    Walk league history backwards without the /users collection.

    Each league carries `renew` (the previous season's league) and `renewed`
    (the next). Starting from this season's league we follow `renew` back as
    far as it goes. League IDs are NOT stable across seasons, so the chain is
    the only reliable way to link them.
    """
    key = resolve_start_key(league_id, headers, start_key)
    if not key:
        print("\n  Could not determine a starting league key.")
        print("  Find the key your working Yahoo script uses (it looks like")
        print("  '449.l.1809') and pass it:  --start-key <key>")
        return []

    rows, seen = [], set()

    while key and key not in seen and len(rows) < max_hops:
        seen.add(key)
        try:
            meta = league_meta(key, headers)
        except ApiError as exc:
            if not rows:
                print("  {} not readable ({}) -- is {} the right league ID "
                      "for this season?".format(key, exc, league_id))
            break
        except Exception as exc:
            print("  {} failed: {}".format(key, exc))
            break

        rows.append({
            "season":     str(meta.get("season", "?")),
            "game_key":   key.split(".l.")[0],
            "league_key": key,
            "league_id":  key.split(".l.")[-1],
            "name":       meta.get("name", ""),
            "num_teams":  meta.get("num_teams", ""),
        })
        print("  found {:10s} {:16s} {:>2} teams  {}".format(
            str(meta.get("season", "?")), key,
            meta.get("num_teams", "?"), meta.get("name", "")))
        key = _renew_to_key(meta.get("renew"))

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
    ap.add_argument("--dry-run", action="store_true", help="Print only, do not write league_keys.json")
    ap.add_argument("--start-key", help="League key to walk back from, e.g. 449.l.1809. "
                                        "Use when Yahoo refuses the lookup endpoints.")
    args = ap.parse_args()

    print("Yahoo NHL League Discovery")
    print("=" * 66)

    headers = {"Authorization": "Bearer {}".format(refresh_access_token())}

    rows, via_chain = [], False
    try:
        rows = discover(headers)
    except ApiError as exc:
        if exc.status in (401, 403):
            print("  /users collection refused (HTTP {}).".format(exc.status))
            print("  Falling back to walking league history via renew links.\n")
        else:
            raise
    except Exception as exc:
        print("  /users lookup failed: {}\n  Falling back to renew chain.\n".format(exc))

    if not rows:
        if not args.league and not args.start_key:
            print("\nCannot fall back without a league ID or start key.")
            print("Rerun with --league <id> (the number in your league's Yahoo")
            print("URL), or --start-key <game_key>.l.<league_id> if you have one.")
            return
        rows = discover_by_renew_chain(args.league, headers, start_key=args.start_key)
        via_chain = True

    if not rows:
        print("No NHL leagues found for this account.")
        return

    # League IDs change season to season, so --league only filters a /users
    # listing. The renew chain is already scoped to one league by construction.
    if args.league and not via_chain:
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
        print("\n(--dry-run: league_keys.json not written)")
        return

    # A renew chain is one league across seasons, so keep it whole. Only a
    # /users listing can legitimately contain several distinct leagues.
    group_key = (lambda r: "chain") if via_chain else (lambda r: r["league_id"])
    by_league = {}
    for r in rows:
        by_league.setdefault(group_key(r), {})[season_label(r["season"])] = {
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
    KEYS_FILE.write_text(json.dumps({
        "league_id": str(args.league) if via_chain else primary,
        "current":   current,
        "seasons":   seasons,
    }, indent=2))

    print()
    print("Wrote -> {}".format(KEYS_FILE))
    print("  league_id : {}".format(str(args.league) if via_chain else primary))
    print("  seasons   : {}".format(len(seasons)))
    print("  current   : {}  ({})".format(current, seasons[current]["league_key"]))
    if len(by_league) > 1 and not via_chain:
        others = ", ".join(l for l in by_league if l != primary)
        print("  note: other league IDs also found ({}) -- "
              "rerun with --league to pick a different one.".format(others))


if __name__ == "__main__":
    main()
