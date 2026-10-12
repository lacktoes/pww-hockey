"""
fetch_data.py
-------------
Fetches Yahoo Fantasy Hockey stats and writes one data file per season, plus
docs/seasons.json -- the manifest the dashboard reads to populate its season
selector.

    docs/league_keys.json    season -> league_key   (written by discover_leagues.py)
    docs/data-<season>.json  one file per season    (written here)
    docs/seasons.json        front-end manifest     (written here)
    docs/data.json           copy of the current season, for backwards compatibility

Usage:
    python scripts/fetch_data.py                      # current season only
    python scripts/fetch_data.py --season 2024-25     # one specific season
    python scripts/fetch_data.py --backfill           # every season in league_keys.json
    python scripts/fetch_data.py --backfill --skip-complete   # resume an interrupted backfill
    python scripts/fetch_data.py --list               # show what is configured

A backfill is thousands of Yahoo calls (roughly weeks x teams x 2 per season),
so run it locally rather than in the GitHub Action, and use --skip-complete to
resume if it is interrupted or throttled.

DATA SOURCE (2026-27 onward)
    Yahoo shut legacy apps out of the official Fantasy API on 2026-07-22. The league
    is publicly viewable, and Yahoo's own website reads public leagues from an internal
    host that returns the SAME v2 JSON:  https://pub-api-ro.fantasysports.yahoo.com
    So every URL below is still written against the old API base and is rewritten in
    api_get(); no OAuth, no secrets. Set YAHOO_BASE to the old host (and the OAuth
    variables) to go back if Yahoo ever approves the app.

    Caveats: undocumented host, can change without notice; works only while the league
    stays public.
"""

import argparse
import json
import re
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import objectpath
import pandas as pd
import requests

from yahoo_oauth import load_env, refresh_access_token

load_env()   # searches YAHOO_ENV, the repo root, then parent directories

# --- data source ---------------------------------------------------------
OFFICIAL_BASE = "https://fantasysports.yahooapis.com/fantasy/v2"
PUBLIC_BASE   = "https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2"
YAHOO_BASE    = (os.environ.get("YAHOO_BASE") or PUBLIC_BASE).rstrip("/")
USE_OAUTH     = YAHOO_BASE == OFFICIAL_BASE


def request_headers():
    """OAuth only for the official host; the public host takes no credentials."""
    if USE_OAUTH:
        return {"Authorization": "Bearer {}".format(refresh_access_token())}
    return {"User-Agent": "Mozilla/5.0 (pww-hockey dashboard; public league read)",
            "Accept": "application/json"}

# --- constants -----------------------------------------------------------
STAT_LABELS = ["G", "A", "PIM", "PPP", "SOG", "FW", "HIT", "BLK", "W", "SV", "SV%", "SHO"]
CAT_SCORES  = [100, 100, 100,   100,   100,   100,  100,   100,   100, 100, 100,   50]
STAT_IDS    = {"1": "G", "2": "A", "5": "PIM", "8": "PPP", "14": "SOG", "16": "FW",
               "31": "HIT", "32": "BLK", "19": "W", "25": "SV", "26": "SV%", "27": "SHO"}
GOALIE_CATS = ("W", "SV", "SV%", "SHO")
# League rule: a team with fewer goalie appearances than this in a week forfeits every
# goalie category to its opponent. Yahoo's API doesn't expose the setting; 3 is this
# league's value (confirmed: week 1 2026-27, Beezus Christs, 2 GP, forfeited W/SV/SV%/SHO).
GOALIE_MIN  = int(os.environ.get("GOALIE_MIN_GP") or 3)

DOCS_DIR       = Path(__file__).parent.parent / "docs"
DOCS_DIR.mkdir(exist_ok=True)
DATA_FILE      = DOCS_DIR / "data.json"          # current season, legacy path
KEYS_FILE      = DOCS_DIR / "league_keys.json"
MANIFEST_FILE  = DOCS_DIR / "seasons.json"
OVERRIDES_FILE = DOCS_DIR / "matchup_overrides.json"

# Politeness delay between Yahoo calls. A full backfill is thousands of
# requests; going flat out invites throttling part-way through.
CALL_DELAY = float(os.environ.get("YAHOO_CALL_DELAY") or 0.12)


def season_file(season):
    return DOCS_DIR / "data-{}.json".format(season)


def season_label_from_key(league_key):
    """'449.l.1809' has no season in it, so this is only a last-resort label."""
    return league_key


# --- HTTP helper ---------------------------------------------------------
def api_get(url, headers, retries=4):
    params = {"format": "json"}
    # URLs are written against the official base; serve them from whichever host is live
    if url.startswith(OFFICIAL_BASE) and YAHOO_BASE != OFFICIAL_BASE:
        url = YAHOO_BASE + url[len(OFFICIAL_BASE):]
    for attempt in range(retries):
        try:
            r = requests.get(url, params, headers=headers, timeout=20)
            if r.status_code == 999 or r.status_code == 429:
                raise RuntimeError("throttled by Yahoo (HTTP {})".format(r.status_code))
            r.raise_for_status()
            if CALL_DELAY:
                time.sleep(CALL_DELAY)
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
        if result is None:
            return None
        if isinstance(result, str):
            return result
        return next(iter(result), None)
    except Exception:
        return None


def ext_league_meta(data):
    """
    Return (current_week, end_week, is_finished) for a league.

    is_finished matters for the backfill: Yahoo keeps reporting a current_week
    for a season that ended years ago, so deriving "live week" from
    week == current_week would mark the final week of every historical season
    as in progress -- which excludes it from the standings.
    """
    tree = _tree(data)

    def _int(path):
        try:
            v = tree.execute(path)
            return int(v) if v is not None else None
        except Exception:
            return None

    current = (_int("$.fantasy_content.league['0'].current_week.value")
               or _int("$.fantasy_content.league[0].current_week"))
    end = (_int("$.fantasy_content.league['0'].end_week.value")
           or _int("$.fantasy_content.league[0].end_week"))
    finished = (_int("$.fantasy_content.league['0'].is_finished.value")
                or _int("$.fantasy_content.league[0].is_finished")) or 0
    return current, end, bool(finished)


# --- direct /team/stats endpoint (works for bye teams) -------------------
def ext_name_direct(data):
    items = data["fantasy_content"]["team"][0]
    for item in items:
        if isinstance(item, dict) and "name" in item:
            return item["name"]
    return None


def ext_team_key_direct(data):
    items = data["fantasy_content"]["team"][0]
    for item in items:
        if isinstance(item, dict) and "team_key" in item:
            return item["team_key"]
    return None


def _num(v):
    """Yahoo returns None / "" / "-" for a stat with no data yet (e.g. SV% before a team's
    goalies have played in the live week). Count those as 0."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def ext_stats_direct(data):
    """Extract the 12 scoring stats from a /team/.../stats response."""
    stats_list = data["fantasy_content"]["team"][1]["team_stats"]["stats"]
    vals = [_num(s["stat"].get("value")) for s in stats_list]
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


def ext_manager_guid_direct(data):
    """
    The manager GUID is the only identifier stable across seasons -- team names
    and even team numbers change year to year. Captured now so cross-season
    features later do not require refetching every season.
    """
    items = data["fantasy_content"]["team"][0]
    for item in items:
        if isinstance(item, dict) and "managers" in item:
            try:
                return item["managers"][0]["manager"].get("guid")
            except Exception:
                pass
    return None


def _flat(items):
    out = {}
    for x in items or []:
        if isinstance(x, list):
            out.update(_flat(x))
        elif isinstance(x, dict):
            out.update(x)
    return out


def ext_matchup(data):
    """(week_start, week_end, {team_key: slot}, Yahoo's per-category result or None) from a
    /team/.../matchups response. Yahoo's stat_winners are the official result: they
    include rules the raw totals can't show, such as the goalie-minimum forfeit."""
    m = data["fantasy_content"]["team"][1]["matchups"]["0"]["matchup"]
    keys = {}
    for slot in ("0", "1"):
        info = _flat(m["0"]["teams"][slot]["team"][0])
        keys[info.get("team_key")] = slot
    cats = None
    winners = m.get("stat_winners") or []
    if winners:
        by_label = {}
        for w in winners:
            sw = w.get("stat_winner", {})
            label = STAT_IDS.get(str(sw.get("stat_id")))
            if not label:
                continue
            if str(sw.get("is_tied", "0")) == "1":
                by_label[label] = "T"
            else:
                slot = keys.get(sw.get("winner_team_key"))
                by_label[label] = {"0": "1", "1": "2"}.get(slot)
        if all(by_label.get(lab) for lab in STAT_LABELS):
            cats = [by_label[lab] for lab in STAT_LABELS]
    return m.get("week_start"), m.get("week_end"), keys, cats


# Per-day team totals, in this column order. SV% is left out: a rate can't be summed, the
# page derives it from SV / SA. GP = goalie appearances that day.
DAILY_COLS = ["G", "A", "PIM", "PPP", "SOG", "FW", "HIT", "BLK", "W", "SV", "SA", "SHO", "GP"]
DAILY_IDS  = ["1", "2", "5", "8", "14", "16", "31", "32", "19", "25", "24", "27"]
BENCH      = ("BN", "IR", "IR+", "NA")


def fetch_team_day(team_key, day, headers):
    """One team's totals for one date: the sum of its active-slot players' stats that day,
    plus goalie appearances (a goalie in a G slot who faced a shot or made a save). Summed
    over a week these reproduce Yahoo's weekly team totals exactly, which the fetch checks."""
    url = ("https://fantasysports.yahooapis.com/fantasy/v2/team/{k}/roster;date={d}"
           "/players/stats;type=date;date={d}".format(k=team_key, d=day))
    data = api_get(url, headers)
    players = data["fantasy_content"]["team"][1]["roster"]["0"]["players"]
    tot, gp = [0.0] * len(DAILY_IDS), 0
    for k in players:
        if not k.isdigit():
            continue
        extra = {}
        for x in players[k]["player"][1:]:
            if isinstance(x, dict):
                extra.update(x)
        slot = _flat(extra.get("selected_position", [])).get("position")
        if slot in BENCH:
            continue
        stats = {st["stat"]["stat_id"]: st["stat"]["value"]
                 for st in extra.get("player_stats", {}).get("stats", [])}
        for i, sid in enumerate(DAILY_IDS):
            tot[i] += _num(stats.get(sid))
        if slot == "G" and (_num(stats.get("24")) > 0 or _num(stats.get("25")) > 0):
            gp += 1
    return [int(v) if float(v).is_integer() else v for v in tot] + [gp]


def week_days(week_start, week_end):
    from datetime import date as _d, timedelta as _td
    d, end = _d.fromisoformat(week_start), _d.fromisoformat(week_end)
    out = []
    while d <= end:
        out.append(d.isoformat())
        d += _td(days=1)
    return out


def rule_cats(s1, s2, gp1=None, gp2=None, apply_min=True):
    """Category results recomputed from totals, applying the goalie-minimum forfeit."""
    cats = compare_cats(s1, s2)
    if apply_min and gp1 is not None and gp2 is not None:
        f1, f2 = gp1 < GOALIE_MIN, gp2 < GOALIE_MIN
        if f1 != f2:
            for i, lab in enumerate(STAT_LABELS):
                if lab in GOALIE_CATS:
                    cats[i] = "2" if f1 else "1"
    return cats


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
def fetch_week(league_key, week, live_week, total_teams, headers, prev_pww=None, prev_week=None):
    print("  Week {:2d}:".format(week), end=" ", flush=True)

    all_stats = {}   # team_name -> [12 floats]
    all_meta  = {}   # team_name -> {logo, manager, guid, team_key}
    opp_map   = {}   # team_name -> opponent_name
    yahoo_cats = {}  # (t_name, o_name) -> Yahoo's official per-category result
    week_dates = (None, None)

    # Step 1: stats for every team directly (works for bye teams too)
    for i in range(1, total_teams + 1):
        stats_url = ("https://fantasysports.yahooapis.com/fantasy/v2"
                     "/team/{}.t.{}/stats;type=week;week={}".format(league_key, i, week))
        try:
            data   = api_get(stats_url, headers)
            t_name = ext_name_direct(data)
            if not t_name:
                raise ValueError("no team name")
            all_stats[t_name] = ext_stats_direct(data)
            all_meta[t_name] = {
                "logo":     ext_logo_direct(data),
                "manager":  ext_manager_direct(data),
                "guid":     ext_manager_guid_direct(data),
                "team_key": ext_team_key_direct(data),
            }
            print(".", end="", flush=True)
        except Exception:
            print("[!t{}]".format(i), end="", flush=True)

    # Step 2: matchup pairings (bye teams simply have no opponent)
    for i in range(1, total_teams + 1):
        matchup_url = ("https://fantasysports.yahooapis.com/fantasy/v2"
                       "/team/{}.t.{}/matchups;weeks={}".format(league_key, i, week))
        try:
            data   = api_get(matchup_url, headers)
            t_name = ext_team_name(data, "0")
            o_name = ext_team_name(data, "1")
            if t_name and o_name and t_name not in opp_map:
                opp_map[t_name] = o_name
            try:
                ws, we, _keys, ycats = ext_matchup(data)
                week_dates = (ws or week_dates[0], we or week_dates[1])
                if t_name and o_name and ycats:
                    yahoo_cats[(t_name, o_name)] = ycats
            except Exception:
                pass
            if o_name:
                logo = ext_team_logo(data, "1")
                mgr  = ext_manager(data, "1")
                entry = all_meta.setdefault(o_name, {})
                if logo and not entry.get("logo"):
                    entry["logo"] = logo
                if mgr and not entry.get("manager"):
                    entry["manager"] = mgr
        except Exception:
            pass   # bye team -- no matchup, that's fine

    print(" {}/{} teams fetched".format(len(all_stats), total_teams))

    if not all_stats:
        return None

    # If this is the live week and nothing has been scored, the week has not
    # started (Yahoo rollover window). Skip rather than store a week of zeros.
    if week == live_week:
        if sum(s[0] for s in all_stats.values()) == 0:
            print("  Week {:2d}: no goals yet -- skipping (week not started)".format(week))
            return None

    pww = compute_pww(all_stats)

    # Day-by-day team totals (and goalie appearances, for the goalie-minimum rule).
    # A day is re-read only while it can still change: the last two UTC days, to catch
    # late games and stat corrections. Older days are reused from the stored week.
    is_live = (week == live_week)
    audit   = []
    stored  = dict(((prev_week or {}).get("daily") or {}).get("days") or {})
    days    = {}
    if week_dates[0] and week_dates[1]:
        today  = datetime.now(timezone.utc).date().isoformat()
        recent = (datetime.now(timezone.utc).date() - timedelta(days=2)).isoformat()
        wanted = [d for d in week_days(week_dates[0], week_dates[1]) if d <= today]

        def read_day(d, names):
            row = dict(days.get(d) or {})
            for name in names:
                key = all_meta.get(name, {}).get("team_key")
                if key:
                    row[name] = fetch_team_day(key, d, headers)
            days[d] = row

        try:
            for d in wanted:
                have = stored.get(d) or {}
                if d >= recent or any(n not in have for n in all_stats):
                    read_day(d, all_stats)
                else:
                    days[d] = have
            # Check: the days must add up to Yahoo's weekly totals. If a team is off (a stat
            # correction on an older day), re-read its whole week once.
            sv_i, sa_i = DAILY_COLS.index("SV"), DAILY_COLS.index("SA")
            off = []
            # (Finished weeks only: while games are on, the weekly total moves between reads.)
            for attempt in ((1, 2) if not is_live else ()):
                off = []
                for name, wk_vals in all_stats.items():
                    tot = [sum(_num((days[d].get(name) or [0] * len(DAILY_COLS))[i]) for d in wanted)
                           for i in range(len(DAILY_COLS))]
                    for lab, val in zip(STAT_LABELS, wk_vals):
                        if lab == "SV%":
                            mine = (tot[sv_i] / tot[sa_i]) if tot[sa_i] else 0.0
                            bad = abs(mine - val) > 0.0015
                        else:
                            bad = abs(tot[DAILY_COLS.index(lab)] - val) > 1e-6
                        if bad:
                            off.append((name, lab))
                if not off or attempt == 2:
                    break
                for name in sorted({n for n, _ in off}):
                    for d in wanted:
                        read_day(d, [name])
            for name in sorted({n for n, _ in off} if not is_live else ()):
                labs = [lab for n, lab in off if n == name]
                audit.append({"team": name, "daily_vs_week": labs})
                print("\n  ! week {} {}: daily totals don't add up to the weekly total on {}".format(
                    week, name, ", ".join(labs)), end="")
        except Exception as exc:
            print("  [daily totals failed: {}]".format(exc))
            days = dict(stored)
    gp_i = DAILY_COLS.index("GP")
    goalie_gp = {}
    for name in all_stats:
        rows = [days[d][name] for d in days if name in (days[d] or {})]
        if rows:
            goalie_gp[name] = int(sum(r[gp_i] for r in rows))

    seen     = set()
    matchups = []
    for t, o in opp_map.items():
        pair = frozenset([t, o])
        if pair in seen or t not in all_stats or o not in all_stats:
            continue
        seen.add(pair)
        official = yahoo_cats.get((t, o))
        # Recompute from totals as a check. In a live week the minimum can't be judged yet.
        recomputed = rule_cats(all_stats[t], all_stats[o], goalie_gp.get(t), goalie_gp.get(o),
                               apply_min=not is_live)
        cats = official or recomputed
        if official and official != recomputed and not is_live:
            diff = [STAT_LABELS[i] for i in range(len(STAT_LABELS)) if official[i] != recomputed[i]]
            audit.append({"t1": t, "t2": o, "categories": diff})
            print("\n  ! week {} {} v {}: Yahoo differs from the recomputed result on {}".format(
                week, t, o, ", ".join(diff)), end="")
        matchups.append({"t1": t, "t2": o, "cats": cats,
                         "source": "yahoo" if official else "computed"})

    leaders = {}
    for idx, stat in enumerate(STAT_LABELS):
        leaders[stat] = max(all_stats, key=lambda n: all_stats[n][idx])

    prev_pww = prev_pww or {}
    return {
        "is_current":  (week == live_week),
        "matchups":    matchups,
        "stats":       {n: dict(zip(STAT_LABELS, v)) for n, v in all_stats.items()},
        "pww":         {n: round(float(pww.get(n, 0)), 2) for n in all_stats},
        "deltas": {
            n: (round(float(pww.get(n, 0)) - prev_pww[n], 2) if n in prev_pww else None)
            for n in all_stats
        },
        "leaders":     leaders,
        "leaderboard": list(pww.sort_values(ascending=False).index),
        "goalie_gp":   goalie_gp,
        "daily":       {"cols": DAILY_COLS, "days": {d: days[d] for d in sorted(days)}},
        "week_start":  week_dates[0],
        "week_end":    week_dates[1],
        "audit":       audit,
        "_meta":       all_meta,
    }


# --- season standings ----------------------------------------------------
def build_standings(weeks_data):
    """W/L/T record based on category score (>6 = win, <6 = loss, =6 = tie)."""
    records = {}
    for week_obj in weeks_data.values():
        if week_obj.get("is_current"):
            continue   # don't count an in-progress week
        for m in week_obj.get("matchups", []):
            cats = m["cats"]
            s1 = sum(1 for c in cats if c == "1") + 0.5 * sum(1 for c in cats if c == "T")
            s2 = len(cats) - s1
            for team, score in [(m["t1"], s1), (m["t2"], s2)]:
                r = records.setdefault(team, {"W": 0, "L": 0, "T": 0})
                if score > len(cats) / 2:
                    r["W"] += 1
                elif score < len(cats) / 2:
                    r["L"] += 1
                else:
                    r["T"] += 1
    return records


# --- overrides -----------------------------------------------------------
def load_overrides(season):
    """
    Overrides are keyed {season: {week: [[t1, t2], ...]}}. A legacy file keyed
    directly by week number is treated as belonging to 2025-26, the only season
    that existed when it was written.
    """
    if not OVERRIDES_FILE.exists():
        return {}
    raw = json.loads(OVERRIDES_FILE.read_text(encoding="utf-8"))
    if not raw:
        return {}
    if all(k.isdigit() for k in raw):          # legacy shape
        return raw if season == "2025-26" else {}
    return raw.get(season, {})


def apply_overrides(weeks_data, season):
    for wk_str, pairs in load_overrides(season).items():
        if wk_str not in weeks_data:
            continue
        wk_stats = weeks_data[wk_str].get("stats", {})
        overridden = {t for pair in pairs for t in pair}
        kept = [m for m in weeks_data[wk_str].get("matchups", [])
                if m["t1"] not in overridden and m["t2"] not in overridden]
        for t1, t2 in pairs:
            if t1 in wk_stats and t2 in wk_stats:
                s1 = [wk_stats[t1][s] for s in STAT_LABELS]
                s2 = [wk_stats[t2][s] for s in STAT_LABELS]
                kept.append({"t1": t1, "t2": t2, "cats": compare_cats(s1, s2)})
        weeks_data[wk_str]["matchups"] = kept
        print("  Week {}: matchup override applied ({} pairs)".format(wk_str, len(pairs)))


# --- one season ----------------------------------------------------------
def fetch_season(season, league_key, total_teams, headers, refetch_all=False):
    """Fetch (or top up) one season and return its full data object."""
    print("\n=== {}  ({}) ===".format(season, league_key))

    path     = season_file(season)
    existing = json.loads(path.read_text()) if path.exists() else {}
    weeks_data = dict(existing.get("weeks", {}))
    teams_meta = dict(existing.get("teams", {}))

    league_data = api_get(
        "https://fantasysports.yahooapis.com/fantasy/v2/league/{}/".format(league_key),
        headers)
    current_week, end_week, is_finished = ext_league_meta(league_data)
    if not current_week and not end_week:
        print("  could not read week numbers -- skipping season")
        return None
    live_week = None if is_finished else current_week
    # In season, weeks after the live one haven't been played: Yahoo returns all-zero
    # stats for them, which would be stored (and cached) as real weeks. Stop at the live week.
    last_week = (current_week or end_week) if live_week else max(w for w in (current_week, end_week) if w)
    print("  current_week={}  end_week={}  finished={}  fetching 1..{}".format(
        current_week, end_week, is_finished, last_week))

    for week in range(1, last_week + 1):
        wk = str(week)
        # Completed weeks never change. Only the live week and the one before it
        # (Yahoo backdates stat corrections) are worth refetching.
        if (not refetch_all and wk in weeks_data
                and live_week and week < live_week - 1
                and (weeks_data[wk].get("daily") or {}).get("days")):
            print("  Week {:2d}: cached -- skipping".format(week))
            continue

        prev = weeks_data.get(str(week - 1), {}).get("pww", {})
        week_data = fetch_week(league_key, week, live_week, total_teams, headers, prev,
                               prev_week=weeks_data.get(wk))
        if not week_data:
            continue

        for name, meta in week_data.pop("_meta", {}).items():
            entry = teams_meta.setdefault(name, {})
            for k, v in meta.items():
                if v and not entry.get(k):
                    entry[k] = v
        weeks_data[wk] = week_data

    if not weeks_data:
        print("  no weeks fetched")
        return None

    apply_overrides(weeks_data, season)

    # A finished league has no live week, so every stored week counts.
    if is_finished:
        for w in weeks_data.values():
            w["is_current"] = False

    reported = (current_week if str(current_week) in weeks_data
                else max(int(k) for k in weeks_data))
    is_complete = is_finished or not any(w.get("is_current") for w in weeks_data.values())

    return {
        "meta": {
            "season":       season,
            "league_key":   league_key,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "current_week": reported,
            "complete":     is_complete,
            "goalie_min":   GOALIE_MIN,
        },
        "teams":     teams_meta,
        "weeks":     weeks_data,
        "standings": build_standings(weeks_data),
    }


def dump_json(obj):
    """Indented JSON, with arrays of numbers kept on one line (the daily totals would
    otherwise print one number per line and triple the file)."""
    text = json.dumps(obj, indent=2)
    return re.sub(r"\[\s+((?:-?[\d.]+,\s+)*-?[\d.]+)\s+\]",
                  lambda m: "[" + re.sub(r"\s+", " ", m.group(1)) + "]", text)


# --- manifest ------------------------------------------------------------
def write_manifest(current_season):
    """
    Scan the docs directory for season files and write the front-end manifest.
    Derived from what is actually on disk, so a partial backfill still produces
    a correct selector.
    """
    seasons = []
    for path in sorted(DOCS_DIR.glob("data-*.json")):
        label = path.stem[len("data-"):]
        if not re.fullmatch(r"\d{4}-\d{2}", label):
            continue   # skip OneDrive conflict copies such as data-Shanes-Dellboy.json
        try:
            obj = json.loads(path.read_text())
        except Exception:
            continue
        weeks = obj.get("weeks", {})
        seasons.append({
            "season":       label,
            "file":         path.name,
            "weeks":        len(weeks),
            "teams":        len(obj.get("standings", {})),
            "complete":     bool(obj.get("meta", {}).get("complete")),
            "last_updated": obj.get("meta", {}).get("last_updated"),
        })

    seasons.sort(key=lambda s: s["season"], reverse=True)
    if current_season is None and seasons:
        current_season = seasons[0]["season"]

    MANIFEST_FILE.write_text(json.dumps({
        "current": current_season,
        "seasons": seasons,
    }, indent=2))
    print("\nManifest -> {}  ({} season(s), current {})".format(
        MANIFEST_FILE, len(seasons), current_season))


# --- config --------------------------------------------------------------
def load_league_keys():
    """
    {season: {league_key, num_teams}}. Falls back to YAHOO_LEAGUE_KEY under a
    single season label so the script still works before discovery has run.
    """
    if KEYS_FILE.exists():
        cfg = json.loads(KEYS_FILE.read_text())
        return cfg.get("seasons", {}), cfg.get("current")

    key = os.environ.get("YAHOO_LEAGUE_KEY")
    if not key:
        raise SystemExit(
            "No {} and no YAHOO_LEAGUE_KEY set.\n"
            "Run: python scripts/discover_leagues.py --league <id>".format(KEYS_FILE))
    label = os.environ.get("SEASON_LABEL") or "2025-26"
    print("No league_keys.json -- falling back to YAHOO_LEAGUE_KEY as {}".format(label))
    return {label: {"league_key": key}}, label


# --- main ----------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", help="Fetch one season, e.g. 2024-25")
    ap.add_argument("--backfill", action="store_true", help="Fetch every configured season")
    ap.add_argument("--skip-complete", action="store_true",
                    help="During a backfill, skip seasons whose file is already complete")
    ap.add_argument("--refetch-all", action="store_true",
                    help="Refetch every week, ignoring the cache")
    ap.add_argument("--list", action="store_true", help="Show configured seasons and exit")
    args = ap.parse_args()

    print("PWW Hockey - Web Data Fetcher")
    print("=" * 46)

    configured, current = load_league_keys()
    if not configured:
        raise SystemExit("No seasons configured. Run scripts/discover_leagues.py first.")

    if args.list:
        print("\n{:10s} {:16s} {:6s} {}".format("SEASON", "LEAGUE_KEY", "TEAMS", "DATA FILE"))
        for s in sorted(configured, reverse=True):
            f = season_file(s)
            state = "{} weeks".format(len(json.loads(f.read_text()).get("weeks", {}))) \
                    if f.exists() else "-"
            print("{:10s} {:16s} {:6s} {}".format(
                s, configured[s].get("league_key", "?"),
                str(configured[s].get("num_teams", "?")), state))
        print("\ncurrent: {}".format(current))
        return

    if args.backfill:
        targets = sorted(configured, reverse=True)
    elif args.season:
        if args.season not in configured:
            raise SystemExit("Season {} not configured. Known: {}".format(
                args.season, ", ".join(sorted(configured))))
        targets = [args.season]
    else:
        targets = [current] if current in configured else [max(configured)]

    headers = request_headers()
    print("Data source: {}{}".format(YAHOO_BASE, "  (OAuth)" if USE_OAUTH else "  (public, no login)"))
    env_teams = int(os.environ.get("TOTAL_TEAMS") or 12)

    done, failed = [], []
    for season in targets:
        entry = configured[season]
        path  = season_file(season)

        if args.skip_complete and path.exists():
            try:
                if json.loads(path.read_text()).get("meta", {}).get("complete"):
                    print("\n=== {} === already complete -- skipping".format(season))
                    done.append(season)
                    continue
            except Exception:
                pass

        # League size has changed over the years, so prefer the per-season count.
        total_teams = int(entry.get("num_teams") or env_teams)

        try:
            obj = fetch_season(season, entry["league_key"], total_teams, headers,
                               refetch_all=args.refetch_all)
        except Exception as exc:
            print("  !! {} failed: {}".format(season, exc))
            failed.append(season)
            continue

        if not obj:
            failed.append(season)
            continue

        path.write_text(dump_json(obj))
        print("  Saved -> {}  ({} weeks)".format(path, len(obj["weeks"])))
        done.append(season)

        # Mirror the current season to the legacy path so an un-updated
        # front end keeps working.
        if season == current:
            DATA_FILE.write_text(dump_json(obj))
            print("  Mirrored -> {}".format(DATA_FILE))

    write_manifest(current)

    print("\nFetched: {}".format(", ".join(done) if done else "none"))
    if failed:
        print("Failed:  {}".format(", ".join(failed)))
        print("Rerun with --backfill --skip-complete to resume.")


if __name__ == "__main__":
    main()
