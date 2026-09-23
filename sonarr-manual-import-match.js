#!/usr/bin/env node
/**
 * Sonarr Manual Import Auto-Matcher
 * ---------------------------------
 * Solves the "unknown season" manual import problem: when a folder of episode
 * files isn't organized by season, Sonarr's Manual Import screen forces you to
 * check every season/episode by hand to find the right match.
 *
 * This script talks directly to the Sonarr v3 API instead of the UI:
 *   1. Pulls the pending manual-import file list for a folder.
 *   2. Pulls the FULL episode list for the target series (every season).
 *   3. For each file, extracts whatever episode clues are in the filename
 *      (SxxEyy, 3/4-digit codes, absolute episode number, or episode title
 *      text) and scores it against every episode in the series.
 *   4. Prints the best match (with a confidence score) for review, and
 *      optionally submits the matches back to Sonarr to complete the import.
 *
 * Requires Node.js 18+ (built-in fetch).
 *
 * USAGE
 *   node sonarr-manual-import-match.js --url http://localhost:8989 \
 *       --api-key YOUR_API_KEY --folder "/data/downloads/show" \
 *       --series "Show Name" [--min-score 0.55] [--apply] [--import-mode auto] \
 *       [--interactive]
 *
 * Run WITHOUT --apply first. It only prints proposed matches (dry run).
 * Add --apply once you're happy with the proposed matches to actually
 * submit them to Sonarr (this triggers the same action as clicking
 * "Import" for each file on the Manual Import screen).
 *
 * Add --interactive to get prompted for each NO MATCH file so you can pick
 * the correct episode by hand (SxxEyy, or a title search) instead of
 * leaving it for the Sonarr UI.
 */

const args = parseArgs(process.argv.slice(2));
const readline = require('node:readline/promises');

const SONARR_URL = (args.url || '').replace(/\/$/, '');
const API_KEY = args['api-key'];
const FOLDER = args.folder;
const SERIES_QUERY = args.series;
const SERIES_ID_ARG = args['series-id'] ? Number(args['series-id']) : null;
const MIN_SCORE = args['min-score'] ? Number(args['min-score']) : 0.55;
const APPLY = Boolean(args.apply);
const IMPORT_MODE = args['import-mode'] || 'auto';
const INTERACTIVE = Boolean(args.interactive);

if (!SONARR_URL || !API_KEY || !FOLDER || (!SERIES_QUERY && !SERIES_ID_ARG)) {
  console.error(
    'Missing required args. Need --url, --api-key, --folder, and --series (or --series-id).'
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

async function main() {
  const seriesId = SERIES_ID_ARG || (await findSeriesId(SERIES_QUERY));
  console.log(`Using series id ${seriesId}`);

  const [importFiles, episodes, series] = await Promise.all([
    getManualImportFiles(FOLDER),
    getAllEpisodes(seriesId),
    getSeries(seriesId),
  ]);

  if (importFiles.length === 0) {
    console.log('No files found for that folder in Manual Import.');
    return;
  }
  console.log(`Found ${importFiles.length} file(s) to match against ${episodes.length} episode(s).\n`);

  const matched = [];
  const unmatched = [];

  for (const file of importFiles) {
    const name = file.relativePath || file.name || file.path;
    const best = matchEpisode(name, episodes, series.title);

    if (best && best.score >= MIN_SCORE) {
      matched.push({ file, episode: best.episode, score: best.score, reason: best.reason });
      console.log(
        `MATCH  (${best.score.toFixed(2)}, ${best.reason})  ${name}\n` +
          `   -> S${pad(best.episode.seasonNumber)}E${pad(best.episode.episodeNumber)} "${best.episode.title}"`
      );
    } else {
      unmatched.push({ file, name, best });
      console.log(
        `NO MATCH${best ? ` (best guess ${best.score.toFixed(2)} < ${MIN_SCORE}, ${best.reason})` : ''}  ${name}`
      );
    }
  }

  console.log(`\n${matched.length} matched, ${unmatched.length} need manual review.`);

  if (INTERACTIVE && unmatched.length > 0) {
    await resolveUnmatchedInteractively(unmatched, episodes, matched);
    console.log(`\n${matched.length} matched, ${unmatched.length} still unresolved.`);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to submit these matches to Sonarr.');
    return;
  }

  if (matched.length === 0) {
    console.log('Nothing to apply.');
    return;
  }

  await applyManualImport(seriesId, matched);
  console.log(`Submitted ${matched.length} file(s) to Sonarr for import.`);
}

// ---------- Interactive resolution ----------

async function resolveUnmatchedInteractively(unmatched, episodes, matched) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    '\n--- Interactive review ---\n' +
      'For each file, enter SxxEyy (e.g. S02E14) to pick that episode,\n' +
      'a search term to look up episodes by title, blank to skip, or "q" to stop.\n'
  );

  try {
    for (let i = unmatched.length - 1; i >= 0; i--) {
      const { name, best } = unmatched[i];
      console.log(`\n[${unmatched.length - i}/${unmatched.length}] ${name}`);
      if (best) {
        console.log(
          `   best guess: S${pad(best.episode.seasonNumber)}E${pad(best.episode.episodeNumber)} ` +
            `"${best.episode.title}" (${best.score.toFixed(2)}, ${best.reason})`
        );
      }

      const episode = await promptForEpisode(rl, episodes);
      if (episode === 'quit') break;
      if (!episode) continue;

      matched.push({ file: unmatched[i].file, episode, score: 1, reason: 'manual pick' });
      unmatched.splice(i, 1);
      console.log(`   -> picked S${pad(episode.seasonNumber)}E${pad(episode.episodeNumber)} "${episode.title}"`);
    }
  } finally {
    rl.close();
  }
}

async function promptForEpisode(rl, episodes) {
  while (true) {
    const input = (await rl.question('   > ')).trim();
    if (!input) return null;
    if (input.toLowerCase() === 'q') return 'quit';

    const sxxe = input.match(/^[sS](\d{1,2})[eE](\d{1,3})$/);
    if (sxxe) {
      const found = episodes.find(
        (e) => e.seasonNumber === Number(sxxe[1]) && e.episodeNumber === Number(sxxe[2])
      );
      if (found) return found;
      console.log('   No episode with that season/episode number, try again.');
      continue;
    }

    const results = episodes
      .map((e) => ({ episode: e, score: titleSimilarity(normalizeTitle(input), normalizeTitle(e.title || '')) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    if (results.length === 0) {
      console.log('   No matches for that search, try again (or blank to skip).');
      continue;
    }

    results.forEach((r, idx) => {
      console.log(
        `   [${idx + 1}] S${pad(r.episode.seasonNumber)}E${pad(r.episode.episodeNumber)} "${r.episode.title}"`
      );
    });
    const choice = (await rl.question('   pick number (or blank to search again): ')).trim();
    if (!choice) continue;
    const idx = Number(choice) - 1;
    if (Number.isInteger(idx) && results[idx]) return results[idx].episode;
    console.log('   Invalid choice, try again.');
  }
}

// ---------- Sonarr API helpers ----------

async function sonarrFetch(path, options = {}) {
  const res = await fetch(`${SONARR_URL}${path}`, {
    ...options,
    headers: {
      'X-Api-Key': API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${options.method || 'GET'} ${path} failed: ${res.status} ${res.statusText} ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function findSeriesId(query) {
  const all = await sonarrFetch('/api/v3/series');
  const normalizedQuery = normalizeTitle(query);
  const exact = all.find((s) => normalizeTitle(s.title) === normalizedQuery);
  if (exact) return exact.id;

  const partial = all.filter((s) => normalizeTitle(s.title).includes(normalizedQuery));
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) {
    console.error('Multiple series matched, pass --series-id instead:');
    partial.forEach((s) => console.error(`  ${s.id}: ${s.title} (${s.year})`));
    process.exit(1);
  }
  throw new Error(`No series found matching "${query}"`);
}

async function getManualImportFiles(folder) {
  // Omit seriesId here: Sonarr's correlation against a series' existing
  // episode files can silently return an empty list if that series' path
  // is in a broken state. We do our own episode matching below instead.
  const qs = new URLSearchParams({
    folder,
    filterExistingFiles: 'true',
  });
  return sonarrFetch(`/api/v3/manualimport?${qs.toString()}`);
}

async function getAllEpisodes(seriesId) {
  return sonarrFetch(`/api/v3/episode?seriesId=${seriesId}`);
}

async function getSeries(seriesId) {
  return sonarrFetch(`/api/v3/series/${seriesId}`);
}

async function applyManualImport(seriesId, matched) {
  const files = matched.map(({ file, episode }) => ({
    id: file.id,
    path: file.path,
    folderName: file.folderName,
    seriesId,
    seasonNumber: episode.seasonNumber,
    episodeIds: [episode.id],
    releaseGroup: file.releaseGroup,
    quality: file.quality,
    languages: file.languages,
    indexerFlags: file.indexerFlags,
    releaseType: file.releaseType,
  }));

  // The actual import trigger is the "ManualImport" command, not a POST to
  // /api/v3/manualimport (that endpoint is only for reprocessing UI rows and
  // expects a raw array body).
  return sonarrFetch('/api/v3/command', {
    method: 'POST',
    body: JSON.stringify({ name: 'ManualImport', files, importMode: IMPORT_MODE }),
  });
}

// ---------- Matching logic ----------

function matchEpisode(filename, episodes, seriesTitle) {
  const base = stripExtension(filename);

  // 1. Explicit SxxEyy / 1x02 style tags.
  const sxxe = base.match(/[sS](\d{1,2})[._ -]?[eE](\d{1,3})/);
  if (sxxe) {
    const season = Number(sxxe[1]);
    const ep = Number(sxxe[2]);
    const found = episodes.find((e) => e.seasonNumber === season && e.episodeNumber === ep);
    if (found) return { episode: found, score: 1, reason: 'SxxEyy tag' };
  }
  const xForm = base.match(/(?<![\d])(\d{1,2})x(\d{1,3})(?![\d])/i);
  if (xForm) {
    const season = Number(xForm[1]);
    const ep = Number(xForm[2]);
    const found = episodes.find((e) => e.seasonNumber === season && e.episodeNumber === ep);
    if (found) return { episode: found, score: 1, reason: '1x02 tag' };
  }

  // 2. Standalone "E12" / "Ep 12" / "Episode 12" without a season -> match
  //    by episode number across seasons only if it's unambiguous.
  const eOnly = base.match(/\b[eE]p?(?:isode)?[._ -]?(\d{1,3})\b/);
  if (eOnly) {
    const ep = Number(eOnly[1]);
    const candidates = episodes.filter((e) => e.episodeNumber === ep);
    if (candidates.length === 1) return { episode: candidates[0], score: 0.9, reason: 'E## tag (unique)' };
  }

  // 3. Absolute episode number (common for anime-style releases: "- 105 -").
  const abs = base.match(/(?:^|[^\d])(\d{2,4})(?:[^\d]|$)/);
  if (abs) {
    const num = Number(abs[1]);
    const found = episodes.find((e) => e.absoluteEpisodeNumber === num);
    if (found) return { episode: found, score: 0.85, reason: 'absolute episode number' };

    // 3b. 3/4-digit compact SxxEyy, e.g. "105" = S1E05, "1203" = S12E03.
    if (num >= 100 && num <= 9999) {
      const str = String(num);
      const splits =
        str.length === 3
          ? [[str.slice(0, 1), str.slice(1)]]
          : [
              [str.slice(0, 1), str.slice(1)],
              [str.slice(0, 2), str.slice(2)],
            ];
      for (const [s, e] of splits) {
        const season = Number(s);
        const ep = Number(e);
        const found = episodes.find((ep2) => ep2.seasonNumber === season && ep2.episodeNumber === ep);
        if (found) return { episode: found, score: 0.7, reason: 'compact SxxEyy number' };
      }
    }
  }

  // 4. Fuzzy match against episode titles (handles files named after the
  //    episode title with no numbering at all).
  const cleanedName = normalizeTitle(
    collapseAcronyms(base)
      .replace(/^\d{1,4}\s+/, '') // drop a leading track/episode counter, e.g. "200   Jerrys Nephew"
      .replace(/[[(](19|20)\d{2}[\])]/g, '') // drop a bracketed/parenthesized year, e.g. "[1975]"
      .replace(/[._]/g, ' ')
      .replace(/\b(1080p|720p|2160p|x264|x265|h264|h265|hevc|web[- ]?dl|webrip|bluray|hdtv|amzn|nf|dv|hdr)\b/gi, '')
  );

  // Files are often named "<Series Title> in -<Episode Title>" or
  // "<Series Title> - <Episode Title>". Strip the leading series title (and
  // filler words like "in"/"episode") so we don't accidentally match a
  // special/episode that happens to be titled the same as the series itself.
  // Only fall back to the unstripped name when stripping had no effect
  // (e.g. series title prefix wasn't found) — keeping both as candidates
  // lets episodes titled after the series itself win via the raw prefix.
  const strippedName = stripSeriesPrefix(cleanedName, seriesTitle);
  const candidates = strippedName && strippedName !== cleanedName ? [strippedName] : [cleanedName];

  let best = null;
  let tieCount = 0;
  for (const episode of episodes) {
    if (!episode.title) continue;
    const normalizedEpisodeTitle = normalizeTitle(
      collapseAcronyms(episode.title).toLowerCase()
    );
    for (const candidate of candidates) {
      const score = titleSimilarity(candidate, normalizedEpisodeTitle);
      if (!best || score > best.score) {
        best = { episode, score };
        tieCount = 1;
      } else if (score === best.score && score > 0 && episode.id !== best.episode.id) {
        tieCount++;
      }
    }
  }
  if (best) {
    // Multiple distinct episodes tied for the top score (e.g. both reduced to
    // just "pink" after stripping filler words) -- too ambiguous to trust.
    const confidence = tieCount > 1 ? best.score * 0.4 : best.score * 0.8;
    const reason = tieCount > 1 ? 'title similarity (ambiguous)' : 'title similarity';
    return { episode: best.episode, score: confidence, reason };
  }

  return null;
}

function collapseAcronyms(str) {
  // "U.F.O." / "G.I." / "S.W.A.T." / "Z-Z-Z" -> "UFO" / "GI" / "SWAT" / "ZZZ"
  // so single letters aren't lost to the short-word filter in titleSimilarity.
  return str.replace(/\b(?:[A-Za-z][.-]){1,}[A-Za-z]\b/g, (m) => m.replace(/[.-]/g, ''));
}

function stripSeriesPrefix(cleanedName, seriesTitle) {
  if (!seriesTitle) return cleanedName;
  const normalizedSeries = normalizeTitle(seriesTitle);
  if (!normalizedSeries || !cleanedName.startsWith(normalizedSeries)) return cleanedName;
  return cleanedName
    .slice(normalizedSeries.length)
    .trim()
    .replace(/^(in|episode|ep) /, '')
    .trim();
}

function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.split(' ').filter((w) => w.length > 2));
  const setB = new Set(b.split(' ').filter((w) => w.length > 2));
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const w of setA) if (setB.has(w)) overlap++;
  return (2 * overlap) / (setA.size + setB.size);
}

function normalizeTitle(str) {
  return String(str)
    .toLowerCase()
    .replace(/['’]/g, '') // drop apostrophes so "jerry's" -> "jerrys", matching how filenames usually drop them
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripExtension(filename) {
  return filename.replace(/\.[a-zA-Z0-9]{2,4}$/, '');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
