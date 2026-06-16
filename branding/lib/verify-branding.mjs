#!/usr/bin/env node
// CI gate (~1s, no native build): validates every brand config in branding/brands/.
// Asserts: required fields present, appId reverse-DNS + mutually distinct, icon
// file exists. Use as the PR check for branding changes.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrand } from './apply-branding.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const brandsDir = join(rootDir, 'branding/brands');

const files = readdirSync(brandsDir).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.error('no brand configs found in branding/brands/');
  process.exit(1);
}

let failures = 0;
const appIds = new Map();
const ids = new Map();
for (const f of files) {
  const path = join(brandsDir, f);
  try {
    const brand = loadBrand(path);
    const iconPath = resolve(dirname(path), brand.icon);
    if (!existsSync(iconPath)) throw new Error(`icon not found: ${brand.icon}`);
    if (appIds.has(brand.appId)) throw new Error(`appId "${brand.appId}" also used by ${appIds.get(brand.appId)}`);
    if (ids.has(brand.id)) throw new Error(`id "${brand.id}" also used by ${ids.get(brand.id)}`);
    appIds.set(brand.appId, f);
    ids.set(brand.id, f);
    console.log(`✓ ${f} — ${brand.productName} (${brand.appId})`);
  } catch (err) {
    console.error(`✗ ${f} — ${err.message}`);
    failures++;
  }
}

if (failures) {
  console.error(`\n${failures} brand config(s) invalid`);
  process.exit(1);
}
console.log(`\n${files.length} brand config(s) valid`);
