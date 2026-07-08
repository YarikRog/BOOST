/* One-off: create region + store for the pilot (store #1, no invite hierarchy).
 * Prints the two deep-links to hand to the director.
 * Usage: DATABASE_URL=... BOT_USERNAME=... node scripts/create-pilot-store.js "Comfy Лавіна"
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  const botUsername = process.env.BOT_USERNAME;
  const storeName = process.argv[2];
  if (!url || !botUsername || !storeName) {
    console.error('Usage: DATABASE_URL=... BOT_USERNAME=... node scripts/create-pilot-store.js "<store name>"');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  const { rows: regionRows } = await client.query(
    `insert into regions (name) values ($1) returning id`,
    [`Pilot — ${storeName}`],
  );
  const regionId = regionRows[0].id;

  const { rows: storeRows } = await client.query(
    `insert into stores (region_id, name) values ($1, $2) returning id`,
    [regionId, storeName],
  );
  const storeId = storeRows[0].id;

  await client.end();

  console.log(`Store created: ${storeName} (${storeId})`);
  console.log('');
  console.log('Director link (send privately, once):');
  console.log(`  https://t.me/${botUsername}?start=dir_${storeId}`);
  console.log('');
  console.log('Seller link (director forwards this to the team):');
  console.log(`  https://t.me/${botUsername}?start=store_${storeId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
