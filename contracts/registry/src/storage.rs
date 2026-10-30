use crate::commitments::{TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use soroban_sdk::{contracttype, Address, Bytes, Env};

pub const TWAR_LEAF_CAPACITY: usize = 32;
pub const TWAR_NODE_SLOTS: usize = TWAR_LEAF_CAPACITY * 2;
pub const TWAR_SLOT_BYTES: usize = 16;
pub const TWAR_PACKED_BYTES_LEN: usize = TWAR_NODE_SLOTS * TWAR_SLOT_BYTES;
pub const TWAR_STORAGE_MAGIC: u32 = 0x5457_4152;
pub const TWAR_DEFAULT_HALF_LIFE_LEDGERS: u32 = 640_000;

/// Storage key for packed TWAR segment trees in Soroban instance storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TwarStorageKey {
    TwarTree(Address),
}

/// Decoded header stored in slot 0 of the packed segment tree buffer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TwarHeader {
    pub magic: u32,
    pub half_life_ledgers: u32,
    pub last_ledger: u32,
    pub total_updates: u32,
}

/// Decoded segment tree node stored in slots 1..64 of the packed buffer.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TwarNode {
    pub weighted_score: i64,
    pub anchor_ledger: u32,
    pub event_count: u32,
}

impl TwarNode {
    /// Returns an empty segment tree node.
    #[inline]
    pub const fn empty() -> Self {
        Self {
            weighted_score: 0,
            anchor_ledger: 0,
            event_count: 0,
        }
    }

    /// Returns true if this node has zero score, zero anchor, and zero events.
    #[inline]
    pub const fn is_empty(&self) -> bool {
        self.weighted_score == 0 && self.anchor_ledger == 0 && self.event_count == 0
    }
}

/// Initializes a raw packed buffer with default magic, specified half-life, and zeroed nodes.
#[inline]
pub fn init_packed_buffer(half_life_ledgers: u32) -> [u8; TWAR_PACKED_BYTES_LEN] {
    let mut buf = [0u8; TWAR_PACKED_BYTES_LEN];
    let effective_half_life = if half_life_ledgers == 0 {
        TWAR_DEFAULT_HALF_LIFE_LEDGERS
    } else {
        half_life_ledgers
    };
    encode_header(
        &mut buf,
        TwarHeader {
            magic: TWAR_STORAGE_MAGIC,
            half_life_ledgers: effective_half_life,
            last_ledger: 0,
            total_updates: 0,
        },
    );
    buf
}

/// Encodes the tree header into slot 0 in big-endian byte order.
#[inline]
pub fn encode_header(buf: &mut [u8; TWAR_PACKED_BYTES_LEN], header: TwarHeader) {
    buf[0..4].copy_from_slice(&header.magic.to_be_bytes());
    buf[4..8].copy_from_slice(&header.half_life_ledgers.to_be_bytes());
    buf[8..12].copy_from_slice(&header.last_ledger.to_be_bytes());
    buf[12..16].copy_from_slice(&header.total_updates.to_be_bytes());
}

/// Decodes the tree header from slot 0 in big-endian byte order.
#[inline]
pub fn decode_header(buf: &[u8; TWAR_PACKED_BYTES_LEN]) -> TwarHeader {
    let magic = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
    let raw_half_life = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
    let half_life_ledgers = if magic != TWAR_STORAGE_MAGIC || raw_half_life == 0 {
        TWAR_DEFAULT_HALF_LIFE_LEDGERS
    } else {
        raw_half_life
    };
    let last_ledger = u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]);
    let total_updates = u32::from_be_bytes([buf[12], buf[13], buf[14], buf[15]]);
    TwarHeader {
        magic: TWAR_STORAGE_MAGIC,
        half_life_ledgers,
        last_ledger,
        total_updates,
    }
}

/// Encodes a segment tree node into slot node_idx in big-endian byte order.
#[inline]
pub fn encode_node(buf: &mut [u8; TWAR_PACKED_BYTES_LEN], node_idx: usize, node: TwarNode) {
    debug_assert!(node_idx > 0 && node_idx < TWAR_NODE_SLOTS);
    let offset = node_idx * TWAR_SLOT_BYTES;
    buf[offset..offset + 8].copy_from_slice(&node.weighted_score.to_be_bytes());
    buf[offset + 8..offset + 12].copy_from_slice(&node.anchor_ledger.to_be_bytes());
    buf[offset + 12..offset + 16].copy_from_slice(&node.event_count.to_be_bytes());
}

/// Decodes a segment tree node from slot node_idx in big-endian byte order.
#[inline]
pub fn decode_node(buf: &[u8; TWAR_PACKED_BYTES_LEN], node_idx: usize) -> TwarNode {
    debug_assert!(node_idx > 0 && node_idx < TWAR_NODE_SLOTS);
    let offset = node_idx * TWAR_SLOT_BYTES;
    let weighted_score = i64::from_be_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
        buf[offset + 4],
        buf[offset + 5],
        buf[offset + 6],
        buf[offset + 7],
    ]);
    let anchor_ledger = u32::from_be_bytes([
        buf[offset + 8],
        buf[offset + 9],
        buf[offset + 10],
        buf[offset + 11],
    ]);
    let event_count = u32::from_be_bytes([
        buf[offset + 12],
        buf[offset + 13],
        buf[offset + 14],
        buf[offset + 15],
    ]);
    TwarNode {
        weighted_score,
        anchor_ledger,
        event_count,
    }
}

/// Packs a contiguous 1,024-byte tree buffer into a Soroban Bytes value.
#[inline]
pub fn pack_tree_bytes(env: &Env, buf: &[u8; TWAR_PACKED_BYTES_LEN]) -> Bytes {
    Bytes::from_slice(env, buf)
}

/// Unpacks a Soroban Bytes slice into a contiguous 1,024-byte buffer.
#[inline]
pub fn unpack_tree_bytes(bytes: &Bytes) -> [u8; TWAR_PACKED_BYTES_LEN] {
    if bytes.len() as usize != TWAR_PACKED_BYTES_LEN {
        return init_packed_buffer(TWAR_DEFAULT_HALF_LIFE_LEDGERS);
    }
    let mut buf = [0u8; TWAR_PACKED_BYTES_LEN];
    bytes.copy_into_slice(&mut buf);
    let hdr = decode_header(&buf);
    if hdr.magic != TWAR_STORAGE_MAGIC {
        return init_packed_buffer(TWAR_DEFAULT_HALF_LIFE_LEDGERS);
    }
    buf
}

/// Loads packed Bytes representation of the target address from instance storage.
pub fn load_packed_twar_bytes(env: &Env, address: &Address) -> Option<Bytes> {
    let key = TwarStorageKey::TwarTree(address.clone());
    env.storage().instance().get(&key)
}

/// Writes packed Bytes representation of the target address into instance storage with TTL extension.
pub fn save_packed_twar_bytes(env: &Env, address: &Address, bytes: &Bytes) {
    let key = TwarStorageKey::TwarTree(address.clone());
    env.storage().instance().set(&key, bytes);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}
