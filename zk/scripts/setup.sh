#!/bin/bash
set -euo pipefail

PTAU="pot14_final.ptau"
ARTIFACTS_DIR="artifacts"

mkdir -p "$ARTIFACTS_DIR"

# 1. Generate powers of tau (PLONK does not need a per-circuit ceremony)
if [ ! -f "$PTAU" ]; then
  echo "Generating Powers of Tau (power=14, supports up to 16k constraints)..."
  npx snarkjs powersoftau new bn128 14 pot14_0000.ptau -v
  npx snarkjs powersoftau contribute pot14_0000.ptau pot14_0001.ptau \
    --name="Pactum Phase1 Contribution" -e="$(openssl rand -hex 32)" -v
  npx snarkjs powersoftau beacon pot14_0001.ptau "$PTAU" \
    0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f 10 \
    -n="Final Beacon" -v
  rm -f pot14_0000.ptau pot14_0001.ptau
fi

# 2. Compile circuit
echo "Compiling circuit..."
export PATH=$PATH:~/.cargo/bin
circom circuits/fraud_proof.circom -l ../node_modules --r1cs --wasm --sym -o "$ARTIFACTS_DIR/"

# 3. PLONK setup — no per-circuit trusted ceremony needed
echo "Running PLONK setup..."
npx snarkjs plonk setup "$ARTIFACTS_DIR/fraud_proof.r1cs" "$PTAU" "$ARTIFACTS_DIR/fraud_proof_final.zkey"

# 4. Export verification key (for Soroban contract constants)
echo "Exporting verification key..."
npx snarkjs zkey export verificationkey "$ARTIFACTS_DIR/fraud_proof_final.zkey" "$ARTIFACTS_DIR/verification_key.json"

echo "Setup complete. Verification key at $ARTIFACTS_DIR/verification_key.json"
