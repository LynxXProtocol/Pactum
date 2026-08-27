import { Command } from 'commander';
import chalk from 'chalk';
import { StrKey } from '@stellar/stellar-sdk';
import { PactumClient } from '@pactum/sdk';
import { getStoredCredentials } from '../config.js';

export function calculateTrustScore(fulfilled: number, late: number, breached: number): number {
  const total = fulfilled + late + breached;
  if (total === 0) return 50; // Neutral baseline for new address
  // Weighted score: Fulfilled = 1.0, Late = 0.5, Breached = 0.0
  const score = ((fulfilled * 1.0 + late * 0.5) / total) * 100;
  return Math.round(score);
}

export function formatTrustScoreBadge(score: number): string {
  if (score >= 80) return chalk.bgGreen.bold.black(` ${score} / 100 (High Trust) `);
  if (score >= 50) return chalk.bgYellow.bold.black(` ${score} / 100 (Neutral / Fair) `);
  return chalk.bgRed.bold.white(` ${score} / 100 (Low Trust / High Risk) `);
}

export function createReputationCommand(): Command {
  const repCmd = new Command('reputation').description(
    'Query on-chain reputation scores and fulfillment history',
  );

  repCmd
    .command('get')
    .description('Fetches and prints the reputation score for a Stellar address')
    .argument('[address]', 'Stellar public address (starts with G, 56 characters)')
    .option('-n, --network <network>', 'Stellar network (testnet, standalone, mainnet)')
    .option('--rpc-url <url>', 'Custom Soroban RPC URL')
    .option('--contract-id <id>', 'Custom Pactum Registry Contract ID')
    .option('--api-url <url>', 'Backend API URL for cached/extended metrics')
    .option('--json', 'Output results as JSON')
    .action(
      async (
        targetAddress: string | undefined,
        options: {
          network?: string;
          rpcUrl?: string;
          contractId?: string;
          apiUrl?: string;
          json?: boolean;
        },
      ) => {
        let address = targetAddress?.trim();
        const creds = getStoredCredentials();

        // If no address passed, attempt to use stored auth address
        if (!address) {
          if (creds.address) {
            address = creds.address;
          } else {
            const errorMsg =
              'No address specified and no authenticated account found. Provide an address: `pactum reputation get <address>`';
            if (options.json) {
              console.error(JSON.stringify({ error: errorMsg }, null, 2));
              process.exitCode = 1;
              return;
            }
            console.error(chalk.red(`\n✖ Error: ${errorMsg}\n`));
            process.exitCode = 1;
            return;
          }
        }

        // Address validation
        if (!StrKey.isValidEd25519PublicKey(address)) {
          const errorMsg = `Invalid Stellar public key: "${address}". Must be a valid 56-character G... address.`;
          if (options.json) {
            console.error(JSON.stringify({ error: errorMsg }, null, 2));
            process.exitCode = 1;
            return;
          }
          console.error(chalk.red(`\n✖ Error: ${errorMsg}\n`));
          process.exitCode = 1;
          return;
        }

        const network = options.network ?? creds.network ?? 'testnet';

        try {
          // 1. Fetch on-chain reputation data via @pactum/sdk
          const client = new PactumClient({
            network: network as any,
            rpcUrl: options.rpcUrl,
            contractId: options.contractId,
          });

          const reputation = await client.getReputation(address);
          const fulfilled = Number(reputation.fulfilledCount);
          const late = Number(reputation.lateCount);
          const breached = Number(reputation.breachedCount);
          const total = fulfilled + late + breached;
          const score = calculateTrustScore(fulfilled, late, breached);

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  address,
                  network,
                  score,
                  reputation: {
                    fulfilled,
                    late,
                    breached,
                    total,
                  },
                },
                null,
                2,
              ),
            );
            return;
          }

          console.log(chalk.bold.cyan('\n  Pactum Trust Layer — Reputation Scorecard\n'));
          console.log(`  ${chalk.gray('Target Address:')}   ${chalk.bold.white(address)}`);
          console.log(`  ${chalk.gray('Network:')}          ${chalk.magenta(network)}`);
          console.log(`  ${chalk.gray('Trust Score:')}      ${formatTrustScoreBadge(score)}\n`);

          console.log(chalk.bold('  Fulfillment Breakdown:'));
          console.log(`    ${chalk.green('✔ Fulfilled:')}    ${chalk.bold(fulfilled)} commitments`);
          console.log(`    ${chalk.yellow('▲ Late:')}         ${chalk.bold(late)} commitments`);
          console.log(`    ${chalk.red('✖ Breached:')}     ${chalk.bold(breached)} commitments`);
          console.log(
            `    ${chalk.gray('━ Total Volume:')}  ${chalk.bold(total)} historical commitments\n`,
          );
        } catch (error: any) {
          // Fallback: Try backend API if Soroban RPC is unreachable / offline
          try {
            const apiBase = options.apiUrl || process.env.PACTUM_API_URL || 'http://localhost:3000';
            const res = await fetch(`${apiBase}/reputation/${address}`);
            if (res.ok) {
              const data = (await res.json()) as any;
              const fulfilled = Number(data.fulfilled ?? 0);
              const late = Number(data.late ?? 0);
              const breached = Number(data.breached ?? 0);
              const total = fulfilled + late + breached;
              const score = calculateTrustScore(fulfilled, late, breached);

              if (options.json) {
                console.log(
                  JSON.stringify(
                    {
                      address,
                      network,
                      score,
                      reputation: { ...data, fulfilled, late, breached, total },
                      source: 'backend-api',
                    },
                    null,
                    2,
                  ),
                );
                return;
              }

              console.log(chalk.bold.cyan('\n  Pactum Trust Layer — Reputation Scorecard (API)\n'));
              console.log(`  ${chalk.gray('Target Address:')}   ${chalk.bold.white(address)}`);
              console.log(`  ${chalk.gray('Trust Score:')}      ${formatTrustScoreBadge(score)}\n`);
              console.log(chalk.bold('  Fulfillment Breakdown:'));
              console.log(
                `    ${chalk.green('✔ Fulfilled:')}    ${chalk.bold(fulfilled)} commitments`,
              );
              console.log(`    ${chalk.yellow('▲ Late:')}         ${chalk.bold(late)} commitments`);
              console.log(
                `    ${chalk.red('✖ Breached:')}     ${chalk.bold(breached)} commitments`,
              );
              console.log(
                `    ${chalk.gray('━ Total Volume:')}  ${chalk.bold(total)} historical commitments\n`,
              );
              return;
            }
          } catch {
            // Ignore fallback error and report original error below
          }

          const msg = error?.message || String(error);
          if (options.json) {
            console.error(JSON.stringify({ error: msg }, null, 2));
            process.exitCode = 1;
            return;
          }
          console.error(chalk.red(`\n✖ Failed to fetch reputation: ${msg}\n`));
          process.exitCode = 1;
        }
      },
    );

  return repCmd;
}
