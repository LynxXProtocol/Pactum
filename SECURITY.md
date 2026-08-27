# Security Policy

Pactum provides an on-chain commitment registry and public compliance history on the Stellar network. Because real-world reputation and agreements rely on our smart contracts, backend indexer, and SDKs, security is a fundamental priority for our project.

We appreciate the work of security researchers in identifying and responsibly disclosing vulnerabilities to help protect the network and its users.

---

## 1. How to Report a Vulnerability

If you believe you have discovered a security vulnerability in Pactum, **please do not disclose it publicly or open a public GitHub issue.**

### Preferred Reporting Channel

- **GitHub Private Vulnerability Reporting**: Submit a confidential disclosure via the **[Security Advisories](https://github.com/amankoli09/Pactum/security/advisories)** tab of our repository.
- **Maintainer Contact**: If GitHub Private Vulnerability Reporting is unavailable, contact the repository maintainers privately via GitHub or Discord as linked in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Information to Include

To help us triage and respond to your report quickly, please include:

1. A clear description of the vulnerability and its potential impact.
2. The specific component(s) affected (e.g. `contracts/registry/`, `backend/`, `sdk/js/`, `frontend/`).
3. Step-by-step instructions or proof-of-concept (PoC) code to reproduce the issue.
4. Any potential mitigations or patch suggestions you may have identified.

---

## 2. Response Expectations & SLAs

We take security reports seriously and commit to acting swiftly upon receiving a valid disclosure:

| Phase                      | Target SLA                  | Description                                                                                                                     |
| :------------------------- | :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| **Initial Acknowledgment** | **Within 48 hours**         | We will confirm receipt of your report and assign a primary handler.                                                            |
| **Triage & Status Update** | **Within 72 hours**         | We will validate the vulnerability, assess severity, and share progress updates.                                                |
| **Patch & Remediation**    | **Within 14 calendar days** | For Critical and High severity issues, a fix will be developed, tested, and deployed to Stellar Testnet/Mainnet within 14 days. |

---

## 3. Scope & Severity Matrix by Layer

Pactum consists of multiple architectural layers with distinct security models:

```
  ┌────────────────────────────────────────────────────────┐
  │ 1. Smart Contract Layer (contracts/registry/)          │  CRITICAL
  └──────────────────────────┬─────────────────────────────┘
                             │ events
  ┌──────────────────────────▼─────────────────────────────┐
  │ 2. Backend API & Indexer (backend/)                    │  HIGH
  └──────────────────────────┬─────────────────────────────┘
                             │ API
  ┌──────────────────────────▼─────────────────────────────┐
  │ 3. Frontend & SDK (frontend/, sdk/js/)                 │  LOW - MEDIUM
  └────────────────────────────────────────────────────────┘
```

### Layer 1: Smart Contract (`contracts/registry/`) — **Critical**

- **Impact**: On-chain, immutable smart contract logic executing on Stellar (Soroban/Rust).
- **In-Scope Vulnerabilities**:
  - State corruption or unauthorized mutation of commitment outcomes (`Fulfilled`, `Late`, `Breached`).
  - Auth bypasses on `create_commitment`, `attest`, `dispute`, or `resolve_dispute`.
  - Re-entrancy, arithmetic overflow/underflow, or storage key collision attacks.
  - Flaws in contract-based reputation aggregation (`get_reputation`).

### Layer 2: Backend & Event Indexer (`backend/`) — **High**

- **Impact**: Server-side API service, event indexing from Soroban RPC, and reputation caching.
- **In-Scope Vulnerabilities**:
  - Event spoofing or indexer poisoning leading to falsified reputation history.
  - SQL injection, database tampering, or parameter pollution.
  - Authentication/authorization vulnerabilities in API endpoints.
  - Rate-limiting bypass causing backend denial of service (DoS).

### Layer 3: Frontend & Client SDK (`frontend/`, `frontend-wizard-remote/`, `frontend-dashboard-remote/`, `sdk/js/`) — **Low to Medium**

- **Impact**: Web user interface, visual components, and TypeScript client SDK.
- **In-Scope Vulnerabilities**:
  - Cross-Site Scripting (XSS) in user-facing inputs or reputation displays.
  - Client SDK input sanitization bypasses.
  - Dependency vulnerabilities with verifiable exploit paths.
- _Note_: The frontend does not handle or store user private key material directly; wallet interactions are delegated to external Stellar wallet providers (e.g. Freighter).

---

## 4. Out of Scope

The following items are considered out of scope:

- Denial of Service (DoS/DDoS) attacks against local development servers.
- Social engineering, phishing, or physical attacks against project contributors.
- Reports from automated scanners without a practical proof-of-concept demonstrating real exploitability.
- Vulnerabilities in third-party Stellar core/RPC infrastructure outside the Pactum codebase.

---

## 5. Safe Harbor Policy

If you conduct security research in good faith and in compliance with this policy, we consider your research to be authorized. We promise to:

- Not pursue legal action against you for research conducted within the guidelines of this policy.
- Work with you to understand and resolve the issue quickly.
- Recognize your contributions publicly in our Security Release Notes (unless you request anonymity).

---

## 6. Coordinated Disclosure

We ask that you refrain from disclosing the vulnerability publicly until:

1. We have released a patched version and confirmed resolution.
2. Reasonable time has elapsed to allow downstream users/integrators to update.

Thank you for helping keep Pactum secure!
