#!/bin/bash
REPO="LynxXProtocol/Pactum"

# Issue 1
cat << 'EOF' > issue1.txt
Currently, the backend relies on standard `console.log` for output. To improve observability, debugging, and log ingestion (especially in production), we should migrate to a structured logging library like Winston or Pino. This includes adding log levels (info, warn, error) and contextual metadata to all API routes and indexer events.
EOF
gh issue create --repo $REPO --title "Implement structured logging (e.g., Winston/Pino) in the Express backend" --body-file issue1.txt

# Issue 2
cat << 'EOF' > issue2.txt
As the number of commitments grows in the TimescaleDB database, the `GET /commitments` endpoint will become a bottleneck if it returns all records at once. We need to implement cursor-based or offset-based pagination. Additionally, adding query parameters to filter by `issuer`, `counterparty`, and `status` would greatly improve the API's usability.
EOF
gh issue create --repo $REPO --title "Add pagination and filtering to the \`GET /commitments\` API route" --body-file issue2.txt

# Issue 3
cat << 'EOF' > issue3.txt
To protect our backend infrastructure from abuse or DDoS attacks, we should introduce rate limiting on our public API endpoints. Using a library like `express-rate-limit` with a Redis or in-memory store would ensure fair usage and prevent exhaustion of our database resources.
EOF
gh issue create --repo $REPO --title "Implement API Rate Limiting for the backend Express server" --body-file issue3.txt

# Issue 4
cat << 'EOF' > issue4.txt
The `FinalityIndexer` is a critical component that listens to Soroban ledger events and populates TimescaleDB. We need a robust E2E test suite that spins up a local Soroban node, triggers contract events on the registry, and asserts that the indexer correctly processes, maps, and stores the `CommitmentStatus` updates and milestones in the database without data loss.
EOF
gh issue create --repo $REPO --title "Comprehensive End-to-End (E2E) tests for the FinalityIndexer" --body-file issue4.txt

# Issue 5
cat << 'EOF' > issue5.txt
Getting the local development environment running requires starting the Express server, setting up TimescaleDB, and running a Soroban RPC node separately. We should create a `docker-compose.yml` file that orchestrates all these services (Postgres/TimescaleDB, backend API, and a local stellar-quickstart node) so developers can spin up the entire stack with a single `docker compose up` command.
EOF
gh issue create --repo $REPO --title "Setup Docker Compose for streamlined local development" --body-file issue5.txt

# Cleanup
rm issue*.txt
