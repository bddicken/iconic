#!/usr/bin/env node
// Loads the landmark dataset into the database, which is what the live site reads.
//
//   node scripts/db-sync.mjs                 # create/alter the tables, then load the data
//   node scripts/db-sync.mjs --schema-only   # only create/alter the tables
//   node scripts/db-sync.mjs --print         # only print the SQL it would run
//
// The database (PlanetScale Postgres `iconic`, branch `main`) is the source of truth for
// the running site: the app gets every landmark from it through the API in worker/, and
// search runs in it with TIN, PlanetScale's full-text index. The Worker connects through
// Cloudflare Hyperdrive with a read-only role; this script is the only thing that writes.
//
// What it loads is public/data/landmarks.json, the output of the data pipeline
// (data/landmarks.seed.json -> scripts/build-data.mjs). That file is a hand-off between
// the pipeline and the database; it is not deployed and the app never reads it.
//
// It talks to the database through the PlanetScale CLI, so no connection string or
// password is needed (or stored) here: `pscale auth login` once on this machine is enough.
// It is safe to re-run: rows are upserted, and landmarks that have left the dataset are
// removed. `npm run deploy` runs it after the site is uploaded, so a new landmark only
// appears once its photos are live.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = process.env.PSCALE_ORG ?? 'bddicken';
const DATABASE = process.env.PSCALE_DATABASE ?? 'iconic';
const BRANCH = process.env.PSCALE_BRANCH ?? 'main';
const SCHEMA_ONLY = process.argv.includes('--schema-only');

const { landmarks, generatedAt } = JSON.parse(await readFile(path.join(ROOT, 'public/data/landmarks.json'), 'utf8'));

const rows = landmarks.map((l) => ({
  id: l.id,
  rank: l.rank,
  name: l.name,
  country: l.country,
  region: l.region,
  category: l.category,
  lat: l.lat,
  lng: l.lng,
  description: l.description ?? '',
  summary: l.summary ?? '',
  popularity: l.popularity,
  pageviews: l.metrics?.pageviews ?? 0,
  wikipedia_languages: l.metrics?.wikipediaLanguages ?? 0,
  wikipedia: l.wikipedia,
  wikidata: l.wikidata ?? null,
  // the main photo (paths, size, colour, credit) and up to three more
  image: l.image,
  gallery: l.gallery ?? [],
  // What search matches beyond the title: where it is, what it is, and the blurb. The
  // name is repeated here so that a query mixing title words with other words
  // ("eiffel paris") can be satisfied by this one column.
  about: [l.name, l.country, l.region, l.category, l.description, l.summary].filter(Boolean).join('. '),
}));

// The data travels as a single dollar-quoted JSON literal, which needs no escaping as long
// as the tag does not occur in the data.
const json = JSON.stringify(rows);
let tag = 'iconic';
while (json.includes('$' + tag + '$')) tag += 'x';
const quoted = '$' + tag + '$' + json + '$' + tag + '$';

const columns = [
  'id', 'rank', 'name', 'country', 'region', 'category', 'lat', 'lng', 'description', 'summary',
  'popularity', 'pageviews', 'wikipedia_languages', 'wikipedia', 'wikidata', 'image', 'gallery', 'about',
];
const list = columns.join(', ');

const schema = [
  '\\set ON_ERROR_STOP on',
  '\\set QUIET on',
  'SET client_min_messages = warning;',
  '',
  'CREATE EXTENSION IF NOT EXISTS tin;',
  '',
  'CREATE TABLE IF NOT EXISTS landmarks (',
  '  id       text PRIMARY KEY,',
  '  rank     integer NOT NULL,',
  '  name     text NOT NULL,',
  '  country  text NOT NULL,',
  '  region   text NOT NULL,',
  '  category text NOT NULL,',
  '  about    text NOT NULL',
  ');',
  '-- Added when the database became the source of truth for the whole record, not just search.',
  'ALTER TABLE landmarks',
  '  ADD COLUMN IF NOT EXISTS lat                 double precision,',
  '  ADD COLUMN IF NOT EXISTS lng                 double precision,',
  "  ADD COLUMN IF NOT EXISTS description         text NOT NULL DEFAULT '',",
  "  ADD COLUMN IF NOT EXISTS summary             text NOT NULL DEFAULT '',",
  '  ADD COLUMN IF NOT EXISTS popularity          real NOT NULL DEFAULT 0,',
  '  ADD COLUMN IF NOT EXISTS pageviews           integer NOT NULL DEFAULT 0,',
  '  ADD COLUMN IF NOT EXISTS wikipedia_languages integer NOT NULL DEFAULT 0,',
  '  ADD COLUMN IF NOT EXISTS wikipedia           text,',
  '  ADD COLUMN IF NOT EXISTS wikidata            text,',
  "  ADD COLUMN IF NOT EXISTS image               jsonb NOT NULL DEFAULT '{}',",
  "  ADD COLUMN IF NOT EXISTS gallery             jsonb NOT NULL DEFAULT '[]';",
  '',
  '-- When the loaded dataset was generated and when it was loaded (a single row).',
  'CREATE TABLE IF NOT EXISTS dataset (',
  '  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),',
  '  generated_at timestamptz,',
  '  synced_at    timestamptz NOT NULL DEFAULT now()',
  ');',
  '',
  '-- TIN full-text indexes (one per searched column). English stemming lets "pyramids" find',
  '-- "pyramid" and "falls" find "fall"; case and accents are folded by default.',
  "CREATE INDEX IF NOT EXISTS landmarks_name_tin  ON landmarks USING tin (name)  WITH (stemmer = 'en');",
  "CREATE INDEX IF NOT EXISTS landmarks_about_tin ON landmarks USING tin (about) WITH (stemmer = 'en');",
  '-- Ordinary indexes for the filters and the default ordering.',
  'CREATE INDEX IF NOT EXISTS landmarks_region   ON landmarks (region);',
  'CREATE INDEX IF NOT EXISTS landmarks_category ON landmarks (category);',
  'CREATE INDEX IF NOT EXISTS landmarks_rank     ON landmarks (rank);',
  '',
].join('\n');

const stamp = generatedAt ? "'" + String(generatedAt).replace(/[^0-9TZ:.+-]/g, '') + "'" : 'NULL';
const load = [
  'BEGIN;',
  '',
  'CREATE TEMP TABLE incoming ON COMMIT DROP AS',
  'SELECT * FROM jsonb_to_recordset(' + quoted + '::jsonb)',
  '  AS x(id text, rank integer, name text, country text, region text, category text,',
  '       lat double precision, lng double precision, description text, summary text,',
  '       popularity real, pageviews integer, wikipedia_languages integer,',
  '       wikipedia text, wikidata text, image jsonb, gallery jsonb, about text);',
  '',
  'INSERT INTO landmarks AS l (' + list + ')',
  'SELECT ' + list + ' FROM incoming',
  'ON CONFLICT (id) DO UPDATE SET',
  '  ' + columns.filter((c) => c !== 'id').map((c) => c + ' = excluded.' + c).join(', '),
  '  WHERE (' + columns.map((c) => 'l.' + c).join(', ') + ')',
  '        IS DISTINCT FROM (' + columns.map((c) => 'excluded.' + c).join(', ') + ');',
  '',
  '-- landmarks that have left the dataset',
  'DELETE FROM landmarks l WHERE NOT EXISTS (SELECT 1 FROM incoming i WHERE i.id = l.id);',
  '',
  'INSERT INTO dataset (singleton, generated_at, synced_at) VALUES (true, ' + stamp + ', now())',
  'ON CONFLICT (singleton) DO UPDATE SET generated_at = excluded.generated_at, synced_at = excluded.synced_at;',
  '',
  'COMMIT;',
  '',
  '\\set QUIET off',
  "SELECT count(*) AS landmarks_in_database, pg_size_pretty(pg_total_relation_size('landmarks')) AS size FROM landmarks;",
  '',
].join('\n');

const sql = SCHEMA_ONLY ? schema : schema + '\n' + load;

if (process.argv.includes('--print')) {
  process.stdout.write(sql.replace(json, '[... ' + rows.length + ' landmarks ...]'));
  process.exit(0);
}

console.log(
  SCHEMA_ONLY
    ? 'Updating the schema of ' + ORG + '/' + DATABASE + ' (' + BRANCH + ')...'
    : 'Loading ' + rows.length + ' landmarks into ' + ORG + '/' + DATABASE + ' (' + BRANCH + ')...',
);
const child = spawn('pscale', ['shell', DATABASE, BRANCH, '--org', ORG, '--role', 'admin'], {
  env: { ...process.env, PSCALE_ALLOW_NONINTERACTIVE_SHELL: '1' },
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.on('error', (err) => {
  console.error(
    err.code === 'ENOENT'
      ? 'The PlanetScale CLI (pscale) is not installed. See https://github.com/planetscale/cli#installation'
      : err.message,
  );
  process.exit(1);
});
child.stdin.end(sql);
child.on('close', (code) => {
  if (code !== 0) {
    console.error('\nDatabase sync failed (pscale exited with ' + code + '). If it is a sign-in problem, run: pscale auth login');
    process.exit(code ?? 1);
  }
});
