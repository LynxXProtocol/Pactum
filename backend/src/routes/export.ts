/**
 * GET /commitments/export/:address?format=csv|pdf
 *
 * Generates and streams a downloadable commitment-history report for a given
 * Stellar address. Supported formats:
 *   - csv  — RFC-4180 spreadsheet via json2csv
 *   - pdf  — invoice-style report via PDFKit
 *
 * Issue #209 — CSV and PDF Export for Commitment History
 */
import { Router, Request, Response } from 'express';
// json2csv ships its own types via its package.json "types" field in the alpha
// release; the @types/* package doesn't exist yet, so we use a local shim.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Parser: CsvParser } = require('json2csv') as { Parser: new (opts: object) => { parse: (data: unknown) => string } };
import PDFDocument from 'pdfkit';
import pool from '../db/timescale';
import { logger } from '../logger/logger';
import { toApiCommitment, type CommitmentOutcomeRow } from './commitments';

const router = Router();

/** Stellar public key pattern — 56-char base32 starting with G */
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * Truncates a Stellar address to "GABC…XYZ" for display in the PDF.
 * Full addresses are always present in the CSV.
 */
function shortAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr ?? '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Fetches all commitment_outcomes rows for an address (as issuer or counterparty),
 * ordered newest-first. No pagination — export covers the entire history.
 */
async function fetchAllCommitments(address: string) {
  const result = await pool.query<CommitmentOutcomeRow>(
    `SELECT
       time,
       commitment_id  AS id,
       party_a        AS "partyA",
       party_b        AS "partyB",
       status,
       outcome,
       due_date       AS "dueDate",
       completed_at   AS "completedAt",
       created_at     AS "createdAt"
     FROM commitment_outcomes
     WHERE party_a = $1 OR party_b = $1
     ORDER BY time DESC`,
    [address],
  );
  return result.rows.map(toApiCommitment);
}

// ── GET /commitments/export/:address ──────────────────────────────────────────
router.get('/:address', async (req: Request, res: Response): Promise<void> => {
  const address = String(req.params['address'] ?? '');
  const format = (String(req.query['format'] ?? '')).toLowerCase() || 'csv';

  // Validate address
  if (!STELLAR_ADDRESS_RE.test(address)) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'address must be a valid Stellar public key (G… 56 characters).',
    });
    return;
  }

  // Validate format
  if (format !== 'csv' && format !== 'pdf') {
    res.status(400).json({
      error: 'Bad Request',
      message: 'format must be "csv" or "pdf".',
    });
    return;
  }

  let commitments: ReturnType<typeof toApiCommitment>[];
  try {
    commitments = await fetchAllCommitments(address);
  } catch (err) {
    logger.error('Export: database query failed', err, { address, format });
    res.status(503).json({
      error: 'Service Unavailable',
      message: 'Database query failed while fetching commitment history.',
    });
    return;
  }

  const safeAddr = address.slice(0, 12); // safe prefix for filename logging
  logger.info('Export requested', { address: safeAddr, format, count: commitments.length });

  // ── Sanitise filename: replace non-alphanumeric characters with underscores ──
  const safeFilename = `pactum-history-${address.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  // ─────────────────────── CSV ────────────────────────────────────────────────
  if (format === 'csv') {
    const fields = [
      { label: 'ID', value: 'id' },
      { label: 'Issuer', value: 'issuer' },
      { label: 'Counterparty', value: 'counterparty' },
      { label: 'Terms Hash', value: 'terms_hash' },
      { label: 'Due Date (Unix)', value: 'due_at' },
      { label: 'Due Date (UTC)', value: (row: ReturnType<typeof toApiCommitment>) =>
          new Date(row.due_at * 1000).toISOString() },
      { label: 'Status', value: 'status' },
      { label: 'Outcome', value: (row: ReturnType<typeof toApiCommitment>) => row.outcome ?? '' },
      { label: 'Created At (Unix)', value: 'created_at' },
      { label: 'Created At (UTC)', value: (row: ReturnType<typeof toApiCommitment>) =>
          new Date(row.created_at * 1000).toISOString() },
      { label: 'Attested At (Unix)', value: (row: ReturnType<typeof toApiCommitment>) =>
          row.attested_at != null ? String(row.attested_at) : '' },
      { label: 'Attested At (UTC)', value: (row: ReturnType<typeof toApiCommitment>) =>
          row.attested_at != null ? new Date(row.attested_at * 1000).toISOString() : '' },
    ];

    try {
      const parser = new CsvParser({ fields });
      const csv = parser.parse(commitments);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeFilename}.csv"`,
      );
      res.send(csv);
    } catch (err) {
      logger.error('Export: CSV generation failed', err, { address: safeAddr });
      res.status(500).json({ error: 'Internal Server Error', message: 'Failed to generate CSV.' });
    }
    return;
  }

  // ─────────────────────── PDF ────────────────────────────────────────────────
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeFilename}.pdf"`,
  );

  try {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    doc.pipe(res);

    // ── Branding header ──
    doc
      .fontSize(22)
      .fillColor('#0f172a')
      .font('Helvetica-Bold')
      .text('Pactum', 48, 48);

    doc
      .fontSize(11)
      .fillColor('#64748b')
      .font('Helvetica')
      .text('On-chain Commitment History Report', 48, 76);

    doc.moveDown(0.5);
    doc
      .moveTo(48, doc.y)
      .lineTo(doc.page.width - 48, doc.y)
      .strokeColor('#e2e8f0')
      .lineWidth(1)
      .stroke();
    doc.moveDown(0.8);

    // ── Address & metadata ──
    const generated = new Date().toUTCString();
    doc
      .fontSize(10)
      .fillColor('#475569')
      .font('Helvetica-Bold')
      .text('Address: ', { continued: true })
      .font('Helvetica')
      .fillColor('#0f172a')
      .text(address);

    doc
      .fontSize(10)
      .fillColor('#475569')
      .font('Helvetica-Bold')
      .text('Generated: ', { continued: true })
      .font('Helvetica')
      .fillColor('#0f172a')
      .text(generated);

    doc
      .fontSize(10)
      .fillColor('#475569')
      .font('Helvetica-Bold')
      .text('Total commitments: ', { continued: true })
      .font('Helvetica')
      .fillColor('#0f172a')
      .text(String(commitments.length));

    // ── Summary stats ──
    const fulfilled = commitments.filter((c) => c.status === 'Fulfilled').length;
    const late = commitments.filter((c) => c.status === 'Late').length;
    const breached = commitments.filter((c) => c.status === 'Breached').length;
    const pending = commitments.filter((c) => c.status === 'Pending').length;

    doc.moveDown(0.8);
    doc
      .moveTo(48, doc.y)
      .lineTo(doc.page.width - 48, doc.y)
      .strokeColor('#e2e8f0')
      .lineWidth(1)
      .stroke();
    doc.moveDown(0.6);

    doc.fontSize(12).fillColor('#0f172a').font('Helvetica-Bold').text('Summary');
    doc.moveDown(0.3);

    const summaryItems: [string, number, string][] = [
      ['Fulfilled', fulfilled, '#15803d'],
      ['Late', late, '#b45309'],
      ['Breached', breached, '#be123c'],
      ['Pending', pending, '#475569'],
    ];

    const summaryStartX = 48;
    const summaryColW = (doc.page.width - 96) / 4;
    const summaryY = doc.y;

    summaryItems.forEach(([label, count, color], i) => {
      const x = summaryStartX + i * summaryColW;

      // box
      doc
        .roundedRect(x, summaryY, summaryColW - 8, 52, 6)
        .fillColor('#f8fafc')
        .fill();

      doc
        .fontSize(10)
        .fillColor('#64748b')
        .font('Helvetica')
        .text(label, x + 8, summaryY + 8, { width: summaryColW - 16 });

      doc
        .fontSize(20)
        .fillColor(color)
        .font('Helvetica-Bold')
        .text(String(count), x + 8, summaryY + 24, { width: summaryColW - 16 });
    });

    doc.y = summaryY + 60;
    doc.moveDown(0.8);

    // ── Commitment rows ──
    if (commitments.length === 0) {
      doc
        .fontSize(12)
        .fillColor('#64748b')
        .font('Helvetica')
        .text('No commitment history found for this address.', { align: 'center' });
    } else {
      doc.fontSize(12).fillColor('#0f172a').font('Helvetica-Bold').text('Commitment History');
      doc.moveDown(0.4);

      const colX = [48, 110, 260, 360, 430, 510];
      const colHeaders = ['ID', 'Issuer', 'Counterparty', 'Due Date', 'Status', 'Attested'];

      // Table header background
      const headerY = doc.y;
      doc
        .rect(48, headerY, doc.page.width - 96, 18)
        .fillColor('#f1f5f9')
        .fill();

      doc.fontSize(8).fillColor('#475569').font('Helvetica-Bold');
      colHeaders.forEach((h, i) => {
        doc.text(h, colX[i], headerY + 4, { width: (colX[i + 1] ?? doc.page.width - 48) - colX[i] - 4, lineBreak: false });
      });

      doc.moveDown(0.1);
      let rowY = headerY + 20;

      commitments.forEach((c, idx) => {
        // Page break: keep a 60px bottom margin
        if (rowY + 18 > doc.page.height - 60) {
          doc.addPage();
          rowY = 48;
        }

        // Alternating row shade
        if (idx % 2 === 0) {
          doc.rect(48, rowY, doc.page.width - 96, 16).fillColor('#fafafa').fill();
        }

        const statusColor =
          c.status === 'Fulfilled'
            ? '#15803d'
            : c.status === 'Late'
              ? '#b45309'
              : c.status === 'Breached'
                ? '#be123c'
                : '#475569';

        const attestedStr = c.attested_at
          ? new Date(c.attested_at * 1000).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          : '—';

        const dueStr = new Date(c.due_at * 1000).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });

        doc.fontSize(7.5).font('Helvetica').fillColor('#0f172a');
        doc.text(String(c.id),               colX[0], rowY + 3, { width: colX[1] - colX[0] - 4, lineBreak: false });
        doc.text(shortAddr(c.issuer),         colX[1], rowY + 3, { width: colX[2] - colX[1] - 4, lineBreak: false });
        doc.text(shortAddr(c.counterparty),   colX[2], rowY + 3, { width: colX[3] - colX[2] - 4, lineBreak: false });
        doc.text(dueStr,                      colX[3], rowY + 3, { width: colX[4] - colX[3] - 4, lineBreak: false });
        doc.fillColor(statusColor).text(c.status, colX[4], rowY + 3, { width: colX[5] - colX[4] - 4, lineBreak: false });
        doc.fillColor('#0f172a').text(attestedStr, colX[5], rowY + 3, { width: doc.page.width - 48 - colX[5] - 4, lineBreak: false });

        rowY += 17;
      });
    }

    // ── Footer ──
    doc
      .fontSize(8)
      .fillColor('#94a3b8')
      .font('Helvetica')
      .text(
        `Generated by Pactum · ${generated} · ${commitments.length} record(s)`,
        48,
        doc.page.height - 36,
        { align: 'center', width: doc.page.width - 96 },
      );

    doc.end();
  } catch (err) {
    logger.error('Export: PDF generation failed', err, { address: safeAddr });
    // Headers already sent (Content-Type: application/pdf) — can't send JSON error
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error', message: 'Failed to generate PDF.' });
    } else {
      res.end();
    }
  }
});

export default router;
