# PWW Hockey — data pipeline

The dashboard reads one JSON file per season plus a manifest, so the site can
show any season the account has data for.

## Files

| File | Written by | Purpose |
|---|---|---|
| `docs/league_keys.json` | `discover_leagues.py` | season → Yahoo league key (fetch config) |
| `docs/data-<season>.json` | `fetch_data.py` | one season of results |
| `docs/seasons.json` | `fetch_data.py` | manifest the front end reads to build the season selector |
| `docs/data.json` | `fetch_data.py` | copy of the current season, kept for backwards compatibility |
| `docs/matchup_overrides.json` | hand-edited | manual matchup pairings, keyed `{season: {week: [[t1, t2], ...]}}` |

Yahoo issues a **new game key every season**, so the league key
(`{game_key}.l.{league_id}`) changes each year even though the league ID does
not. That is why discovery exists rather than a hardcoded key.

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
