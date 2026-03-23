"""
fetch_data.py
-------------
Fetches Yahoo Fantasy Hockey stats for every completed week plus the
current live week, computes PWW scores, and writes docs/data.json.

Run via GitHub Actions daily, or locally with:
    python scripts/fetch_data.py

Local usage requires a .env file in the repo root with:
    YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REFRESH_TOKEN,
    YAHOO_LEAGUE_KEY, TOTAL_TEAMS (optional, default 12)
"""

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import objectpath
import pandas as pd
import requests

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

from yahoo_oauth import refresh_access_token

# --- constants -----------------------------------------------------------
STAT_LABELS = ["G", "A", "PIM", "PPP", "SOG", "FW", "HIT", "BLK", "W", "SV", "SV%", "SHO"]
CAT_SCORES  = [100, 100, 100,   100,   100,   100,  100,   100,   100, 100, 100,   50]

DOCS_DIR  = Path(__file__).parent.parent / "docs"
DOCS_DIR.mkdir(exist_ok=True)
DATA_FILE = DOCS_DIR / "data.json"


# --- HTTP helper ---------------------------------------------------------
def api_get(url, headers, retries=3):
    params = {"format": "json"}
    for attempt in range(retries):
        try:
            r = requests.get(url, params, headers=headers, timeout=15)
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            if attempt == retries - 1:
                raise
            wait = 2 ** attempt
            print("    (retry {} in {}s - {})".format(attempt + 1, wait, exc))
            time.sleep(wait)


# --- Yahoo data extractors -----------------------------------------------
def _tree(data):
    return objectpath.Tree(data)


def ext_team_name(data, slot):
    path = ("$.fantasy_content.team[1].matchups['0'].matchup['0']"
            ".teams['{}'].team[0].name[0]".format(slot))
    return _tree(data).execute(path)


def ext_team_stats(data, slot):
    path = ("$.fantasy_content.team[1].matchups['0'].matchup['0']"
            ".teams['{}'].team[1].team_stats.stats.*.stat.value".format(slot))
    stats = list(map(float, _tree(data).execute(path)))
    del stats[10]   # remove SA -- not a scoring category
    return stats


def ext_team_logo(data, slot):
    """Direct dict walk for logo URL -- objectpath returns generators here."""
    try:
        info = (data["fantasy_content"]["team"][1]["matchups"]["0"]
                    ["matchup"]["0"]["teams"][str(slot)]["team"][0])
        for item in info:
            if isinstance(item, dict) and "team_logos" in item:
                return item["team_logos"][0]["team_logo"]["url"]
    except Exception:
        pass
    return None


def ext_manager(data, slot):
    try:
        path = ("$.fantasy_content.team[1].matchups['0'].matchup['0']"
                ".teams['{}'].team[0].managers[0].manager.nickname".format(slot))
        result = _tree(data).execute(path)
        # objectpath may return a generator -- extract the string value
        if result is None:
            return None
        if isinstance(result, str):
            return result
        return next(iter(result), None)
    except Exception:
        return None


def ext_current_week(data):
    return int(_tree(data).execute("$.fantasy_content.league['0'].current_week.value"))


# --- direct /team/stats endpoint (works for bye teams) -------------------
def ext_name_direct(data):
    """Extract team name from /team/.../stats response."""
    items = data["fantasy_content"]["team"][0]
    for item in items:
        if isinstance(item, dict) and "name" in item:
            return item["name"]
    return None


def ext_stats_direct(data):
    """Extract 12 scoring stats from /team/.../stats response."""
    stats_list = data["fantasy_content"]["team"][1]["team_stats"]["stats"]
    vals = [float(s["stat"]["value"]) for s in stats_list]
    if len(vals) > 10:
        del vals[10]   # remove SA -- not a scoring category
    if len(vals) != 12:
        raise ValueError("unexpected stat count: {}".format(len(vals)))
    return vals


def ext_logo_direct(data):
    items = data["fantasy_content"]["team"][0]
    for item in items:
        if isinstance(item, dict) and "team_logos" in item:
            try:
                return item["team_logos"][0]["team_logo"]["url"]
            except Exception:
                pass
    return None


def ext_manager_direct(data):
    items = data["fantasy_content"]["team"][0]
    for item in items:
        if isinstance(item, dict) and "managers" in item:
            try:
                return item["managers"][0]["manager"]["nickname"]
            except Exception:
                pass
    return None


# --- PWW scoring ---------------------------------------------------------
def compute_pww(all_stats):
    """Normalised PWW scores (0-1150) across all teams for one week."""
    df         = pd.DataFrame(all_stats, index=STAT_LABELS).T
    score_s    = pd.Series(CAT_SCORES, index=STAT_LABELS)
    range_vals = (df.max() - df.min()).replace(0, 1)
    return df.sub(df.min()).div(range_vals).dot(score_s)


# --- category comparison -------------------------------------------------
def compare_cats(s1, s2):
    """Returns list of '1'/'2'/'T' for each of the 12 categories."""
    result = []
    for v1, v2 in zip(s1, s2):
        if v1 > v2:
            result.append("1")
        elif v2 > v1:
            result.append("2")
        else:
            result.append("T")
    return result


# --- per-week fetch ------------------------------------------------------
def fetch_week(league_key, week, current_week, total_teams, headers):
    print("  Week {:2d}:".format(week), end=" ", flush=True)

    all_stats = {}   # team_name -> [12 floats]
    all_logos = {}   # team_name -> url
    all_mgrs  = {}   # team_name -> manager nickname
    opp_map   = {}   # team_name -> opponent_name

    # Step 1: fetch stats for every team directly (works for bye teams too)
    for i in range(1, total_teams + 1):
        stats_url = ("https://fantasysports.yahooapis.com/fantasy/v2"
                     "/team/{}.t.{}/stats;type=week;week={}".format(league_key, i, week))
        try:
            data   = api_get(stats_url, headers)
            t_name = ext_name_direct(data)
            if not t_name:
                raise ValueError("no team name")
            all_stats[t_name] = ext_stats_direct(data)
            logo = ext_logo_direct(data)
            mgr  = ext_manager_direct(data)
            if logo:
                all_logos[t_name] = logo
            if mgr:
                all_mgrs[t_name] = mgr
            print(".", end="", flush=True)
        except Exception as exc:
            print("[!t{}]".format(i), end="", flush=True)

    # Step 2: fetch matchup pairings separately (bye teams will have no opponent)
    for i in range(1, total_teams + 1):
        matchup_url = ("https://fantasysports.yahooapis.com/fantasy/v2"
                       "/team/{}.t.{}/matchups;weeks={}".format(league_key, i, week))
        try:
            data   = api_get(matchup_url, headers)
            t_name = ext_team_name(data, "0")
            o_name = ext_team_name(data, "1")
            if t_name and o_name and t_name not in opp_map:
                opp_map[t_name] = o_name
            # Pick up any logo/manager data for the opponent that we may have missed
            if o_name:
                logo = ext_team_logo(data, "1")
                mgr  = ext_manager(data, "1")
                if logo:
                    all_logos.setdefault(o_name, logo)
                if mgr:
                    all_mgrs.setdefault(o_name, mgr)
        except Exception:
            pass   # bye team -- no matchup, that's fine

    print(" {}/{} teams fetched".format(len(all_stats), total_teams))

    if not all_stats:
        return None

    # If this is the current week and no team has scored anything yet,
    # the week hasn't started (Yahoo rollover window). Skip to avoid bad data.
    if week == current_week:
        total_goals = sum(s[0] for s in all_stats.values())
        if total_goals == 0:
            print("  Week {:2d}: no goals yet -- skipping (week not started)".format(week))
            return None

    pww = compute_pww(all_stats)

    # Load prev week scores for delta
    prev_pww = {}
    if DATA_FILE.exists():
        try:
            prev_week_key = str(week - 1)
            existing = json.loads(DATA_FILE.read_text())
            if prev_week_key in existing.get("weeks", {}):
                prev_pww = existing["weeks"][prev_week_key].get("pww", {})
        except Exception:
            pass

    # Build matchup pairs (deduplicated)
    seen     = set()
    matchups = []
    for t, o in opp_map.items():
        pair = frozenset([t, o])
        if pair in seen or o not in all_stats:
            continue
        seen.add(pair)
        matchups.append({
            "t1":   t,
            "t2":   o,
            "cats": compare_cats(all_stats[t], all_stats[o]),
        })

    # Category leaders
    leaders = {}
    for idx, stat in enumerate(STAT_LABELS):
        leaders[stat] = max(all_stats, key=lambda n: all_stats[n][idx])

    return {
        "is_current":  (week == current_week),
        "matchups":    matchups,
        "stats":       {n: dict(zip(STAT_LABELS, v)) for n, v in all_stats.items()},
        "pww":         {n: round(float(pww.get(n, 0)), 2) for n in all_stats},
        "deltas": {
            n: (round(float(pww.get(n, 0)) - prev_pww[n], 2) if n in prev_pww else None)
            for n in all_stats
        },
        "leaders":     leaders,
        "leaderboard": list(pww.sort_values(ascending=False).index),
        "logos":       all_logos,
        "managers":    all_mgrs,
    }


# --- season standings ----------------------------------------------------
def build_standings(weeks_data):
    """W/L/T record based on category score (>6 = win, <6 = loss, =6 = tie)."""
    records = {}
    for week_obj in weeks_data.values():
        if week_obj.get("is_current"):
            continue   # don't count in-progress week
        for m in week_obj.get("matchups", []):
            cats = m["cats"]
            s1 = sum(1 for c in cats if c == "1") + 0.5 * sum(1 for c in cats if c == "T")
            s2 = 12 - s1
            for team, score in [(m["t1"], s1), (m["t2"], s2)]:
                r = records.setdefault(team, {"W": 0, "L": 0, "T": 0})
                if score > 6:
                    r["W"] += 1
                elif score < 6:
                    r["L"] += 1
                else:
                    r["T"] += 1
    return records


# --- main ----------------------------------------------------------------
def main():
    league_key  = os.environ["YAHOO_LEAGUE_KEY"]
    total_teams = int(os.environ.get("TOTAL_TEAMS") or 12)

    print("PWW Hockey - Web Data Fetcher")
    print("=" * 40)

    access_token = refresh_access_token()
    headers      = {"Authorization": "Bearer {}".format(access_token)}

    league_data  = api_get(
        "https://fantasysports.yahooapis.com/fantasy/v2/league/{}/".format(league_key),
        headers,
    )
    current_week = ext_current_week(league_data)
    print("  Current week: {}".format(current_week))

    # Load existing data so we can skip completed weeks already cached
    if DATA_FILE.exists():
        existing = json.loads(DATA_FILE.read_text())
    else:
        existing = {"meta": {}, "teams": {}, "weeks": {}, "standings": {}}

    cached_weeks = set(existing.get("weeks", {}).keys())
    weeks_data   = dict(existing.get("weeks", {}))
    all_logos    = dict(existing.get("teams", {}))

    for week in range(1, current_week + 1):
        wk = str(week)
        # Skip fully-completed weeks that are already cached
        if week < current_week - 1 and wk in cached_weeks:
            print("  Week {:2d}: cached -- skipping".format(week))
            continue

        week_data = fetch_week(league_key, week, current_week, total_teams, headers)
        if week_data:
            weeks_data[wk] = week_data
            # Merge logos & managers into the global teams dict
            for name, logo in week_data.pop("logos", {}).items():
                if logo:
                    all_logos.setdefault(name, {})["logo"] = logo
            for name, mgr in week_data.pop("managers", {}).items():
                if mgr:
                    all_logos.setdefault(name, {})["manager"] = mgr

    standings = build_standings(weeks_data)

    output = {
        "meta": {
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "current_week": current_week,
        },
        "teams":     all_logos,
        "weeks":     weeks_data,
        "standings": standings,
    }

    DATA_FILE.write_text(json.dumps(output, indent=2))
    print("\nSaved -> {}".format(DATA_FILE))
    print("Weeks in data: {}".format(sorted(int(k) for k in weeks_data)))


main()


