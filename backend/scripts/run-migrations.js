/* Minimal forward-only migration runner.
 * Runs migrations/*.sql in filename order, each once, tracked in _migrations.
 * Usage: DATABASE_URL=... node scripts/run-migrations.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const client = new Client({ connectionString: url });
  await client.connect();

  await client.query(
    'create table if not exists _migrations (name text primary key, run_at timestamptz not null default now())',
  );

  for (const file of files) {
    const { rowCount } = await client.query('select 1 from _migrations where name = $1', [file]);
    if (rowCount) {
      console.log(`skip   ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`apply  ${file}`);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into _migrations(name) values ($1)', [file]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      console.error(`failed ${file}: ${e.message}`);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log('migrations done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
