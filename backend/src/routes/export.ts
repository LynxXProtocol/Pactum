import { Router, Request, Response } from 'express';
import pool from '../db/timescale';
import { logger } from '../logger/logger';
import PDFDocument from 'pdfkit';

const router = Router();

// Supported export formats
const FORMATS = ['csv', 'pdf'] as const;
type ExportFormat = (typeof FORMATS)[number];

/**
 * Escapes a value for CSV per RFC 4180: double-quote wrapping when the
 * field contains a comma, quote, or newline; quotes are doubled.
 */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Maps a DB row into a flat export record. */
interface ExportRow {
  id: string;
  partyA: string;
  partyB: string;
  amount: string | null;
  currency: string | null;
  status: string;
  template: string | null;
  outcome: string | null;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

function toExportRow(row: Record<string, unknown>): ExportRow {
  const dateOf = (v: unknown): string | null =>
    v === null || v === undefined ? null : new Date(v as string).toISOString();

  return {
    id: String(row.id ?? ''),
    partyA: String(row.partyA ?? ''),
    partyB: String(row.partyB ?? ''),
    amount: row.amount === null || row.amount === undefined ? null : String(row.amount),
    currency: row.currency === null || row.currency === undefined ? null : String(row.currency),
    status: String(row.status ?? ''),
    template: row.template === null || row.template === undefined ? null : String(row.template),
    outcome: row.outcome === null || row.outcome === undefined ? null : String(row.outcome),
    dueDate: dateOf(row.dueDate),
    completedAt: dateOf(row.completedAt),
    createdAt: dateOf(row.createdAt),
  };
}

/**
 * Loads every commitment that references the given Stellar address (either as
 * issuer party_a or counterparty party_b). No pagination — exports cover the
 * full history, ordered newest first.
 */
async function loadCommitmentsForAddress(
  address: string,
): Promise<ExportRow[]> {
  const result = await pool.query(
    `SELECT
       commitment_id AS id,
       party_a AS "partyA",
       party_b AS "partyB",
       amount,
       currency,
       status,
       template,
       outcome,
       due_date AS "dueDate",
       completed_at AS "completedAt",
       created_at AS "createdAt"
     FROM commitment_outcomes
     WHERE party_a = $1 OR party_b = $1
     ORDER BY time DESC, commitment_id DESC`,
    [address],
  );
  return (result.rows || []).map((row) => toExportRow(row));
}

const CSV_HEADERS = [
  'id',
  'partyA',
  'partyB',
  'amount',
  'currency',
  'status',
  'template',
  'outcome',
  'dueDate',
  'completedAt',
  'createdAt',
] as const;

function buildCsv(rows: ExportRow[]): string {
  const header = CSV_HEADERS.map((h) => csvEscape(h)).join(',');
  const lines = rows.map((row) =>
    CSV_HEADERS.map((h) => csvEscape(row[h])).join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}

/**
 * Generates an invoice-like PDF summary using PDFKit: a report header, a
 * per-row commitment table, and a summary footer with outstanding counts.
 */
function buildPdf(rows: ExportRow[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header ───────────────────────────────────────────────────────────
    doc.fontSize(20).fillColor('#1d1d1f').text('Pactum Commitment History', {
      align: 'center',
      continued: false,
    });
    doc.moveDown(0.3);
    doc
      .fontSize(11)
      .fillColor('#475569')
      .text(
        `Generated ${new Date().toUTCString()}  ·  ${rows.length} commitment(s)`,
        { align: 'center' },
      );
    doc.moveDown(1.2);

    // ── Table header ─────────────────────────────────────────────────────
    const left = doc.page.margins.left;
    const columnWidths = {
      status: 78,
      amount: 78,
      currency: 58,
      dueDate: 96,
      template: 92,
    } as const;
    const statusX = left;
    const amountX = statusX + columnWidths.status;
    const currencyX = amountX + columnWidths.amount;
    const dueX = currencyX + columnWidths.currency;
    const templateX = dueX + columnWidths.dueDate;
    const tableRight = doc.page.width - doc.page.margins.right;
    const idX = templateX + columnWidths.template;

    const printHeaderRow = () => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#334155');
      doc.text('Status', statusX, doc.y, { width: columnWidths.status });
      doc.text('Amount', amountX, doc.y, { width: columnWidths.amount });
      doc.text('Cur.', currencyX, doc.y, { width: columnWidths.currency });
      doc.text('Due', dueX, doc.y, { width: columnWidths.dueDate });
      doc.text('Template', templateX, doc.y, { width: columnWidths.template });
      doc.text('Commitment ID', idX, doc.y, { width: tableRight - idX });
      doc.moveDown(0.4);
    };

    doc
      .moveTo(left, doc.y)
      .lineTo(tableRight, doc.y)
      .strokeColor('#e2e8f0')
      .lineWidth(1)
      .stroke();
    doc.moveDown(0.4);
    printHeaderRow();
    doc
      .moveTo(left, doc.y)
      .lineTo(tableRight, doc.y)
      .strokeColor('#cbd5e1')
      .lineWidth(0.6)
      .stroke();
    doc.moveDown(0.4);

    // ── Rows ─────────────────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(9).fillColor('#1e293b');
    const rowHeight = 16;
    let y = doc.y;

    for (const row of rows) {
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        printHeaderRow();
        doc.font('Helvetica').fontSize(9).fillColor('#1e293b');
      }
      doc.text(row.status, statusX, y, { width: columnWidths.status });
      doc.text(row.amount ?? '—', amountX, y, { width: columnWidths.amount });
      doc.text(row.currency ?? '—', currencyX, y, { width: columnWidths.currency });
      doc.text(
        row.dueDate ? row.dueDate.slice(0, 10) : '—',
        dueX,
        y,
        { width: columnWidths.dueDate },
      );
      doc.text(row.template ?? '—', templateX, y, { width: columnWidths.template });
      doc.text(row.id, idX, y, { width: tableRight - idX });
      y += rowHeight;
    }

    doc.y = y;
    doc.moveDown(1);

    // ── Summary footer ───────────────────────────────────────────────────
    const statusCounts = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    const outstanding = Object.entries(statusCounts)
      .filter(([status]) => status === 'Pending' || status === 'Disputed' || status === 'Late')
      .map(([status, count]) => `${status}: ${count}`)
      .join('  ·  ');

    doc
      .moveTo(left, doc.y)
      .lineTo(tableRight, doc.y)
      .strokeColor('#e2e8f0')
      .stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1d1d1f');
    doc.text('Summary', { continued: false });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('#475569');
    if (outstanding) {
      doc.text(`Outstanding: ${outstanding}`);
    }
    doc.text(
      `Total commitments in history: ${rows.length} (${Object.entries(statusCounts)
        .map(([status, count]) => `${status} ${count}`)
        .join(', ')})`,
    );
    doc.text('Exported from Pactum Trust Layer.');

    doc.end();
  });
}

// GET /commitments/export/:address?format=csv|pdf
// Streams the full commitment history of an address as a downloadable file.
router.get('/export/:address', async (req: Request, res: Response) => {
  const address = String(req.params.address ?? '').trim();
  const formatRaw = String(req.query.format ?? 'csv').toLowerCase();
  const format: ExportFormat = FORMATS.includes(formatRaw as ExportFormat)
    ? (formatRaw as ExportFormat)
    : 'csv';

  if (!address || !/^G[A-Z2-7]{55}$/.test(address)) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'address must be a valid Stellar public key (G...).',
    });
    return;
  }

  try {
    const rows = await loadCommitmentsForAddress(address);
    logger.info('Exported commitment history', {
      address,
      format,
      count: rows.length,
    });

    const safeSlug = address.slice(0, 12);
    const baseName = `pactum-history-${safeSlug}`;

    if (format === 'pdf') {
      const pdf = await buildPdf(rows);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
      res.setHeader('Content-Length', String(pdf.length));
      res.status(200).end(pdf);
      return;
    }

    const csv = buildCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.csv"`);
    res.setHeader('Content-Length', String(Buffer.byteLength(csv)));
    res.status(200).end(csv);
  } catch (error) {
    logger.error('Failed to export commitment history', error, { address, format });
    res.status(503).json({
      error: 'Service Unavailable',
      message: 'Failed to export commitment history.',
    });
  }
});

export default router;