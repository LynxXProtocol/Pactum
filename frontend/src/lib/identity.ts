/**
 * Stellar SEP-10 / Federation & DID Identity Resolution Library
 * Resolves raw Stellar public keys (GABC...) to human-readable usernames and avatars with browser localStorage caching.
 */

export interface StellarIdentity {
  address: string;
  username?: string;
  domain?: string;
  avatarUrl?: string;
  resolvedAt: number;
}

const CACHE_KEY = 'pactum_identity_cache_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Pre-configured identities for demo testnet accounts
const KNOWN_IDENTITIES: Record<string, { username: string; domain: string; avatarUrl: string }> = {
  GBY54VG5G4A7DC4D6YJ6GHD4X4QW2AR43JLYZ2QVWSHKACWK3BLDR5IX: {
    username: 'alice*pactum.id',
    domain: 'pactum.id',
    avatarUrl: 'https://api.dicebear.com/7.x/identicon/svg?seed=alice',
  },
  GB4UFBX57KE2RPEXB4NCPQHXL5UZL7HSFBVQ2YEZQDZ2DXR2X3CHHZX: {
    username: 'bob*pactum.id',
    domain: 'pactum.id',
    avatarUrl: 'https://api.dicebear.com/7.x/identicon/svg?seed=bob',
  },
  GCJUKUMADK5PKZF7MCQBBNLRH2AIZQPK5JXBZWBZM7S4CGAJKUMA6V4: {
    username: 'charlie*pactum.id',
    domain: 'pactum.id',
    avatarUrl: 'https://api.dicebear.com/7.x/identicon/svg?seed=charlie',
  },
};

/**
 * Get all cached identity items from localStorage
 */
function getCacheMap(): Record<string, StellarIdentity> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[Identity] Failed to parse localStorage cache:', err);
    return {};
  }
}

/**
 * Save an identity item to localStorage cache
 */
function saveToCache(identity: StellarIdentity): void {
  try {
    const cacheMap = getCacheMap();
    cacheMap[identity.address] = identity;
    localStorage.setItem(CACHE_KEY, JSON.stringify(cacheMap));
  } catch (err) {
    console.warn('[Identity] Failed to update localStorage cache:', err);
  }
}

/**
 * Resolve a Stellar address to a human-readable identity with caching
 */
export async function resolveIdentity(address: string): Promise<StellarIdentity> {
  if (!address || typeof address !== 'string') {
    return { address: '', resolvedAt: Date.now() };
  }

  const cleanAddr = address.trim();

  // 1. Check local browser cache
  const cacheMap = getCacheMap();
  const cached = cacheMap[cleanAddr];
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return cached;
  }

  // 2. Check known registry / federation mappings
  if (KNOWN_IDENTITIES[cleanAddr]) {
    const known = KNOWN_IDENTITIES[cleanAddr];
    const identity: StellarIdentity = {
      address: cleanAddr,
      username: known.username,
      domain: known.domain,
      avatarUrl: known.avatarUrl,
      resolvedAt: Date.now(),
    };
    saveToCache(identity);
    return identity;
  }

  // 3. Attempt external Stellar Expert / Federation directory query
  try {
    const res = await fetch(`https://api.stellar.expert/explorer/testnet/directory/${cleanAddr}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.name) {
        const identity: StellarIdentity = {
          address: cleanAddr,
          username: data.name,
          domain: data.domain || 'stellar.expert',
          avatarUrl: `https://api.dicebear.com/7.x/identicon/svg?seed=${cleanAddr}`,
          resolvedAt: Date.now(),
        };
        saveToCache(identity);
        return identity;
      }
    }
  } catch {
    // Network query optional fallback
  }

  // 4. Fallback: Save negative result in cache to avoid repeated failed network requests
  const fallbackIdentity: StellarIdentity = {
    address: cleanAddr,
    resolvedAt: Date.now(),
  };
  saveToCache(fallbackIdentity);
  return fallbackIdentity;
}

/**
 * Truncate a Stellar public key (GABC...1234)
 */
export function truncateAddress(address: string, leadingChars = 6, trailingChars = 4): string {
  if (!address || address.length <= leadingChars + trailingChars) return address;
  return `${address.substring(0, leadingChars)}...${address.substring(address.length - trailingChars)}`;
}
