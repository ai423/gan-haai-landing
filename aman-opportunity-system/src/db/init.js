import 'dotenv/config';
import fs from 'node:fs';
import { db, DB_PATH } from './index.js';

const force = process.argv.includes('--force');

if (force && fs.existsSync(DB_PATH)) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch { /* לא קיים */ }
  }
  console.log(`✓ בסיס הנתונים הישן נמחק: ${DB_PATH}`);
}

db(); // יוצר קובץ + סכימה
console.log(`✓ בסיס הנתונים מוכן: ${DB_PATH}`);
