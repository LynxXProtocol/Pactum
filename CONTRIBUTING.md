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

## Testing Soroban Contracts

### Environment Setup

- **Install Rust toolchain** (stable, ≥1.74 for Soroban):
  ```bash
  rustup update stable
  ```
- **Add the WASM target**:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **Install Soroban CLI**:
  ```bash
  cargo install --locked soroban-cli
  ```

### Running Tests

- **Run the full test suite**:
  ```bash
  cd contracts/registry
  cargo test
  ```
- **Run a specific test**:
  ```bash
  cargo test test_dispute_window_expired
  ```

### Troubleshooting

- `error: no such target 'wasm32-unknown-unknown'` → Step 2 is missing.
- `soroban: command not found` → Step 3 is missing.
- **Toolchain mismatch** → Run `rustup override set stable`.

## Code of Conduct

Please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.
