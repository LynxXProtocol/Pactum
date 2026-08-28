import { EmbedBuilder } from 'discord.js';

export interface CommitmentNotificationPayload {
  commitmentId: string;
  partyA: string;
  partyB?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  status: string;
  outcome?: string | null;
  template?: string | null;
  dueDate?: Date | string | null;
  completedAt?: Date | string | null;
  createdAt?: Date | string | null;
  dashboardUrl?: string | null;
}

export function formatAddress(address?: string | null): string {
  if (!address) return 'N/A';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatDate(date?: Date | string | null): string {
  if (!date) return 'N/A';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return 'N/A';
  return d.toUTCString();
}

export function formatAmount(amount?: number | string | null, currency?: string | null): string {
  if (amount === undefined || amount === null || amount === '') return 'N/A';
  const num = typeof amount === 'number' ? amount : parseFloat(amount);
  if (isNaN(num)) return 'N/A';
  const curr = currency || 'XLM';
  return `${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })} ${curr}`;
}

export enum EventType {
  CREATED = 'CREATED',
  FULFILLED = 'FULFILLED',
  LATE = 'LATE',
  BREACHED = 'BREACHED',
  DISPUTED = 'DISPUTED',
}

export function determineEventType(data: CommitmentNotificationPayload): EventType {
  const outcome = (data.outcome || '').toLowerCase();
  const status = (data.status || '').toLowerCase();

  if (outcome === 'disputed' || status === 'disputed') {
    return EventType.DISPUTED;
  }
  if (outcome === 'late' || status === 'late') {
    return EventType.LATE;
  }
  if (outcome === 'breached' || status === 'breached') {
    return EventType.BREACHED;
  }
  if (outcome === 'fulfilled' || status === 'fulfilled' || status === 'completed') {
    return EventType.FULFILLED;
  }
  return EventType.CREATED;
}

export interface DiscordEmbedData {
  title: string;
  description: string;
  color: number;
  fields: { name: string; value: string; inline?: boolean }[];
  footer: { text: string };
  timestamp: string;
  url?: string;
}

/**
 * Builds a rich Discord Embed (compatible with both Discord.js EmbedBuilder and Webhooks).
 */
export function buildDiscordEmbed(data: CommitmentNotificationPayload): EmbedBuilder {
  const eventType = determineEventType(data);
  const embed = new EmbedBuilder();
  const baseUrl = data.dashboardUrl || process.env.DASHBOARD_URL || 'https://pactum.network';
  const commitmentUrl = `${baseUrl.replace(/\/$/, '')}/commitments/${data.commitmentId}`;

  const partyAFormatted = formatAddress(data.partyA);
  const partyBFormatted = formatAddress(data.partyB);
  const amountFormatted = formatAmount(data.amount, data.currency);
  const dueDateFormatted = formatDate(data.dueDate);

  embed.setURL(commitmentUrl);
  embed.setTimestamp();
  embed.setFooter({ text: 'Pactum Trust Layer • Stellar Soroban' });

  switch (eventType) {
    case EventType.DISPUTED:
      embed.setTitle(`⚠️ Commitment #${data.commitmentId} has been DISPUTED`);
      embed.setDescription(
        `🚨 **Dispute Alert**: Participating parties have reported a dispute on Commitment **#${data.commitmentId}**. Action or oracle arbitration may be required.`,
      );
      embed.setColor(0xe74c3c); // Red / Alert
      embed.addFields(
        { name: 'Issuer (Party A)', value: `\`${partyAFormatted}\``, inline: true },
        { name: 'Counterparty (Party B)', value: `\`${partyBFormatted}\``, inline: true },
        { name: 'Status', value: '⚠️ **DISPUTED**', inline: true },
        { name: 'Amount', value: amountFormatted, inline: true },
        { name: 'Due Date', value: dueDateFormatted, inline: true },
        { name: 'Template', value: data.template || 'Custom Agreement', inline: true },
      );
      break;

    case EventType.FULFILLED:
      embed.setTitle(`✅ Commitment #${data.commitmentId} FULFILLED`);
      embed.setDescription(
        `🎉 Commitment **#${data.commitmentId}** was successfully fulfilled on time. Trust score updated.`,
      );
      embed.setColor(0x2ecc71); // Green
      embed.addFields(
        { name: 'Issuer (Party A)', value: `\`${partyAFormatted}\``, inline: true },
        { name: 'Counterparty (Party B)', value: `\`${partyBFormatted}\``, inline: true },
        { name: 'Outcome', value: '✅ **Fulfilled (On Time)**', inline: true },
        { name: 'Amount', value: amountFormatted, inline: true },
        {
          name: 'Completed At',
          value: formatDate(data.completedAt || data.createdAt),
          inline: true,
        },
        { name: 'Template', value: data.template || 'Custom Agreement', inline: true },
      );
      break;

    case EventType.LATE:
      embed.setTitle(`⏰ Commitment #${data.commitmentId} Fulfilled LATE`);
      embed.setDescription(
        `⚠️ Commitment **#${data.commitmentId}** was fulfilled after the agreed deadline.`,
      );
      embed.setColor(0xf1c40f); // Yellow
      embed.addFields(
        { name: 'Issuer (Party A)', value: `\`${partyAFormatted}\``, inline: true },
        { name: 'Counterparty (Party B)', value: `\`${partyBFormatted}\``, inline: true },
        { name: 'Outcome', value: '⏰ **Late Delivery**', inline: true },
        { name: 'Amount', value: amountFormatted, inline: true },
        {
          name: 'Completed At',
          value: formatDate(data.completedAt || data.createdAt),
          inline: true,
        },
        { name: 'Due Date', value: dueDateFormatted, inline: true },
      );
      break;

    case EventType.BREACHED:
      embed.setTitle(`❌ Commitment #${data.commitmentId} BREACHED`);
      embed.setDescription(
        `❌ Commitment **#${data.commitmentId}** expired or was breached without fulfillment. Trust score penalised.`,
      );
      embed.setColor(0x992d22); // Dark Red
      embed.addFields(
        { name: 'Issuer (Party A)', value: `\`${partyAFormatted}\``, inline: true },
        { name: 'Counterparty (Party B)', value: `\`${partyBFormatted}\``, inline: true },
        { name: 'Outcome', value: '❌ **Breached**', inline: true },
        { name: 'Amount', value: amountFormatted, inline: true },
        { name: 'Due Date', value: dueDateFormatted, inline: true },
        { name: 'Template', value: data.template || 'Custom Agreement', inline: true },
      );
      break;

    case EventType.CREATED:
    default:
      embed.setTitle(`📋 New Commitment Created • #${data.commitmentId}`);
      embed.setDescription(
        `✨ A new commitment has been registered on-chain on the Pactum Trust Layer.`,
      );
      embed.setColor(0x3498db); // Blue
      embed.addFields(
        { name: 'Issuer (Party A)', value: `\`${partyAFormatted}\``, inline: true },
        { name: 'Counterparty (Party B)', value: `\`${partyBFormatted}\``, inline: true },
        { name: 'Status', value: '🟢 **Active / Pending**', inline: true },
        { name: 'Amount', value: amountFormatted, inline: true },
        { name: 'Due Date', value: dueDateFormatted, inline: true },
        { name: 'Template', value: data.template || 'Custom Agreement', inline: true },
      );
      break;
  }

  return embed;
}

/**
 * Builds a Slack Block Kit payload representing the event.
 */
export function buildSlackPayload(data: CommitmentNotificationPayload): Record<string, any> {
  const eventType = determineEventType(data);
  const partyAFormatted = formatAddress(data.partyA);
  const partyBFormatted = formatAddress(data.partyB);
  const amountFormatted = formatAmount(data.amount, data.currency);
  const dueDateFormatted = formatDate(data.dueDate);
  const baseUrl = data.dashboardUrl || process.env.DASHBOARD_URL || 'https://pactum.network';
  const commitmentUrl = `${baseUrl.replace(/\/$/, '')}/commitments/${data.commitmentId}`;

  let headerText = `📋 New Commitment #${data.commitmentId}`;
  let statusText = `*Status:* Active / Pending`;

  if (eventType === EventType.DISPUTED) {
    headerText = `⚠️ Commitment #${data.commitmentId} has been DISPUTED`;
    statusText = `*Status:* ⚠️ *DISPUTED*`;
  } else if (eventType === EventType.FULFILLED) {
    headerText = `✅ Commitment #${data.commitmentId} FULFILLED`;
    statusText = `*Outcome:* ✅ *Fulfilled (On Time)*`;
  } else if (eventType === EventType.LATE) {
    headerText = `⏰ Commitment #${data.commitmentId} Fulfilled LATE`;
    statusText = `*Outcome:* ⏰ *Late Delivery*`;
  } else if (eventType === EventType.BREACHED) {
    headerText = `❌ Commitment #${data.commitmentId} BREACHED`;
    statusText = `*Outcome:* ❌ *Breached*`;
  }

  return {
    text: `${headerText} - View details: ${commitmentUrl}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: headerText,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<${commitmentUrl}|*View Commitment #${data.commitmentId} on Pactum Dashboard*>`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Issuer (Party A):*\n\`${partyAFormatted}\``,
          },
          {
            type: 'mrkdwn',
            text: `*Counterparty (Party B):*\n\`${partyBFormatted}\``,
          },
          {
            type: 'mrkdwn',
            text: statusText,
          },
          {
            type: 'mrkdwn',
            text: `*Amount:*\n${amountFormatted}`,
          },
          {
            type: 'mrkdwn',
            text: `*Due Date:*\n${dueDateFormatted}`,
          },
          {
            type: 'mrkdwn',
            text: `*Template:*\n${data.template || 'Custom Agreement'}`,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `🛡️ *Pactum Trust Layer* • Soroban Stellar • ${new Date().toUTCString()}`,
          },
        ],
      },
    ],
  };
}
