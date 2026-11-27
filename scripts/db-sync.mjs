#!/usr/bin/env node
// Mirrors public/data/landmarks.json into the search database, so that what the live site
// can search is exactly what it shows.
//
//   node scripts/db-sync.mjs            # create/refresh the table and its indexes
//   node scripts/db-sync.mjs --print    # only print the SQL it would run
//
// The database is PlanetScale Postgres (`iconic`, branch `main`), searched with TIN,
// PlanetScale's full-text index. The Worker in worker/ reads it through Cloudflare
// Hyperdrive with a read-only role; this script is the only thing that writes to it.
//
// It talks to the database through the PlanetScale CLI, so no connection string or
// password is needed (or stored) here: `pscale auth login` once on this machine is enough.
// It is safe to re-run: rows are upserted, and landmarks that have left the dataset are
// removed. `npm run deploy` runs it before every deploy.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG = process.env.PSCALE_ORG ?? 'bddicken';
const DATABASE = process.env.PSCALE_DATABASE ?? 'iconic';
const BRANCH = process.env.PSCALE_BRANCH ?? 'main';

const { landmarks } = JSON.parse(await readFile(path.join(ROOT, 'public/data/landmarks.json'), 'utf8'));

// One row per landmark: just what search and filtering need. The app already has the rest.
const rows = landmarks.map((l) => ({
  id: l.id,
  rank: l.rank,
  name: l.name,
  country: l.country,
  region: l.region,
  category: l.category,
  // Everything worth matching beyond the title: where it is, what it is, and the blurb.
  // The name is repeated here so that a query mixing title words with other words
  // ("eiffel paris") can be satisfied by this one column.
  about: [l.name, l.country, l.region, l.category, l.description, l.summary].filter(Boolean).join('. '),
}));

// The data travels as a single dollar-quoted JSON literal, which needs no escaping as long
// as the tag does not occur in the data.
const json = JSON.stringify(rows);
let tag = 'iconic';
while (json.includes(`$${tag}$`)) tag += 'x';

const sql = `\\set ON_ERROR_STOP on
\\set QUIET on

CREATE EXTENSION IF NOT EXISTS tin;

CREATE TABLE IF NOT EXISTS landmarks (
  id       text PRIMARY KEY,
  rank     integer NOT NULL,
  name     text NOT NULL,
  country  text NOT NULL,
  region   text NOT NULL,
  category text NOT NULL,
  about    text NOT NULL
);

-- TIN full-text indexes (one per searched column). English stemming lets "pyramids" find
-- "pyramid" and "falls" find "fall"; case and accents are folded by default.
CREATE INDEX IF NOT EXISTS landmarks_name_tin  ON landmarks USING tin (name)  WITH (stemmer = 'en');
CREATE INDEX IF NOT EXISTS landmarks_about_tin ON landmarks USING tin (about) WITH (stemmer = 'en');
-- Ordinary indexes for the filters and the default ordering.
CREATE INDEX IF NOT EXISTS landmarks_region   ON landmarks (region);
CREATE INDEX IF NOT EXISTS landmarks_category ON landmarks (category);
CREATE INDEX IF NOT EXISTS landmarks_rank     ON landmarks (rank);

BEGIN;

CREATE TEMP TABLE incoming ON COMMIT DROP AS
SELECT * FROM jsonb_to_recordset($${tag}$${json}$${tag}$::jsonb)
  AS x(id text, rank integer, name text, country text, region text, category text, about text);

INSERT INTO landmarks AS l (id, rank, name, country, region, category, about)
SELECT id, rank, name, country, region, category, about FROM incoming
ON CONFLICT (id) DO UPDATE
  SET rank = excluded.rank, name = excluded.name, country = excluded.country,
      region = excluded.region, category = excluded.category, about = excluded.about
  WHERE (l.rank, l.name, l.country, l.region, l.category, l.about)
        IS DISTINCT FROM (excluded.rank, excluded.name, excluded.country, excluded.region, excluded.category, excluded.about);

DELETE FROM landmarks l WHERE NOT EXISTS (SELECT 1 FROM incoming i WHERE i.id = l.id);

COMMIT;

\\set QUIET off
SELECT count(*) AS landmarks_in_database FROM landmarks;
`;

if (process.argv.includes('--print')) {
  process.stdout.write(sql.replace(json, `[... ${rows.length} landmarks ...]`));
  process.exit(0);
}

console.log(`Syncing ${rows.length} landmarks to ${ORG}/${DATABASE} (${BRANCH})...`);
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
    console.error(`\nDatabase sync failed (pscale exited with ${code}). If it is a sign-in problem, run: pscale auth login`);
    process.exit(code ?? 1);
  }
});
