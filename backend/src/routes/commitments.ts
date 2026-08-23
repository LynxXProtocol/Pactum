import { Router, Request, Response, NextFunction } from 'express';
import { commitmentSchema } from '../schemas/commitment';
import { z, ZodError } from 'zod';
import { strictLimiter } from '../middleware/rateLimiter';
import pool from '../db/timescale';
import { logger } from '../logger/logger';
import exportRouter from './export';

// ── Encrypted Payload Schema ──────────────────────────────────────────────────
// Validates the body of POST /commitments/encrypted.
// The backend never decrypts this data — it is a dumb blob store.
const encryptedPayloadSchema = z.object({
  commitmentId: z.string().min(1, 'commitmentId is required'),
  issuer: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'issuer must be a valid Stellar public key (G...)'),
  counterparty: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'counterparty must be a valid Stellar public key (G...)'),
  // base64url(IV[12] || AES-GCM ciphertext || auth-tag[16])
  ciphertext: z
    .string()
    .min(1, 'ciphertext is required')
    .max(65536, 'ciphertext must not exceed 64 KB'),
});

type EncryptedPayloadInput = z.infer<typeof encryptedPayloadSchema>;

const router = Router();

export const commitmentQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  issuer: z.string().optional(),
  counterparty: z.string().optional(),
  status: z.enum(['pending', 'active', 'completed', 'disputed']).optional(),
  template: z.enum(['Freeform', 'RefundDeposit', 'SLAGuarantee', 'MilestoneCheckIn']).optional(),
});

export type CommitmentQueryInput = z.infer<typeof commitmentQuerySchema>;

export type KeysetCursor = {
  time: string;
  id: string;
};

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(token: string): KeysetCursor | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.time === 'string' && typeof parsed.id === 'string') {
      return parsed as KeysetCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validation middleware using Zod for POST/PUT commitment bodies.
 */
const validateCommitment = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const validatedData = commitmentSchema.parse(req.body);
    req.body = validatedData;
    next();
  } catch (error) {
    if (error instanceof ZodError) {
      const formattedErrors = error.errors.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      }));

      res.status(400).json({
        error: 'Bad Request',
        details: formattedErrors,
      });
      return;
    }
    next(error);
  }
};

// ── Commitment History Export (CSV / PDF) ──────────────────────────────
// GET /commitments/export/:address?format=csv|pdf
// Must be mounted BEFORE the GET /:id catch-all below so the `export` path
// segment is never captured as a commitment id.
router.use('/export', exportRouter);

// POST /commitments - Create a new commitment
router.post('/', strictLimiter, validateCommitment, (req: Request, res: Response) => {
  logger.info('Creating new commitment', { partyA: req.body.partyA, amount: req.body.amount });
  res.status(201).json({
    message: 'Commitment created successfully',
    data: req.body,
  });
});

// PUT /commitments/:id - Update an existing commitment
router.put('/:id', strictLimiter, validateCommitment, (req: Request, res: Response) => {
  logger.info('Updating commitment', { id: req.params.id });
  res.status(200).json({
    message: 'Commitment updated successfully',
    data: req.body,
  });
});

// GET /commitments/:id - Fetch a commitment by ID
router.get('/:id', (req: Request, res: Response) => {
  res.status(200).json({ message: 'Get commitment', id: req.params.id });
});

// GET /commitments - High-Performance Keyset Cursor Pagination & Dynamic Filtering (Pactum #124)
router.get('/', async (req: Request, res: Response) => {
  const parseResult = commitmentQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'Bad Request',
      details: parseResult.error.issues,
    });
    return;
  }

  const { cursor, limit, issuer, counterparty, status, template } = parseResult.data;
  let decodedCursor: KeysetCursor | null = null;

  if (cursor) {
    decodedCursor = decodeCursor(cursor);
    if (!decodedCursor) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid pagination cursor provided.',
      });
      return;
    }
  }

  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

  if (issuer) {
    params.push(issuer);
    conditions.push(`party_a = $${params.length}`);
  }

  if (counterparty) {
    params.push(counterparty);
    conditions.push(`party_b = $${params.length}`);
  }

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  if (template) {
    params.push(template);
    conditions.push(`template = $${params.length}`);
  }

  if (decodedCursor) {
    params.push(decodedCursor.time);
    params.push(decodedCursor.id);
    conditions.push(`(time, commitment_id) < ($${params.length - 1}, $${params.length})`);
  }

  params.push(limit + 1);
  const sql = `
    SELECT
      time,
      commitment_id as id,
      party_a as "partyA",
      party_b as "partyB",
      amount,
      currency,
      status,
      template,
      outcome,
      due_date as "dueDate",
      completed_at as "completedAt",
      created_at as "createdAt"
    FROM commitment_outcomes
    WHERE ${conditions.join(' AND ')}
    ORDER BY time DESC, commitment_id DESC
    LIMIT $${params.length}
  `;

  try {
    const result = await pool.query(sql, params);
    const rows = result.rows || [];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      nextCursor = encodeCursor({
        time: new Date(lastItem.time).toISOString(),
        id: String(lastItem.id),
      });
    }

    res.status(200).json({
      items,
      next_cursor: nextCursor,
      limit,
      has_more: hasMore,
      filter: {
        ...(issuer ? { issuer } : {}),
        ...(counterparty ? { counterparty } : {}),
        ...(status ? { status } : {}),
        ...(template ? { template } : {}),
      },
    });
  } catch (error) {
    logger.error('Database query failed for /commitments', error, {
      filter: { issuer, counterparty, status, template },
    });

    res.status(503).json({
      error: 'Service Unavailable',
      message: 'Database query failed for commitments.',
    });
  }
});

// ── POST /commitments/encrypted ─────────────────────────────────────────────
// Stores the AES-GCM encrypted terms blob for a commitment.
// The backend never receives nor stores plaintext — only the opaque ciphertext.
router.post(
  '/encrypted',
  strictLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const parseResult = encryptedPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: 'Bad Request',
        details: parseResult.error.issues,
      });
      return;
    }

    const { commitmentId, issuer, counterparty, ciphertext }: EncryptedPayloadInput =
      parseResult.data;

    // Sanity: issuer and counterparty must differ
    if (issuer.trim().toUpperCase() === counterparty.trim().toUpperCase()) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'issuer and counterparty addresses must be different.',
      });
      return;
    }

    try {
      await pool.query(
        `INSERT INTO encrypted_payloads (commitment_id, issuer, counterparty, ciphertext)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (commitment_id)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                       issuer = EXCLUDED.issuer,
                       counterparty = EXCLUDED.counterparty`,
        [commitmentId, issuer, counterparty, ciphertext],
      );

      logger.info('Encrypted payload stored for commitment', { commitmentId, issuer });

      res.status(201).json({ message: 'Encrypted terms stored successfully.' });
    } catch (error) {
      logger.error('Failed to store encrypted payload', error, { commitmentId });
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Failed to store encrypted commitment payload.',
      });
    }
  },
);

// ── GET /commitments/:id/encrypted ───────────────────────────────────────────
// Returns the ciphertext blob for the given commitment ID.
// Decryption happens entirely in the browser — the server returns only ciphertext.
router.get('/:id/encrypted', async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id ?? '');

  if (!id || id.trim().length === 0) {
    res.status(400).json({ error: 'Bad Request', message: 'Commitment ID is required.' });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT ciphertext, issuer, counterparty, created_at
       FROM encrypted_payloads
       WHERE commitment_id = $1
       LIMIT 1`,
      [id.trim()],
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: 'No encrypted payload found for this commitment.',
      });
      return;
    }

    const { ciphertext, issuer, counterparty, created_at } = result.rows[0];
    res.status(200).json({ ciphertext, issuer, counterparty, createdAt: created_at });
  } catch (error) {
    logger.error('Failed to fetch encrypted payload', error, { commitmentId: id });
    res.status(503).json({
      error: 'Service Unavailable',
      message: 'Failed to fetch encrypted commitment payload.',
    });
  }
});

export default router;
