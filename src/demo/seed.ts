/**
 * Seeds the demo database.
 *
 * The data is deliberately shaped to exercise the interesting paths: an
 * `email` column to mask, a `salaries` table to deny, a wide-ish orders table
 * to hit the row cap, and enough rows that EXPLAIN has something to say.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FIRST = ['Aoi', 'Haruto', 'Yui', 'Ren', 'Mei', 'Sota', 'Rin', 'Kaito', 'Hana', 'Riku'];
const LAST = ['Sato', 'Suzuki', 'Takahashi', 'Tanaka', 'Ito', 'Watanabe', 'Yamamoto', 'Nakamura'];
const CITIES = ['Tokyo', 'Osaka', 'Nagoya', 'Fukuoka', 'Sapporo', 'Sendai'];
const PRODUCTS = [
  ['Standing desk', 'furniture', 48_000],
  ['Mechanical keyboard', 'peripherals', 16_800],
  ['27" monitor', 'peripherals', 39_800],
  ['Ergonomic chair', 'furniture', 72_000],
  ['USB-C dock', 'peripherals', 12_400],
  ['Desk lamp', 'furniture', 6_800],
  ['Noise-cancelling headphones', 'audio', 44_000],
  ['Webcam', 'peripherals', 9_800],
] as const;

/** A small deterministic PRNG, so the demo numbers are the same every run. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function seed(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  const random = makeRandom(20260914);

  db.exec(`
    DROP TABLE IF EXISTS order_items;
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS products;
    DROP TABLE IF EXISTS customers;
    DROP TABLE IF EXISTS employee_salaries;

    CREATE TABLE customers (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      phone       TEXT,
      city        TEXT NOT NULL,
      signed_up   TEXT NOT NULL
    );

    CREATE TABLE products (
      id       INTEGER PRIMARY KEY,
      name     TEXT NOT NULL,
      category TEXT NOT NULL,
      price    INTEGER NOT NULL
    );

    CREATE TABLE orders (
      id          INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      placed_at   TEXT NOT NULL,
      status      TEXT NOT NULL
    );

    CREATE TABLE order_items (
      id         INTEGER PRIMARY KEY,
      order_id   INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity   INTEGER NOT NULL
    );

    -- Present so the demo has something the policy can deny.
    CREATE TABLE employee_salaries (
      id      INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      annual  INTEGER NOT NULL
    );
  `);

  const insertCustomer = db.prepare(
    'INSERT INTO customers (id, name, email, phone, city, signed_up) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertProduct = db.prepare(
    'INSERT INTO products (id, name, category, price) VALUES (?, ?, ?, ?)',
  );
  const insertOrder = db.prepare(
    'INSERT INTO orders (id, customer_id, placed_at, status) VALUES (?, ?, ?, ?)',
  );
  const insertItem = db.prepare(
    'INSERT INTO order_items (id, order_id, product_id, quantity) VALUES (?, ?, ?, ?)',
  );
  const insertSalary = db.prepare(
    'INSERT INTO employee_salaries (id, name, annual) VALUES (?, ?, ?)',
  );

  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const day = (offset: number) =>
    new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

  db.transaction(() => {
    PRODUCTS.forEach(([name, category, price], i) => {
      insertProduct.run(i + 1, name, category, price);
    });

    for (let id = 1; id <= 400; id += 1) {
      const first = pick(FIRST);
      const last = pick(LAST);
      insertCustomer.run(
        id,
        `${first} ${last}`,
        `${first.toLowerCase()}.${last.toLowerCase()}${id}@example.com`,
        `080-${String(1000 + Math.floor(random() * 9000))}-${String(1000 + Math.floor(random() * 9000))}`,
        pick(CITIES),
        day(Math.floor(random() * 250)),
      );
    }

    let itemId = 1;
    for (let id = 1; id <= 2500; id += 1) {
      insertOrder.run(
        id,
        1 + Math.floor(random() * 400),
        day(Math.floor(random() * 250)),
        pick(['placed', 'shipped', 'delivered', 'cancelled'] as const),
      );
      const lines = 1 + Math.floor(random() * 3);
      for (let n = 0; n < lines; n += 1) {
        insertItem.run(
          itemId++,
          id,
          1 + Math.floor(random() * PRODUCTS.length),
          1 + Math.floor(random() * 3),
        );
      }
    }

    for (let id = 1; id <= 25; id += 1) {
      insertSalary.run(id, `${pick(FIRST)} ${pick(LAST)}`, 4_000_000 + Math.floor(random() * 8_000_000));
    }
  })();

  db.exec('CREATE INDEX idx_orders_customer ON orders(customer_id)');
  db.exec('CREATE INDEX idx_items_order ON order_items(order_id)');
  db.close();
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes('seed');

if (invokedDirectly) {
  const target = process.argv[2] ?? 'demo/shop.db';
  seed(target);
  process.stdout.write(`seeded ${target}\n`);
}
