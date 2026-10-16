/**
 * ycp doctor: does this checkout match what the tests expect?
 *
 * WHY THIS EXISTS
 *
 * Sixteen tests failed on a machine where the code was correct. The cause
 * was not a defect. Some folders had been copied over and others had not,
 * so the test files were from one round of work and the source files were
 * from an earlier one. The symptoms were misleading in the worst way: a
 * missing route answers 404, which reads exactly like a permission
 * decision, and an unseeded flag answers "not eligible", which reads
 * exactly like a participant who has not finished.
 *
 * Debugging that from the test output costs an hour. Asking the three
 * questions directly costs two seconds:
 *
 *   1. Are the FILES on disk the current ones?
 *   2. Have the MIGRATIONS been applied to this database?
 *   3. Has the SEED been re-run since those migrations?
 *
 * Every check below prints the fix next to the failure, because a
 * diagnostic that tells you something is wrong without telling you what to
 * do is only half a diagnostic.
 *
 * Run:  npm --workspace server run db:doctor
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { pool, closePool } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

const results = [];

function record(ok, label, detail, fix) {
  results.push({ ok, label, detail, fix });
}

// Two checks can look at the same file for different markers, so the
// label carries the marker. A report with two identical rows tells you
// nothing about which one failed.
function fileLabel(check) {
  return `${check.file} (${check.needle})`;
}

/* ==================================================================== */
/* 1. FILES                                                             */
/*                                                                      */
/* A file can be absent, or present but stale. Both fail the same way at */
/* runtime, so both are checked the same way: does the file exist, and   */
/* does it contain the marker that the current version introduced?      */
/* ==================================================================== */

const fileChecks = [
  {
    file: 'src/routes/pacing.routes.js',
    needle: 'module_schedule',
    why: 'the schedule, grades and module-meta endpoints'
  },
  {
    file: 'src/app.js',
    needle: 'pacingRoutes',
    why: 'mounting those endpoints (without this they answer 404)'
  },
  {
    file: 'src/routes/catalogue.routes.js',
    needle: 'a.skills',
    why: 'skills on the public course page'
  },
  {
    file: 'src/routes/catalogue.routes.js',
    needle: 'm.objectives',
    why: 'per-module objectives on the public course page'
  },
  {
    file: 'src/routes/certificate.routes.js',
    needle: 'activity_id',
    why: 'linking a certificate back to its course'
  },
  {
    file: 'db/seed.js',
    needle: 'awards_certificate',
    why: 'turning certificates on for the demo courses'
  },
  {
    file: 'db/seed.js',
    needle: 'week_offset',
    why: 'giving modules a week so the timeline has dates'
  }
];

async function checkFiles() {
  for (const check of fileChecks) {
    const full = path.join(serverRoot, check.file);
    let text;
    try {
      text = await readFile(full, 'utf8');
    } catch {
      record(false, fileLabel(check), 'missing', `Copy server/${check.file} across. It carries ${check.why}.`);
      continue;
    }
    if (!text.includes(check.needle)) {
      record(
        false,
        fileLabel(check),
        'present but an older version',
        `This is an older copy of the file. Replace server/${check.file}. It should carry ${check.why}.`
      );
      continue;
    }
    record(true, fileLabel(check), 'current', null);
  }
}

/* ==================================================================== */
/* 2. MIGRATIONS                                                        */
/*                                                                      */
/* Two different failures hide here. A migration file can be missing    */
/* from disk, or present on disk and never applied. The ledger answers  */
/* the second; reading the directory answers the first.                 */
/* ==================================================================== */

async function checkMigrations() {
  const dir = path.join(here, 'migrations');
  let onDisk = [];
  try {
    onDisk = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  } catch {
    record(false, 'db/migrations', 'directory missing', 'Copy server/db/migrations across.');
    return;
  }

  let applied = new Set();
  try {
    const rows = await pool.query('SELECT version FROM schema_migrations');
    applied = new Set(rows.rows.map((row) => row.version));
  } catch {
    record(
      false,
      'schema_migrations',
      'table missing',
      'No migration has ever run against this database. Run: npm --workspace server run db:migrate'
    );
    return;
  }

  const versions = onDisk.map((name) => name.replace(/\.sql$/, ''));
  const pending = versions.filter((version) => !applied.has(version));

  if (pending.length > 0) {
    record(
      false,
      'migrations',
      `${pending.length} on disk but not applied: ${pending.join(', ')}`,
      'Run: npm --workspace server run db:migrate'
    );
  } else {
    record(true, 'migrations', `${versions.length} applied, none pending`, null);
  }

  // A version recorded in the ledger with no file on disk means the
  // checkout is BEHIND the database, which the migration runner cannot
  // fix and which will make newer code fail in confusing ways.
  const orphans = [...applied].filter((version) => !versions.includes(version));
  if (orphans.length > 0) {
    record(
      false,
      'migrations',
      `applied to this database but missing from disk: ${orphans.join(', ')}`,
      'This checkout is older than the database. Copy server/db/migrations across again.'
    );
  }
}

/* ==================================================================== */
/* 3. SEED                                                              */
/*                                                                      */
/* Migrations add COLUMNS. The seed puts VALUES in them. A migration    */
/* that adds awards_certificate leaves it FALSE on rows that already    */
/* exist, and a course that does not award a certificate refuses to     */
/* issue one with a message about eligibility. That is the single most  */
/* confusing failure in this project, so it gets its own check.         */
/* ==================================================================== */

const dataChecks = [
  {
    // ADR-022. This one is first because its symptom is the most
    // misleading in the whole project: a course with a duplicate
    // assessment completes normally and then refuses the certificate
    // with a message about assessments the participant cannot see.
    label: 'no duplicate assessments',
    sql: `SELECT count(*)::int AS n FROM (
            SELECT activity_id FROM assessments
             GROUP BY activity_id, lower(title) HAVING count(*) > 1
          ) AS duplicated`,
    expect: (n) => n === 0,
    detail: (n) => (n === 0 ? 'none' : `${n} course(s) carry a duplicated assessment`),
    fix: 'A course has the same assessment twice, which silently blocks every '
       + 'certificate on it because requires_pass demands a pass on each one. '
       + 'Run: npm --workspace server run db:migrate'
  },
  {
    label: 'certificates enabled',
    sql: `SELECT count(*)::int AS n FROM activities
           WHERE status = 'published' AND awards_certificate`,
    expect: (n) => n > 0,
    detail: (n) => `${n} published course(s) award a certificate`,
    fix: 'No course awards a certificate, so completing one issues nothing and the '
       + 'claim endpoint answers "not eligible". Run: npm --workspace server run db:seed'
  },
  {
    label: 'skills populated',
    sql: `SELECT count(*)::int AS n FROM activities
           WHERE skills IS NOT NULL AND array_length(skills, 1) > 0`,
    expect: (n) => n > 0,
    detail: (n) => `${n} course(s) list skills`,
    fix: 'Courses have no skills, so the public course page has nothing to show. '
       + 'Run: npm --workspace server run db:seed'
  },
  {
    label: 'modules have a week',
    sql: `SELECT count(*)::int AS n FROM activity_modules WHERE week_offset IS NOT NULL`,
    expect: (n) => n > 0,
    detail: (n) => `${n} module(s) are placed in a week`,
    fix: 'No module has a week, so the timeline has no dates to compute. '
       + 'Run: npm --workspace server run db:seed'
  },
  {
    label: 'lesson items exist',
    sql: `SELECT count(*)::int AS n FROM lesson_items`,
    expect: (n) => n > 0,
    detail: (n) => `${n} lesson item(s)`,
    fix: 'Courses have modules but no items inside them, so nothing can be '
       + 'completed. Run: npm --workspace server run db:seed'
  },
  {
    label: 'demo accounts present',
    sql: `SELECT count(*)::int AS n FROM users WHERE status = 'active'`,
    expect: (n) => n >= 3,
    detail: (n) => `${n} active account(s)`,
    fix: 'The tests sign in as the demo accounts. Run: npm --workspace server run db:seed'
  }
];

async function checkData() {
  for (const check of dataChecks) {
    let n;
    try {
      const rows = await pool.query(check.sql);
      n = rows.rows[0].n;
    } catch (error) {
      // A missing column here means a migration has not run, which the
      // migration check above already reported. Say which column, though,
      // because that names the migration.
      record(false, check.label, `query failed: ${error.message}`, 'Run: npm --workspace server run db:migrate');
      continue;
    }
    if (check.expect(n)) record(true, check.label, check.detail(n), null);
    else record(false, check.label, check.detail(n), check.fix);
  }
}

/* ==================================================================== */

async function main() {
  await checkFiles();
  await checkMigrations();
  await checkData();

  const width = results.reduce((max, row) => Math.max(max, row.label.length), 0);
  let failed = 0;

  console.log('');
  for (const row of results) {
    const mark = row.ok ? 'ok  ' : 'FAIL';
    console.log(`  ${mark}  ${row.label.padEnd(width)}  ${row.detail}`);
    if (!row.ok) failed += 1;
  }

  if (failed === 0) {
    console.log('\n  Everything matches. Expect 170 tests passing.\n');
    return 0;
  }

  console.log(`\n  ${failed} problem(s). What to do:\n`);
  const fixes = [...new Set(results.filter((row) => !row.ok).map((row) => row.fix))];
  for (const fix of fixes) console.log(`   - ${fix}`);
  console.log('');
  return 1;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(`\n  Could not run: ${error.message}`);
    console.error('  If this is a connection error, check DATABASE_URL in server/.env\n');
    await closePool();
    process.exit(1);
  });
