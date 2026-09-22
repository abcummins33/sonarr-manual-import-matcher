#!/usr/bin/env bash
# Copy this file to run.sh (which is gitignored) and fill in your own values.

# --folder must be the path AS SONARR'S PROCESS SEES IT, not necessarily your
# local/host path. If Sonarr runs in Docker, its volume mounts may map your
# host path to a different path inside the container (e.g. host
# "/mnt/user/downloads/show" -> container "/downloads/show"). Check Sonarr's
# container volume mappings if you're unsure, or browse to the folder from
# Sonarr's own Manual Import UI to confirm the path it expects.

# Dry run first — just prints proposed matches, changes nothing
node sonarr-manual-import-match.js \
  --url "http://localhost:8989" \
  --api-key "YOUR_SONARR_API_KEY" \
  --folder "/path/as/sonarr/sees/it/unsorted/episodes" \
  --series "Series Name"

# Once you trust the output, add --interactive to manually resolve any
# "NO MATCH" files, and --apply to actually submit the matches to Sonarr.
#node sonarr-manual-import-match.js \
#  --url "http://localhost:8989" \
#  --api-key "YOUR_SONARR_API_KEY" \
#  --folder "/path/as/sonarr/sees/it/unsorted/episodes" \
#  --series "Series Name" \
#  --interactive \
#  --apply
