import { Router } from 'express';
import PDFDocument from 'pdfkit';
import rateLimit from 'express-rate-limit';
import { query, queryOne } from '../db.js';
import { config } from '../config.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { wrap, sendJson } from '../lib/http.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { recordAccess } from '../lib/audit.js';
import { isAdminRole } from '../lib/roles.js';

const router = Router();

/* ================================================================== */
/* THE PARTICIPANT'S CREDENTIALS                                      */
/* ================================================================== */

/** GET /api/me/certificates */
router.get(
  '/me/certificates',
  authenticate,
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT r.id, r.kind, r.title, r.verification_code, r.recipient_name,
              r.activity_id, r.activity_title, r.score, r.hours,
              r.completed_at, r.issued_at, r.revoked_at, r.revoked_reason,
              a.slug AS activity_slug
         FROM recognitions r
         LEFT JOIN activities a ON a.id = r.activity_id
        WHERE r.user_id = $1
        ORDER BY r.issued_at DESC`,
      [req.user.id]
    );
    return sendJson(req, res, { certificates: rows.rows }, { private: true });
  })
);

/**
 * POST /api/activities/:id/certificate
 *
 * Claim a certificate for a completed activity.
 *
 * The eligibility rule lives in the database function
 * issue_certificate_if_earned, not here. The same question is asked by
 * this endpoint, by an administrator issuing manually, and by any
 * repair script after an incident. Three JavaScript copies of that rule
 * would drift apart; one function cannot.
 *
 * Idempotent: claiming twice returns the existing credential rather
 * than minting a second one with a different verification code.
 */
router.post(
  '/activities/:id/certificate',
  authenticate,
  wrap(async (req, res) => {
    const result = await queryOne(
      `SELECT issue_certificate_if_earned($1, $2) AS id`,
      [req.user.id, req.params.id]
    ).catch(() => null);

    if (!result?.id) {
      // Explain WHY, since "not eligible" with no reason is useless to
      // someone who thinks they finished.
      const status = await queryOne(
        `SELECT a.awards_certificate, a.requires_pass,
                e.status AS enrolment_status,
                (SELECT count(*)::int FROM assessments s WHERE s.activity_id = a.id)
                  AS assessments_total,
                (SELECT count(DISTINCT asm.id)::int
                   FROM assessments asm
                   JOIN submissions sub ON sub.assessment_id = asm.id
                  WHERE asm.activity_id = a.id AND sub.user_id = $1
                    AND sub.score >= asm.pass_score)
                  AS assessments_passed
           FROM activities a
           LEFT JOIN enrolments e ON e.activity_id = a.id AND e.user_id = $1
          WHERE a.id = $2`,
        [req.user.id, req.params.id]
      ).catch(() => null);

      if (!status) throw notFound('Activity');
      if (!status.awards_certificate) {
        throw badRequest('This activity does not award a certificate.');
      }
      if (status.enrolment_status !== 'completed') {
        throw badRequest('Finish every required section first.');
      }
      if (status.requires_pass && status.assessments_passed < status.assessments_total) {
        throw badRequest(
          `Pass all assessments first. You have passed `
          + `${status.assessments_passed} of ${status.assessments_total}.`
        );
      }
      throw badRequest('You are not eligible for this certificate yet.');
    }

    const certificate = await queryOne(
      `SELECT id, title, verification_code, recipient_name, activity_title,
              score, hours, completed_at, issued_at
         FROM recognitions WHERE id = $1`,
      [result.id]
    );

    return sendJson(req, res, { certificate }, { status: 201 });
  })
);

/* ================================================================== */
/* PDF                                                                */
/* ================================================================== */

const BRAND = {
  ink: '#1A1E1C',
  primary: '#17594A',
  gold: '#E8B33A',
  muted: '#6E7671',
  line: '#DCDAD2'
};

/**
 * Draw the certificate.
 *
 * Generated on demand rather than stored. A PDF is a pure function of
 * the snapshot columns on the recognition row, so storing it would mean
 * keeping two representations of one fact in sync for no benefit. It is
 * also about 5 KB, so regenerating costs less than fetching would.
 *
 * Everything drawn comes from the recognition row itself, never from a
 * join to users or activities. That is ADR-017: renaming a course must
 * not retroactively rewrite certificates already awarded.
 */
function drawCertificate(doc, cert, verifyUrl) {
  const { width, height } = doc.page;
  const margin = 36;

  doc.rect(0, 0, width, height).fill('#FFFFFF');

  // Border
  doc.lineWidth(3).strokeColor(BRAND.primary)
     .rect(margin, margin, width - margin * 2, height - margin * 2).stroke();
  doc.lineWidth(0.75).strokeColor(BRAND.gold)
     .rect(margin + 8, margin + 8, width - (margin + 8) * 2, height - (margin + 8) * 2).stroke();

  // The mark, drawn with primitives: three nodes on an arc, the same
  // logo as the web interface, so a printed certificate and the site
  // are recognisably the same thing.
  const cx = width / 2;
  let y = margin + 52;

  doc.save();
  doc.lineWidth(2.5).strokeColor(BRAND.primary).opacity(0.35);
  doc.moveTo(cx - 26, y + 10).bezierCurveTo(cx - 16, y - 6, cx + 16, y - 6, cx + 26, y + 10).stroke();
  doc.opacity(1).lineWidth(2.5).strokeColor(BRAND.primary);
  doc.moveTo(cx - 20, y + 7).lineTo(cx, y - 4).lineTo(cx + 20, y + 7).stroke();
  doc.circle(cx - 20, y + 7, 4).fill(BRAND.primary);
  doc.circle(cx + 20, y + 7, 4).fill(BRAND.primary);
  doc.circle(cx, y - 4, 5).fill(BRAND.gold);
  doc.restore();

  y += 34;
  doc.fillColor(BRAND.ink).font('Helvetica-Bold').fontSize(15)
     .text('YouthConnect', margin, y, { align: 'center', width: width - margin * 2 });

  y += 26;
  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(9)
     .text('CERTIFICATE OF COMPLETION', margin, y,
           { align: 'center', width: width - margin * 2, characterSpacing: 3 });

  y += 34;
  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(11)
     .text('This certifies that', margin, y, { align: 'center', width: width - margin * 2 });

  y += 24;
  doc.fillColor(BRAND.ink).font('Helvetica-Bold').fontSize(30)
     .text(cert.recipient_name, margin, y, { align: 'center', width: width - margin * 2 });

  y += 44;
  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(11)
     .text('has successfully completed', margin, y, { align: 'center', width: width - margin * 2 });

  y += 22;
  doc.fillColor(BRAND.primary).font('Helvetica-Bold').fontSize(18)
     .text(cert.activity_title, margin + 40, y,
           { align: 'center', width: width - (margin + 40) * 2 });

  y += 42;
  doc.lineWidth(0.75).strokeColor(BRAND.line)
     .moveTo(cx - 110, y).lineTo(cx + 110, y).stroke();

  y += 16;
  const facts = [];
  if (cert.completed_at) {
    facts.push(new Date(cert.completed_at).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric'
    }));
  }
  if (cert.hours) {
    // Trim a trailing .0: "3 hours" reads as a fact, "3.00 hours" reads
    // as a database column.
    const hours = Number(cert.hours);
    const shown = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    facts.push(`${shown} ${hours === 1 ? 'hour' : 'hours'} of learning`);
  }
  if (cert.score !== null && cert.score !== undefined) {
    facts.push(`Assessment score ${Number(cert.score).toFixed(0)}%`);
  }

  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(10)
     .text(facts.join('   ·   '), margin, y, { align: 'center', width: width - margin * 2 });

  // Signature block, sitting in the space between the award text and
  // the footer. A certificate with a large empty middle reads as a
  // template nobody finished; a signature line is what the document
  // would actually carry.
  const sigY = height - margin - 150;
  const sigWidth = 180;

  doc.lineWidth(0.75).strokeColor(BRAND.ink)
     .moveTo(cx - sigWidth / 2, sigY).lineTo(cx + sigWidth / 2, sigY).stroke();

  doc.fillColor(BRAND.ink).font('Helvetica-Bold').fontSize(10)
     .text('YCP Steering Committee', cx - sigWidth / 2, sigY + 8,
           { width: sigWidth, align: 'center' });
  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(8)
     .text('Programme Authority', cx - sigWidth / 2, sigY + 22,
           { width: sigWidth, align: 'center' });

  // Verification block. This is the part that makes the document
  // evidence rather than decoration: anyone holding the paper can check
  // it without an account.
  const footY = height - margin - 64;
  doc.lineWidth(0.75).strokeColor(BRAND.line)
     .moveTo(margin + 40, footY - 12).lineTo(width - margin - 40, footY - 12).stroke();

  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(8)
     .text('VERIFY THIS CERTIFICATE', margin + 40, footY,
           { characterSpacing: 1.5 });
  doc.fillColor(BRAND.ink).font('Helvetica-Bold').fontSize(13)
     .text(cert.verification_code, margin + 40, footY + 13);
  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(8)
     .text(verifyUrl, margin + 40, footY + 31);

  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(8)
     .text('ISSUED', width - margin - 180, footY, { width: 140, align: 'right', characterSpacing: 1.5 });
  doc.fillColor(BRAND.ink).font('Helvetica').fontSize(10)
     .text(new Date(cert.issued_at).toLocaleDateString('en-GB', {
       day: 'numeric', month: 'long', year: 'numeric'
     }), width - margin - 180, footY + 14, { width: 140, align: 'right' });
}

/** GET /api/certificates/:id/download */
router.get(
  '/certificates/:id/download',
  authenticate,
  wrap(async (req, res) => {
    const cert = await queryOne(
      `SELECT r.* FROM recognitions r
        WHERE r.id = $1 AND (r.user_id = $2 OR $3)`,
      [req.params.id, req.user.id, isAdminRole(req.user.role)]
    ).catch(() => null);

    if (!cert) throw notFound('Certificate');
    if (cert.revoked_at) {
      throw forbidden('This certificate has been revoked and cannot be downloaded.');
    }

    const verifyUrl = `${config.corsOrigins[0] ?? ''}/verify/${cert.verification_code}`;
    const safeName = (cert.activity_title ?? 'certificate')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition',
      `attachment; filename="YouthConnect-${safeName}-${cert.verification_code}.pdf"`);
    res.set('Cache-Control', 'private, no-store');

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    doc.pipe(res);
    drawCertificate(doc, cert, verifyUrl);
    doc.end();
  })
);

/* ================================================================== */
/* PUBLIC VERIFICATION                                                */
/* ================================================================== */

/**
 * Rate limited because this endpoint is unauthenticated.
 *
 * Without a limit it is a guessing surface: an attacker could try codes
 * until one resolves and harvest the names attached to them. 30 lookups
 * an hour per address is far more than any real employer needs and far
 * less than a useful guessing rate.
 */
const verifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.VERIFY_RATE_LIMIT) || (config.env === 'test' ? 500 : 30),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many lookups. Try again later.' } }
});

/**
 * GET /api/verify/:code
 *
 * Public. No account required, which is the entire point: a credential
 * only an employer with a login can check is not a credential.
 *
 * MINIMUM DISCLOSURE. This returns the name on the certificate, the
 * course, the dates and whether it is valid. It deliberately does NOT
 * return the participant's email, their country, their other
 * certificates, or an internal user id. Someone holding one code learns
 * about one achievement and nothing else about that person.
 */
router.get(
  '/verify/:code',
  verifyLimiter,
  wrap(async (req, res) => {
    const code = String(req.params.code).toUpperCase().trim();

    const cert = await queryOne(
      `SELECT recipient_name, activity_title, title, score, hours,
              completed_at, issued_at, revoked_at, kind
         FROM recognitions
        WHERE upper(verification_code) = $1`,
      [code]
    ).catch(() => null);

    if (!cert) {
      return sendJson(req, res, {
        valid: false,
        reason: 'No certificate matches that code.'
      }, { status: 404, private: false, maxAge: 0 });
    }

    if (cert.revoked_at) {
      return sendJson(req, res, {
        valid: false,
        reason: 'This certificate was revoked.',
        revokedAt: cert.revoked_at
      }, { private: false, maxAge: 0 });
    }

    return sendJson(req, res, {
      valid: true,
      certificate: {
        recipientName: cert.recipient_name,
        courseTitle: cert.activity_title,
        credential: cert.title,
        kind: cert.kind,
        score: cert.score,
        hours: cert.hours,
        completedAt: cert.completed_at,
        issuedAt: cert.issued_at
      }
    }, { private: false, maxAge: 300 });
  })
);

/* ================================================================== */
/* ADMINISTRATION                                                     */
/* ================================================================== */

/**
 * POST /api/admin/certificates/:id/revoke
 *
 * Revocation rather than deletion. A deleted certificate leaves an
 * employer who already holds the PDF with a code that returns "no such
 * certificate", which is indistinguishable from a forgery. Revoking
 * tells them the truth: it existed, and it was withdrawn.
 */
router.post(
  '/admin/certificates/:id/revoke',
  authenticate,
  requireRole('admin', 'super_admin'),
  wrap(async (req, res) => {
    const reason = String(req.body?.reason ?? '').slice(0, 500);
    if (reason.length < 5) {
      throw badRequest('Give a reason. It is recorded against the certificate.');
    }

    const revoked = await queryOne(
      `UPDATE recognitions
          SET revoked_at = now(), revoked_reason = $2
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, verification_code, recipient_name`,
      [req.params.id, reason]
    ).catch(() => null);

    if (!revoked) throw notFound('Certificate');

    recordAccess({
      actorId: req.user.id, action: 'admin:revoke_certificate',
      resourceType: 'recognition', resourceId: req.params.id,
      allowed: true, reason, req
    });

    return sendJson(req, res, { revoked });
  })
);

export default router;
