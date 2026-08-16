# Contributing to Pactum

First off, thank you for considering contributing to Pactum! It's people like you that make Pactum such a great tool.

## Join the Community
If you have questions, want to discuss features, or just want to hang out, join our Discord community!
👉 [Join the LynxXProtocol Discord](https://discord.gg/DpzQthg8Y)

## How Can I Contribute?

### Reporting Bugs
If you find a bug, please create an issue on GitHub with a clear description, steps to reproduce, and any relevant logs or screenshots.

### Suggesting Enhancements
Have an idea for a new feature or improvement? We'd love to hear it! Open an issue on GitHub describing your suggestion and why it would be beneficial.

### Pull Requests
1. Fork the repository and create your branch from `main`.
2. Make your changes and ensure tests pass.
3. Update the documentation if your changes affect the user experience or architecture.
4. Issue that pull request!

## Development Setup
- Clone the repository.
- Install dependencies using `npm install` in the relevant directories (e.g., `frontend`).
- Run the development server or local node as specified in the README.

## Getting Started: Local Contract Testing

The `contracts/registry` crate hosts the Soroban smart contract test suite (see `contracts/registry/src/test.rs` and its sibling test modules). Follow the steps below to run it locally.

### 1. Install the Rust toolchain
Pactum targets stable Rust (1.74 or newer, as required by Soroban SDK 22):

```bash
rustup update stable
```

### 2. Add the WASM target
Soroban contracts compile to WebAssembly. Add the target before building or testing:

```bash
rustup target add wasm32-unknown-unknown
```

### 3. Install the Soroban CLI
The Soroban CLI is used for building and deploying the contracts. Note that this is a large build and can take several minutes:

```bash
cargo install --locked soroban-cli
```

The CLI is only needed for building/deploying contracts; plain unit tests run via `cargo test` do not require it.

### 4. Run the full test suite

```bash
cd contracts/registry
cargo test
```

The `Makefile` in `contracts/registry` provides the same entry point (`make test`), plus `make build` (release WASM build) and `make test-upgrade` (runs the real Wasm executable-swap upgrade tests, which require compiled artifacts first).

### 5. Run a specific test
`cargo test` accepts a substring filter. For example, to run just the dispute-window tests:

```bash
cargo test test_dispute_fails_outside_dispute_window
```

To run a single module (e.g., the trust-score suite):

```bash
cargo test test_trust_score
```

### Common failure modes

| Error | Cause | Fix |
| --- | --- | --- |
| `error: no such target 'wasm32-unknown-unknown'` | The WASM target was never added | Run `rustup target add wasm32-unknown-unknown` (step 2) |
| `soroban: command not found` | The Soroban CLI is not installed or not on `PATH` | Run `cargo install --locked soroban-cli` (step 3) |
| Toolchain mismatch (e.g., `error[E0658]` on a stable feature or SDK version errors) | Wrong or stale Rust toolchain is active | Run `rustup override set stable` inside `contracts/` and `rustup update stable` |

### Quick troubleshooting
- Always run `rustup update stable` before opening a PR — the suite must pass on the pinned stable toolchain.
- If `cargo test` fails on missing Wasm artifacts, run `make -C contracts/registry build` first.
- For questions, join the [LynxXProtocol Discord](https://discord.gg/DpzQthg8Y).

## Code of Conduct
Please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.
