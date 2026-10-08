# PWW Hockey — data pipeline

The dashboard reads one JSON file per season plus a manifest, so the site can
show any season the account has data for.

## Data source (since Oct 2026): public feed, no login

Yahoo closed the official Fantasy API to legacy apps on 22 Jul 2026. The league
is **publicly viewable**, and Yahoo's own site reads public leagues through
`https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2`, which returns the
**same v2 JSON**. `fetch_data.py` rewrites every official URL onto that host, so
nothing downstream changed. OAuth, secrets and `yahoo.env` aren't needed.

- To go back to OAuth (if Yahoo ever re-approves the app), set
  `YAHOO_BASE=https://fantasysports.yahooapis.com/fantasy/v2`.
- **Risks:** the host is undocumented, and it only works while the league stays
  public.
- 2026-27 league key: `477.l.1809`, set in `docs/league_keys.json`.
  `discover_leagues.py` needs OAuth, so add each new season's key by hand. Find
  it in the league URL (`hockey.fantasysports.yahoo.com/hockey/<id>`) plus
  `game/nhl` → `game_key`.
- In season, only weeks up to the live week are fetched. Live-week stats with no
  data yet (`None`, e.g. SV% before a team's goalie has played) count as 0.

## Files

| File | Written by | Purpose |
|---|---|---|
| `docs/league_keys.json` | `discover_leagues.py` | season → Yahoo league key (fetch config) |
| `docs/data-<season>.json` | `fetch_data.py` | one season of results |
| `docs/seasons.json` | `fetch_data.py` | manifest the front end reads to build the season selector |
| `docs/data.json` | `fetch_data.py` | copy of the current season, kept for backwards compatibility |
| `docs/matchup_overrides.json` | hand-edited | manual matchup pairings, keyed `{season: {week: [[t1, t2], ...]}}` |

Yahoo issues a **new game key every season**, and renewed leagues also get a
**new league ID**, so the whole league key (`{game_key}.l.{league_id}`) changes
every year. That is why discovery exists rather than a hardcoded key.

Discovery tries two routes:

1. `/users;use_login=1/games;game_codes=nhl/leagues` — lists every league the
   account has joined. Some apps get **HTTP 403** on this collection even with
   working credentials, because it reads the user record rather than a league.
2. **Renew chain** (automatic fallback) — follows each league's `renew` field
   back through history using only league-scoped reads.

A 403 is not a credentials problem. If the token refresh printed no error, auth
is fine — some apps are restricted to league-scoped endpoints and are refused on
anything that reads a user or a game.

The chain needs a league key to start from, resolved cheapest-first:

1. `--start-key 449.l.1809`
2. `$YAHOO_LEAGUE_KEY` — the key a working Yahoo tool already uses
3. `/game/nhl` + `--league <id>`
4. probing game keys against `--league <id>` (slow, last resort)

If everything but league reads is refused, pass a key you know works:

```bash
python scripts/discover_leagues.py --start-key 449.l.1809
```

## First-time setup

```bash
# 1. Find every season this account has played, and write the fetch config
python scripts/discover_leagues.py --league 1809

# 2. See what is configured and what has already been fetched
python scripts/fetch_data.py --list

# 3. Pull the full history (slow -- see below)
python scripts/fetch_data.py --backfill --skip-complete
```

## Routine use

```bash
python scripts/fetch_data.py                    # current season (what the Action runs)
python scripts/fetch_data.py --season 2024-25   # one season
python scripts/fetch_data.py --refetch-all --season 2025-26   # ignore the week cache
```

Completed weeks are cached and skipped. Only the live week and the one before it
are refetched, since Yahoo backdates stat corrections.

## Backfilling

A season is roughly `weeks × teams × 2` Yahoo calls — about 500 per season, so a
twelve-year backfill is upwards of 6,000 requests. Run it **locally, not in the
Action**, and expect it to take a while.

It is resumable. If it is interrupted or throttled, rerun the same command:
`--skip-complete` skips any season whose file is already marked complete, and
within a season completed weeks are already cached.

Tune the pacing with `YAHOO_CALL_DELAY` (seconds between calls, default `0.12`):

```bash
YAHOO_CALL_DELAY=0.3 python scripts/fetch_data.py --backfill --skip-complete
```

## Notes

- **Finished seasons have no live week.** `is_finished` is read from the league
  endpoint; without it Yahoo's still-advancing `current_week` would mark the last
  week of every historical season as in progress and drop it from the standings.
- **Teams are keyed by display name**, which managers change between seasons.
  Manager `guid` and `team_key` are captured into each season's `teams` block so
  cross-season aggregation can key on the manager instead. Per-season views are
  unaffected.
- **League size can change between seasons.** `num_teams` from the manifest wins
  over the `TOTAL_TEAMS` environment variable.

## All-play standings (Season tab)

`docs/allplay.js` computes all-play records, luck (Δ win %) and strength of schedule from the
weekly stats and matchups already in each season file; `docs/app.js` draws the scatter and
table. The calculation has a small hand-made test:

```bash
node tests/allplay.test.js
```
