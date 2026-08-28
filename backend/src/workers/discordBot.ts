import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import pool from '../db/timescale';
import { logger } from '../logger/logger';
import {
  buildDiscordEmbed,
  buildSlackPayload,
  CommitmentNotificationPayload,
} from '../services/botNotificationService';

dotenv.config();

export interface PactumBotConfig {
  discordBotToken?: string;
  discordChannelId?: string;
  discordWebhookUrl?: string;
  slackWebhookUrl?: string;
  pollIntervalMs?: number;
  startTime?: Date;
  pool?: Pool;
  dashboardUrl?: string;
}

export class PactumBotWorker {
  private discordClient: Client | null = null;
  private discordChannel: TextChannel | null = null;
  private discordBotToken?: string;
  private discordChannelId?: string;
  private discordWebhookUrl?: string;
  private slackWebhookUrl?: string;
  private pollIntervalMs: number;
  private lastPolledTime: Date;
  private db: Pool;
  private dashboardUrl?: string;
  private isRunning = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private processedEvents = new Set<string>();

  constructor(config?: PactumBotConfig) {
    this.discordBotToken = config?.discordBotToken ?? process.env.DISCORD_BOT_TOKEN;
    this.discordChannelId = config?.discordChannelId ?? process.env.DISCORD_CHANNEL_ID;
    this.discordWebhookUrl = config?.discordWebhookUrl ?? process.env.DISCORD_WEBHOOK_URL;
    this.slackWebhookUrl = config?.slackWebhookUrl ?? process.env.SLACK_WEBHOOK_URL;
    this.pollIntervalMs =
      config?.pollIntervalMs ?? Number(process.env.BOT_POLL_INTERVAL_MS ?? 5000);
    this.db = config?.pool ?? pool;
    this.dashboardUrl = config?.dashboardUrl ?? process.env.DASHBOARD_URL;

    if (config?.startTime) {
      this.lastPolledTime = config.startTime;
    } else if (process.env.BOT_START_TIME) {
      this.lastPolledTime = new Date(process.env.BOT_START_TIME);
    } else {
      // Default: Start polling from 1 minute ago to catch recent events without replaying full history
      this.lastPolledTime = new Date(Date.now() - 60 * 1000);
    }
  }

  /**
   * Initializes Discord Bot Gateway Client if bot token and channel ID are provided.
   */
  private async initDiscordClient(): Promise<void> {
    if (!this.discordBotToken || !this.discordChannelId) {
      logger.info(
        '[PactumBot] No Discord bot token or channel ID configured for Gateway client. Checking Webhook configurations...',
      );
      return;
    }

    try {
      this.discordClient = new Client({
        intents: [GatewayIntentBits.Guilds],
      });

      this.discordClient.on('ready', async () => {
        logger.info(`[PactumBot] Logged in to Discord as ${this.discordClient?.user?.tag}!`);
        if (this.discordChannelId && this.discordClient) {
          try {
            const channel = await this.discordClient.channels.fetch(this.discordChannelId);
            if (channel && channel.isTextBased()) {
              this.discordChannel = channel as TextChannel;
              logger.info(
                `[PactumBot] Connected to Discord channel: ${this.discordChannel.name} (${this.discordChannel.id})`,
              );
            } else {
              logger.warn(
                `[PactumBot] Discord channel ${this.discordChannelId} is not a valid text channel.`,
              );
            }
          } catch (err) {
            logger.error('[PactumBot] Failed to fetch Discord channel', err, {
              channelId: this.discordChannelId,
            });
          }
        }
      });

      this.discordClient.on('error', (err) => {
        logger.error('[PactumBot] Discord client encountered an error', err);
      });

      await this.discordClient.login(this.discordBotToken);
    } catch (error) {
      logger.error('[PactumBot] Failed to login to Discord with bot token', error);
    }
  }

  /**
   * Dispatches a rich embed to Discord (via Client and/or Webhook) and Slack.
   */
  public async broadcastNotification(payload: CommitmentNotificationPayload): Promise<void> {
    payload.dashboardUrl = payload.dashboardUrl || this.dashboardUrl;
    const embed = buildDiscordEmbed(payload);
    const slackPayload = buildSlackPayload(payload);

    let dispatched = false;

    // 1. Dispatch via Discord Bot Client
    if (this.discordChannel) {
      try {
        await this.discordChannel.send({ embeds: [embed] });
        dispatched = true;
        logger.info(
          `[PactumBot] Broadcasted Commitment #${payload.commitmentId} to Discord channel`,
        );
      } catch (err) {
        logger.error(`[PactumBot] Failed to send message to Discord channel`, err, {
          commitmentId: payload.commitmentId,
        });
      }
    }

    // 2. Dispatch via Discord Webhook
    if (this.discordWebhookUrl) {
      try {
        const response = await fetch(this.discordWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [embed.toJSON()],
          }),
        });

        if (response.ok) {
          dispatched = true;
          logger.info(
            `[PactumBot] Broadcasted Commitment #${payload.commitmentId} to Discord Webhook`,
          );
        } else {
          logger.error(`[PactumBot] Discord Webhook returned status ${response.status}`);
        }
      } catch (err) {
        logger.error('[PactumBot] Failed to dispatch to Discord Webhook', err);
      }
    }

    // 3. Dispatch via Slack Webhook
    if (this.slackWebhookUrl) {
      try {
        const response = await fetch(this.slackWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slackPayload),
        });

        if (response.ok) {
          dispatched = true;
          logger.info(
            `[PactumBot] Broadcasted Commitment #${payload.commitmentId} to Slack Webhook`,
          );
        } else {
          logger.error(`[PactumBot] Slack Webhook returned status ${response.status}`);
        }
      } catch (err) {
        logger.error('[PactumBot] Failed to dispatch to Slack Webhook', err);
      }
    }

    if (!dispatched) {
      logger.warn(
        `[PactumBot] Notification prepared for Commitment #${payload.commitmentId} but no active Discord/Slack destinations responded or were configured.`,
      );
    }
  }

  /**
   * Polls database for new or updated commitment outcomes and reverse index entries.
   */
  public async pollDatabase(): Promise<number> {
    let newEventsCount = 0;
    try {
      // Query commitment_outcomes for events recorded after lastPolledTime
      const outcomesResult = await this.db.query(
        `SELECT
           time,
           commitment_id as "commitmentId",
           party_a as "partyA",
           party_b as "partyB",
           amount,
           currency,
           status,
           outcome,
           due_date as "dueDate",
           completed_at as "completedAt",
           created_at as "createdAt"
         FROM commitment_outcomes
         WHERE time > $1
         ORDER BY time ASC
         LIMIT 100`,
        [this.lastPolledTime],
      );

      for (const row of outcomesResult.rows) {
        const eventKey = `outcome_${row.commitmentId}_${row.status}_${row.outcome}_${new Date(row.time).getTime()}`;
        if (!this.processedEvents.has(eventKey)) {
          this.processedEvents.add(eventKey);

          const payload: CommitmentNotificationPayload = {
            commitmentId: row.commitmentId,
            partyA: row.partyA,
            partyB: row.partyB,
            amount: row.amount,
            currency: row.currency,
            status: row.status,
            outcome: row.outcome,
            dueDate: row.dueDate,
            completedAt: row.completedAt,
            createdAt: row.createdAt,
          };

          await this.broadcastNotification(payload);
          newEventsCount++;

          const rowTime = new Date(row.time);
          if (rowTime > this.lastPolledTime) {
            this.lastPolledTime = rowTime;
          }
        }
      }

      // Also check commitment_index for any newly created commitments
      try {
        const indexResult = await this.db.query(
          `SELECT
             commitment_id as "commitmentId",
             issuer as "partyA",
             counterparty as "partyB",
             created_at as "createdAt",
             indexed_at as "indexedAt"
           FROM commitment_index
           WHERE indexed_at > $1
           ORDER BY indexed_at ASC
           LIMIT 100`,
          [this.lastPolledTime],
        );

        for (const row of indexResult.rows) {
          const eventKey = `index_${row.commitmentId}_created`;
          if (!this.processedEvents.has(eventKey)) {
            this.processedEvents.add(eventKey);

            // Only broadcast if not already sent via outcomes
            const outcomeKey = `outcome_${row.commitmentId}_pending__${new Date(row.indexedAt || row.createdAt).getTime()}`;
            if (!this.processedEvents.has(outcomeKey)) {
              const payload: CommitmentNotificationPayload = {
                commitmentId: row.commitmentId,
                partyA: row.partyA,
                partyB: row.partyB,
                status: 'pending',
                createdAt: row.createdAt,
              };

              await this.broadcastNotification(payload);
              newEventsCount++;
            }

            const rowTime = new Date(row.indexedAt || row.createdAt || Date.now());
            if (rowTime > this.lastPolledTime) {
              this.lastPolledTime = rowTime;
            }
          }
        }
      } catch (e) {
        // commitment_index query is optional if table doesn't have indexed_at or in tests
      }

      // Clean up set memory if too large
      if (this.processedEvents.size > 10000) {
        this.processedEvents.clear();
      }
    } catch (err) {
      logger.error('[PactumBot] Error while polling database for commitments', err);
    }

    return newEventsCount;
  }

  /**
   * Starts the worker polling loop.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('[PactumBot] Starting Pactum Discord/Slack Bot Worker...');
    await this.initDiscordClient();

    const pollLoop = async () => {
      if (!this.isRunning) return;
      try {
        await this.pollDatabase();
      } catch (error) {
        logger.error('[PactumBot] Unexpected error in polling loop', error);
      } finally {
        if (this.isRunning) {
          this.pollTimeout = setTimeout(pollLoop, this.pollIntervalMs);
        }
      }
    };

    void pollLoop();
  }

  /**
   * Stops the worker and disconnects Discord client.
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    if (this.discordClient) {
      await this.discordClient.destroy();
      this.discordClient = null;
      this.discordChannel = null;
    }
    logger.info('[PactumBot] Pactum Bot Worker stopped.');
  }
}

// Standalone execution entrypoint
if (require.main === module) {
  const worker = new PactumBotWorker();

  const shutdown = async () => {
    logger.info('[PactumBot] Shutting down gracefully...');
    await worker.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  worker.start().catch((err) => {
    logger.error('[PactumBot] Fatal error starting worker:', err);
    process.exit(1);
  });
}
