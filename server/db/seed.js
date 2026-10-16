import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

/**
 * Seed data for the CAT 1 demonstration.
 *
 * Deliberately includes TWO participants enrolled in the same activity.
 * That pair is what lets you demonstrate the authorisation control live:
 * sign in as Amina, copy the id of her submission out of the URL, sign
 * in as Kwame, paste the id, and watch it return 404 while a denial row
 * appears in access_audit.
 */

const PASSWORD = 'YcpDemo2026!';

const people = [
  // ADR-028: Stephen seeds as the platform's super admin, the only
  // tier that may grant or revoke admin-tier access. Judith, Richard
  // and Eric are ordinary admins, seeded alongside him so the
  // distinction is visible from a fresh install rather than only
  // after someone is promoted by hand.
  { email: 'admin@ycp.africa',       role: 'super_admin', name: 'Stephen Kajjoba',       country: 'UG', literacy: 'advanced' },
  { email: 'judith@ycp.africa',      role: 'admin',        name: 'Judith Atukwatiire',    country: 'UG', literacy: 'advanced' },
  { email: 'richard@ycp.africa',     role: 'admin',        name: 'Ssekyewa Richard',      country: 'UG', literacy: 'advanced' },
  { email: 'eric@ycp.africa',        role: 'admin',        name: 'Eric Naazi',            country: 'UG', literacy: 'advanced' },
  { email: 'facilitator@ycp.africa', role: 'facilitator', name: 'Daniel Mwangi',     country: 'KE', literacy: 'advanced' },
  { email: 'mentor@ycp.africa',      role: 'mentor',      name: 'Grace Mushi',       country: 'TZ', literacy: 'advanced' },
  { email: 'amina@ycp.africa',       role: 'participant', name: 'Amina Uwase',       country: 'RW', literacy: 'intermediate' },
  { email: 'kwame@ycp.africa',       role: 'participant', name: 'Kwame Otieno',      country: 'KE', literacy: 'beginner' },
  { email: 'joseph@ycp.africa',      role: 'participant', name: 'Joseph Ssemakula',  country: 'UG', literacy: 'intermediate' }
];

const activities = [
  {
    slug: 'ai-literacy-foundations',
    title: 'AI Literacy Foundations',
    summary: 'What AI systems actually do, where they fail, and how to judge their output critically.',
    type: 'course',
    tags: ['ai', 'digital-literacy', 'critical-thinking'],
    minutes: 180,
    payloadKb: 420,
    skills: ['Critical evaluation of AI output', 'Prompt literacy',
             'Data bias awareness', 'Responsible technology use'],
    level: 'beginner',
    weeks: 3,
    hoursPerWeek: 2.5,
    outcomes: [
      'Explain in plain language how a machine learning model differs from rules-based software',
      'Recognise confident but incorrect output and say why it happened',
      'Identify whose data is missing from a model and what that costs',
      'Use AI tools in study and work without outsourcing your judgement'
    ],
    prerequisites: ['No prior technical background needed'],
    instructorNote: 'Daniel has spent six years building data systems for agricultural '
      + 'cooperatives across Kenya and Tanzania, and teaches this course the way he '
      + 'wishes it had been taught to him.',
    modules: [
      'How machine learning differs from rules-based software',
      'Recognising confident but wrong output',
      'Bias, training data and who is missing from it',
      'Using AI tools responsibly in study and work'
    ]
  },
  {
    slug: 'employability-in-a-digital-economy',
    title: 'Employability in a Digital Economy',
    summary: 'Positioning your skills for remote and regional opportunities across East Africa.',
    type: 'workshop',
    tags: ['employability', 'careers'],
    minutes: 120,
    payloadKb: 260,
    skills: ['CV and portfolio writing', 'Interviewing', 'Skills mapping',
             'Remote work readiness'],
    level: 'beginner',
    weeks: 2,
    hoursPerWeek: 3,
    outcomes: [
      'Map your existing skills to roles that are actually hiring in the region',
      'Build a portfolio that survives a thirty second scan',
      'Handle an interview across cultures and time zones with confidence'
    ],
    prerequisites: ['Some work or volunteer experience helps, but is not required'],
    modules: [
      'Mapping your transferable skills',
      'A portfolio that survives a 30 second scan',
      'Interviewing across cultures and time zones'
    ]
  },
  {
    slug: 'intercultural-collaboration',
    title: 'Intercultural Collaboration',
    summary: 'Working effectively in cross-border teams with uneven connectivity and different norms.',
    type: 'discussion',
    tags: ['collaboration', 'communication'],
    minutes: 90,
    payloadKb: 95,
    skills: ['Cross-cultural communication', 'Asynchronous collaboration',
             'Written negotiation'],
    level: 'intermediate',
    weeks: 2,
    hoursPerWeek: 1.5,
    languages: ['English', 'Swahili'],
    outcomes: [
      'Work productively with people whose norms and schedules differ from yours',
      'Run asynchronous collaboration when nobody shares a timezone',
      'Disagree in writing without damaging the working relationship'
    ],
    modules: [
      'Assuming good faith across difference',
      'Asynchronous work when nobody shares a schedule',
      'Disagreeing productively in writing'
    ]
  },
  {
    slug: 'critical-thinking-for-problem-solving',
    title: 'Critical Thinking for Problem Solving',
    summary: 'Structured approaches to defining a problem before reaching for a solution.',
    type: 'challenge',
    tags: ['critical-thinking', 'problem-solving'],
    minutes: 150,
    payloadKb: 310,
    skills: ['Problem framing', 'Root cause analysis', 'Evidence evaluation'],
    level: 'intermediate',
    weeks: 4,
    hoursPerWeek: 2,
    outcomes: [
      'Separate a symptom from its cause before proposing a fix',
      'Tell evidence, assumption and inference apart in your own reasoning',
      'Write a problem statement other people can act on'
    ],
    prerequisites: ['Completion of AI Literacy Foundations is helpful but not required'],
    modules: [
      'Separating symptoms from causes',
      'Evidence, assumption and inference',
      'Framing a problem statement others can act on'
    ]
  },
  {
    slug: 'financial-literacy-for-young-professionals',
    title: 'Financial Literacy for Young Professionals',
    summary: 'Budgeting, saving and understanding credit for a first salary or first freelance income.',
    type: 'course',
    tags: ['finance', 'employability', 'life-skills'],
    minutes: 150,
    payloadKb: 300,
    skills: ['Personal budgeting', 'Saving discipline', 'Reading a loan agreement',
             'Avoiding predatory credit'],
    level: 'beginner',
    weeks: 3,
    hoursPerWeek: 2,
    outcomes: [
      'Build a monthly budget that survives an irregular income',
      'Explain what interest, principal and a repayment schedule actually mean',
      'Recognise the warning signs of a predatory loan before signing anything',
      'Set a savings target that a first salary can realistically hit'
    ],
    prerequisites: ['No prior finance background needed'],
    instructorNote: 'Grace has run savings-group training for youth cooperatives in three '
      + 'countries and teaches the same material used in those sessions.',
    modules: [
      'Building a budget on an irregular income',
      'How interest and repayment schedules actually work',
      'Spotting a predatory loan before you sign',
      'Setting a savings target you can keep'
    ]
  },
  {
    slug: 'digital-safety-and-privacy',
    title: 'Digital Safety and Privacy',
    summary: 'Protecting your accounts, your data and your reputation while studying and working online.',
    type: 'course',
    tags: ['digital-literacy', 'safety', 'privacy'],
    minutes: 120,
    payloadKb: 240,
    skills: ['Account security', 'Phishing recognition', 'Privacy settings literacy',
             'Safe online communication'],
    level: 'beginner',
    weeks: 2,
    hoursPerWeek: 2,
    outcomes: [
      'Set up an account so that a stolen password alone cannot take it over',
      'Recognise a phishing attempt before clicking anything',
      'Decide what to share publicly versus privately, and why it matters later',
      'Report and recover from a compromised account calmly'
    ],
    prerequisites: ['No prior technical background needed'],
    modules: [
      'Passwords, phishing and account takeover',
      'What you post outlives the platform it was posted on',
      'Recovering from a compromised account'
    ]
  },
  {
    slug: 'public-speaking-and-facilitation',
    title: 'Public Speaking and Facilitation',
    summary: 'Structuring a talk, holding a room, and running a discussion that stays on track.',
    type: 'workshop',
    tags: ['communication', 'leadership'],
    minutes: 135,
    payloadKb: 270,
    skills: ['Talk structure', 'Managing nerves', 'Facilitating group discussion',
             'Handling difficult questions'],
    level: 'intermediate',
    weeks: 2,
    hoursPerWeek: 2.5,
    outcomes: [
      'Structure a five minute talk that an audience can actually follow',
      'Use a simple technique to manage nerves before speaking',
      'Facilitate a group discussion so one voice does not dominate it',
      'Respond to a hostile or off-topic question without losing the room'
    ],
    prerequisites: ['Comfortable speaking to a small group already'],
    modules: [
      'Structuring a talk an audience can follow',
      'Managing nerves before you speak',
      'Facilitating a discussion without letting one voice dominate',
      'Handling a hostile or off-topic question'
    ]
  },
  {
    slug: 'climate-resilient-agripreneurship',
    title: 'Climate-Resilient Agripreneurship',
    summary: 'Starting a small agriculture-linked business that can withstand an unpredictable climate.',
    type: 'challenge',
    tags: ['entrepreneurship', 'agriculture', 'climate'],
    minutes: 165,
    payloadKb: 330,
    skills: ['Market assessment', 'Climate risk planning', 'Basic costing',
             'Pitching to a cooperative or lender'],
    level: 'intermediate',
    weeks: 3,
    hoursPerWeek: 2,
    languages: ['English', 'Swahili'],
    outcomes: [
      'Assess a local market before committing money to it',
      'Plan around at least one realistic climate shock rather than assuming a normal season',
      'Cost a small venture honestly, including the mistakes first ventures usually make',
      'Pitch a plan to a cooperative or lender in terms they will act on'
    ],
    prerequisites: ['An idea, however rough, for an agriculture-linked venture'],
    instructorNote: 'Daniel built data systems for agricultural cooperatives across Kenya '
      + 'and Tanzania before moving into facilitation, and grounds this challenge in what '
      + 'those cooperatives actually asked new members for.',
    modules: [
      'Assessing a local market honestly',
      'Planning around climate risk instead of a normal season',
      'Costing a small venture without flattering the numbers',
      'Pitching to a cooperative or a lender'
    ]
  }
];

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 12);
  const ids = {};

  console.log('[seed] users');
  for (const person of people) {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, role, status, email_verified)
       VALUES ($1, $2, $3, 'active', TRUE)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [person.email, hash, person.role]
    );
    const id = result.rows[0].id;
    ids[person.email] = id;

    await pool.query(
      `INSERT INTO profiles (user_id, full_name, country, digital_literacy, completeness,
                             headline, disciplines, skills, languages)
       VALUES ($1, $2, $3, $4, 70, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
      [id, person.name, person.country, person.literacy,
       `${person.role === 'participant' ? 'Participant' : 'Programme staff'} from ${person.country}`,
       ['technology'], ['collaboration', 'writing'], ['English', 'Swahili']]
    );
  }

  const facilitatorId = ids['facilitator@ycp.africa'];

  console.log('[seed] activities and modules');
  const activityIds = {};
  for (const activity of activities) {
    const result = await pool.query(
      `INSERT INTO activities
         (slug, title, summary, description, type, status, facilitator_id,
          capacity, estimated_minutes, payload_kb, tags, opens_at)
       VALUES ($1,$2,$3,$4,$5,'published',$6,200,$7,$8,$9, now() - interval '3 days')
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title
       RETURNING id`,
      [activity.slug, activity.title, activity.summary,
       `${activity.summary} This activity runs asynchronously so you can participate when your connection allows.`,
       activity.type, facilitatorId, activity.minutes, activity.payloadKb, activity.tags]
    );
    const activityId = result.rows[0].id;
    activityIds[activity.slug] = activityId;

    /**
     * Certificates and landing-page content.
     *
     * Migrations 004 and 005 both contain an UPDATE for these fields,
     * and on a FRESH database both match zero rows: migrations run
     * before seeding, so there are no activities yet to update.
     *
     * This is the second time that caught me (see docs/test-log.md,
     * migration 004). The rule, stated once: a data migration can only
     * touch rows that already exist when it runs. It is for databases
     * that are already populated. Anything the seed creates, the seed
     * must also populate.
     */
    await pool.query(
      `UPDATE activities
          SET awards_certificate = TRUE,
              certificate_title  = $2,
              level              = $3,
              weeks              = $4,
              hours_per_week     = $5,
              outcomes           = $6,
              prerequisites      = $7,
              languages          = $8,
              instructor_note    = COALESCE($9, instructor_note),
              skills             = $10
        WHERE id = $1`,
      [activityId, activity.title,
       activity.level ?? 'beginner',
       activity.weeks ?? null,
       activity.hoursPerWeek ?? null,
       activity.outcomes ?? [],
       activity.prerequisites ?? [],
       activity.languages ?? ['English'],
       activity.instructorNote ?? null,
       activity.skills ?? []]
    );

    for (const [index, title] of activity.modules.entries()) {
      const moduleRow = await pool.query(
        `INSERT INTO activity_modules (activity_id, position, title, body, estimated_minutes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (activity_id, position) DO UPDATE SET title = EXCLUDED.title
         RETURNING id`,
        [activityId, index + 1, title,
         `Working notes for "${title}". Content is text first so it loads on a slow connection.`,
         Math.round(activity.minutes / activity.modules.length)]
      );
      const moduleId = moduleRow.rows[0].id;

      // Objectives and a week offset, so the timeline and the
      // collapsible objectives on the landing page have something to
      // show. Module N belongs to week N, which is the default a
      // facilitator would start from anyway.
      await pool.query(
        `UPDATE activity_modules
            SET objectives  = $2,
                week_offset = $3
          WHERE id = $1`,
        [moduleId,
         [`Understand ${title.charAt(0).toLowerCase()}${title.slice(1)}`,
          'Apply it to a situation from your own work or study'],
         index + 1]
      );

      /**
       * Each module gets real lesson items.
       *
       * The seed predated the item model (migration 003), so seeded
       * courses had modules with nothing inside them. That is fine for
       * the API tests, which create their own items, and useless for
       * anyone opening the platform to look at it: the syllabus on the
       * landing page rendered as four empty headings.
       *
       * A demo database whose main screen looks broken is a bad demo,
       * so the seed now produces a course that can actually be read.
       *
       * Note the shape: a reading first, then a short video WITH a
       * transcript. That is ADR-016 expressed in the seed data rather
       * than only in a comment, so the default content demonstrates
       * the low-bandwidth position instead of contradicting it.
       */
      const minutes = Math.round(activity.minutes / activity.modules.length);

      await pool.query(
        `INSERT INTO lesson_items
           (module_id, position, kind, title, body, estimated_minutes, is_required)
         VALUES ($1, 1, 'reading', $2, $3, $4, TRUE)
         ON CONFLICT (module_id, position) DO UPDATE
           SET title = EXCLUDED.title, body = EXCLUDED.body`,
        [moduleId, title,
         `${title}.\n\nThis section is written as text first, because text is the `
         + `cheapest thing this platform can send you. Everything here can be read on a `
         + `slow connection without downloading anything else.\n\n`
         + `Work through it at your own pace. When you are done, mark it complete and `
         + `move on to the next section.`,
         Math.max(5, Math.round(minutes * 0.6))]
      );

      // One video per course rather than per module, on the first
      // module only. A course where every section expects video is
      // exactly the design this platform argues against.
      if (index === 0) {
        await pool.query(
          `INSERT INTO lesson_items
             (module_id, position, kind, title, external_url, transcript,
              duration_seconds, estimated_minutes, is_required)
           VALUES ($1, 2, 'video', $2, $3, $4, 420, 7, FALSE)
           ON CONFLICT (module_id, position) DO UPDATE SET title = EXCLUDED.title`,
          [moduleId,
           `Introduction: ${activity.title}`,
           'https://example.org/ycp/intro',
           `Welcome to ${activity.title}. This transcript covers everything in the `
           + `video, so if you are on a metered connection you can read this instead `
           + `of watching and it will cost you a fraction of the data.`]
        );
      }
    }
  }

  console.log('[seed] assessments');
  const aiActivityId = activityIds['ai-literacy-foundations'];
  // ADR-022: the ONLY insert in this file that once lacked ON CONFLICT.
  // Running the seed twice created a second copy of this quiz, and
  // because requires_pass demands a pass on every assessment attached to
  // the course, that invisible second copy silently stopped every
  // certificate from being issued. Migration 009 makes the database
  // refuse the duplicate; this makes re-seeding update rather than
  // duplicate.
  const assessment = await pool.query(
    `INSERT INTO assessments (activity_id, title, instructions, type, max_score, pass_score, max_attempts, due_at)
     VALUES ($1, 'AI Literacy Check', 'Answer all questions. You have two attempts.',
             'quiz', 100, 60, 2, now() + interval '21 days')
     ON CONFLICT (activity_id, lower(title)) DO UPDATE
       SET instructions = EXCLUDED.instructions,
           max_score    = EXCLUDED.max_score,
           pass_score   = EXCLUDED.pass_score,
           max_attempts = EXCLUDED.max_attempts
     RETURNING id`,
    [aiActivityId]
  );
  const assessmentId = assessment.rows[0].id;

  const questions = [
    {
      prompt: 'A language model states a confident fact that turns out to be false. What is the best description?',
      options: [
        { key: 'a', text: 'The model was hacked' },
        { key: 'b', text: 'The model generated plausible text without verifying it' },
        { key: 'c', text: 'The training data was deleted' },
        { key: 'd', text: 'The user asked the question wrongly' }
      ],
      correct: 'b'
    },
    {
      prompt: 'Why can training data bias matter more in an East African context?',
      options: [
        { key: 'a', text: 'Models run slower on African servers' },
        { key: 'b', text: 'Regional languages and contexts are often underrepresented in training data' },
        { key: 'c', text: 'Bias only affects image models' },
        { key: 'd', text: 'It does not matter' }
      ],
      correct: 'b'
    },
    {
      prompt: 'Which is the strongest way to check an AI-generated claim?',
      options: [
        { key: 'a', text: 'Ask the same model again' },
        { key: 'b', text: 'Check whether the answer sounds confident' },
        { key: 'c', text: 'Trace the claim to an independent primary source' },
        { key: 'd', text: 'Ask a different AI model' }
      ],
      correct: 'c'
    }
  ];

  for (const [index, question] of questions.entries()) {
    await pool.query(
      `INSERT INTO assessment_questions (assessment_id, position, prompt, options, correct_key, points)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (assessment_id, position) DO NOTHING`,
      [assessmentId, index + 1, question.prompt, JSON.stringify(question.options), question.correct]
    );
  }

  console.log('[seed] enrolments and a graded submission');
  for (const email of ['amina@ycp.africa', 'kwame@ycp.africa', 'joseph@ycp.africa']) {
    const enrolment = await pool.query(
      `INSERT INTO enrolments (user_id, activity_id, status, started_at)
       VALUES ($1, $2, 'in_progress', now())
       ON CONFLICT (user_id, activity_id) DO UPDATE SET status = 'in_progress'
       RETURNING id`,
      [ids[email], aiActivityId]
    );
    await pool.query(
      `INSERT INTO module_progress (enrolment_id, module_id, status)
       SELECT $1, m.id, 'not_started' FROM activity_modules m WHERE m.activity_id = $2
       ON CONFLICT (enrolment_id, module_id) DO NOTHING`,
      [enrolment.rows[0].id, aiActivityId]
    );
  }

  const submission = await pool.query(
    `INSERT INTO submissions (assessment_id, user_id, attempt, answers, status, score, submitted_at, graded_at)
     VALUES ($1, $2, 1, '{}'::jsonb, 'graded', 67, now() - interval '2 days', now() - interval '2 days')
     ON CONFLICT (assessment_id, user_id, attempt) DO UPDATE SET score = 67
     RETURNING id`,
    [assessmentId, ids['amina@ycp.africa']]
  );

  await pool.query(
    `INSERT INTO feedback (submission_id, reviewer_id, body, rubric)
     VALUES ($1, $2,
       'Solid grasp of how models fail. Your answer on verification was the weakest: describe the source you would check, not just that you would check one.',
       '{"accuracy": 4, "reasoning": 3, "clarity": 4}'::jsonb)
     ON CONFLICT DO NOTHING`,
    [submission.rows[0].id, facilitatorId]
  );

  console.log('\n[seed] complete');
  console.log(`\n  Password for every demo account: ${PASSWORD}\n`);
  for (const person of people) {
    console.log(`  ${person.role.padEnd(12)} ${person.email}`);
  }
  console.log(`\n  Submission id for the authorisation demo: ${submission.rows[0].id}`);
  console.log('  Sign in as kwame@ycp.africa and request that id to see the control fire.\n');

  await pool.end();
}

main().catch(async (error) => {
  console.error('[seed] failed:', error.message);
  await pool.end();
  process.exit(1);
});
