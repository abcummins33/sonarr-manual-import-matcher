# Sonarr Manual Import Season-Matcher

> **Note:** This project's code, docs, and commits were generated entirely by
> generative AI (GitHub Copilot / Claude), with a human reviewing and steering
> the output. Review before running against a production Sonarr instance.

Fixes Sonarr's Manual Import screen when episode files have **no season
folder, an unspecified/ambiguous season, or a season that doesn't match what
Sonarr expects** — e.g. a flat dump of episodes named only by title, or a
download organized differently than your library. Normally Sonarr forces you
to check every season/episode by hand in that case. This script talks
directly to the Sonarr v3 API instead of the UI to do that matching for you.

**Keywords:** Sonarr manual import, missing season folder, unknown season,
season mismatch, unsorted episodes, bulk episode matching, SxxEyy detection,
episode title matching.

## How it works

1. Pulls the pending manual-import file list for a folder.
2. Pulls the full episode list for the target series (every season).
3. For each file, extracts whatever episode clues are in the filename
   (`SxxEyy`, `1x02`, absolute episode number, compact `105`-style codes, or
   episode title text) and scores it against every episode in the series.
4. Prints the best match (with a confidence score) for review, and
   optionally submits the matches back to Sonarr to complete the import.
5. Any file it can't confidently match can be resolved by hand with
   `--interactive`, or left for the Sonarr UI.

## Requirements

- Node.js 18+ (uses the built-in `fetch`).
- A Sonarr v3 instance and an API key (Settings → General → Security).

## Usage

```bash
node sonarr-manual-import-match.js \
  --url http://localhost:8989 \
  --api-key YOUR_API_KEY \
  --folder "/data/downloads/show" \
  --series "Show Name" \
  [--series-id 42] \
  [--min-score 0.55] \
  [--interactive] \
  [--apply] \
  [--import-mode auto]
```

Copy [run.example.sh](run.example.sh) to `run.sh` (already gitignored) and
fill in your own values for a repeatable local command.

**Run without `--apply` first.** It only prints proposed matches (dry run)
and changes nothing in Sonarr.

| Flag | Description |
| --- | --- |
| `--url` | Base URL of your Sonarr instance. |
| `--api-key` | Sonarr API key. |
| `--folder` | Folder path as Sonarr's process sees it (matters if Sonarr runs in Docker with different volume mounts than your host). |
| `--series` | Series title to match against (fuzzy-matched; use `--series-id` if ambiguous). |
| `--series-id` | Sonarr series ID, skips the title lookup. |
| `--min-score` | Minimum confidence (0–1) required to auto-match a file. Default `0.55`. |
| `--interactive` | Prompt for each "NO MATCH" file: enter `SxxEyy` directly, search by episode title, or skip. |
| `--apply` | Actually submit the matches to Sonarr (triggers the same action as clicking "Import" for each file). |
| `--import-mode` | `auto`, `copy`, or `move`. Default `auto`. |

## Notes

- If you get a `manualimport` API error mentioning a missing series path,
  Sonarr couldn't find the series' own library folder on disk — check that
  path/mount exists.
- If Sonarr runs in Docker, `--folder` must be the path as seen **inside**
  the container, which may differ from your host path depending on volume
  mounts.

## License

MIT — see [LICENSE](LICENSE).
