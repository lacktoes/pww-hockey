"""
debug_players.py — test remaining Yahoo API stat approaches.
"""
import json, os, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

try:
    from dotenv import load_dotenv
    for _p in [Path(__file__).parents[i] / ".env" for i in range(1, 6)]:
        if _p.exists():
            load_dotenv(_p)
            break
except ImportError:
    pass

import requests
from yahoo_oauth import refresh_access_token

league_key   = os.environ["YAHOO_LEAGUE_KEY"]
access_token = refresh_access_token()
headers      = {"Authorization": "Bearer {}".format(access_token)}

PLAYER_KEY = "465.p.8668"   # Ridly Greig
WEEK_HIST  = 21             # completed week
WEEK_CUR   = 22             # current week


def api_get(url):
    print("  GET", url)
    r = requests.get(url, params={"format": "json"}, headers=headers, timeout=15)
    print("  Status:", r.status_code)
    if not r.ok:
        print("  Error:", r.text[:200])
        return None
    return r.json()


def show(data, label="player"):
    if not data:
        return
    fc = data.get("fantasy_content", data)
    node = fc.get(label, fc.get("players", fc))
    print(json.dumps(node, indent=2)[:3000])


def sep(t):
    print("\n" + "=" * 60)
    print(t)
    print("=" * 60)


# ── Test D: season stats (no week filter) ─────────────────────────
sep("TEST D: /player/{key}/stats  (season, no week)")
show(api_get(
    "https://fantasysports.yahooapis.com/fantasy/v2"
    "/player/{}/stats".format(PLAYER_KEY)))


# ── Test E: current week stats ────────────────────────────────────
sep("TEST E: /player/{key}/stats;type=week;week={} (CURRENT)".format(WEEK_CUR))
show(api_get(
    "https://fantasysports.yahooapis.com/fantasy/v2"
    "/player/{}/stats;type=week;week={}".format(PLAYER_KEY, WEEK_CUR)))


# ── Test F: league player with out=stats (season) ─────────────────
sep("TEST F: /league/players;player_keys=...;out=stats (season)")
show(api_get(
    "https://fantasysports.yahooapis.com/fantasy/v2"
    "/league/{}/players;player_keys={};out=stats".format(league_key, PLAYER_KEY)),
    label="league")


# ── Test G: team players with out=stats, week params ──────────────
sep("TEST G: /team/players;out=stats;type=week;week={}".format(WEEK_HIST))
show(api_get(
    "https://fantasysports.yahooapis.com/fantasy/v2"
    "/team/{}.t.1/players;out=stats;type=week;week={}".format(league_key, WEEK_HIST)),
    label="team")
