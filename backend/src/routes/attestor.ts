import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { AttestorCache } from '../attestor/cache';
import { AttestorRepository } from '../attestor/repository';

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

const discoverQuerySchema = z.object({
  max_fee: z.coerce.number().int().nonnegative().optional(),
  domain: z.string().trim().min(1).max(64).optional(),
  min_reliability: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

const registerSchema = z.object({
  attestor: z.string().regex(STELLAR_ADDRESS, 'Invalid Stellar attestor address'),
  fee: z.number().int().nonnegative().optional(),
  domains: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  active: z.boolean().optional(),
});

export function createAttestorRouter(cache: AttestorCache, repository: AttestorRepository): Router {
  const router = Router();

  // GET /attestors/discover?max_fee=&domain=&min_reliability=&limit=&cursor=
  // Returns a ranked, filtered, paginated list of available attestors.
  router.get('/attestors/discover', async (req: Request, res: Response) => {
    try {
      const parsed = discoverQuerySchema.parse(req.query);
      const results = await cache.getDiscovery({
        maxFee: parsed.max_fee,
        domain: parsed.domain,
        minReliability: parsed.min_reliability,
        limit: parsed.limit,
        cursor: parsed.cursor,
      });
      res.status(200).json({ count: results.length, attestors: results });
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          error: 'Bad Request',
          details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
        });
        return;
      }
      console.error('[attestor] discovery failed', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // GET /attestors/:address/reliability
  router.get('/attestors/:address/reliability', async (req: Request, res: Response) => {
    const raw = req.params.address;
    const address = (Array.isArray(raw) ? raw[0] : raw).toUpperCase();
    if (!STELLAR_ADDRESS.test(address)) {
      res.status(400).json({ error: 'Invalid Stellar attestor address' });
      return;
    }
    try {
      const reliability = await cache.getReliability(address);
      if (!reliability) {
        res.status(404).json({ error: 'Attestor reliability not found', attestor: address });
        return;
      }
      res.status(200).json(reliability);
    } catch (error) {
      console.error('[attestor] reliability lookup failed', error);
      res.status(503).json({ error: 'Attestor reliability service unavailable' });
    }
  });

  // POST /attestors/register — operator-supplied fee & domain expertise.
  // The on-chain `staked`/`unstaked` events already seed availability; this
  // endpoint layers the off-chain fee + domain metadata on top.
  router.post(
    '/attestors/register',
    (req: Request, res: Response, next: NextFunction) => {
      try {
        req.body = registerSchema.parse(req.body);
        next();
      } catch (error) {
        if (error instanceof ZodError) {
          res.status(400).json({
            error: 'Bad Request',
            details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
          });
          return;
        }
        next(error);
      }
    },
    async (req: Request, res: Response) => {
      try {
        const body = req.body as z.infer<typeof registerSchema>;
        await repository.registerAttestor({
          attestor: body.attestor.toUpperCase(),
          fee: body.fee,
          domains: body.domains,
          active: body.active,
        });
        await cache.invalidate(body.attestor.toUpperCase());
        res.status(200).json({ message: 'Attestor registered', attestor: body.attestor.toUpperCase() });
      } catch (error) {
        console.error('[attestor] registration failed', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    },
  );

  return router;
}
