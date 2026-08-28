# Pactum Discord & Slack Notification Bot (`pactum-bot`)

DAOs, guilds, and decentralized teams use Discord or Slack as their primary coordination hubs. The **Pactum Bot** enables real-time commitment tracking by streaming on-chain commitment events (created, fulfilled, late, breached, or disputed) directly into your communication channels.

---

## 🌟 Features

- **Rich Discord Embeds**: Formatted cards with custom color-coding, icons, addresses, amounts, deadlines, and direct links to the Pactum Dashboard.
  - 📋 **Created**: Blue card with issuer, counterparty, amount, due date, and template.
  - ✅ **Fulfilled**: Green card confirming successful on-time delivery.
  - ⏰ **Late**: Yellow alert when delivery occurred after the agreed deadline.
  - ❌ **Breached**: Red alert when commitments expire unfulfilled.
  - ⚠️ **Disputed**: Prominent red/orange alert notifying members of active disputes.
- **Slack Block Kit Integration**: Clean, structured notifications with header, formatted fields, and dashboard links.
- **Dual Delivery Modes**:
  - **Discord Bot (Gateway Client)**: Connects via Bot Token to post in designated guild channels.
  - **Webhooks (Discord & Slack)**: Direct HTTP webhook delivery without needing bot guild invites or gateway connections.
- **Resilient Polling & Deduplication**: Avoids duplicate alerts and persists last-polled state.

---

## 🚀 Setup & Configuration Guide

Organizations can set up Pactum notifications using either **Discord Bot Gateway**, **Discord Webhook**, or **Slack Webhook**.

### Option 1: Discord Webhook (Simplest & Recommended for single channels)

1. Open your Discord server and navigate to the channel where you want notifications posted.
2. Click the gear icon (**Edit Channel**) > **Integrations** > **Webhooks** > **New Webhook**.
3. Name your webhook (e.g. `Pactum Tracker`) and copy the **Webhook URL**.
4. In your `.env` file, set:
   ```env
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
   ```

---

### Option 2: Discord Bot (Gateway Client)

To invite a dedicated Pactum Bot to your server:

#### 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**, name it (e.g., `Pactum Commitment Bot`), and accept the Terms of Service.

#### 2. Create the Bot User & Get Token

1. In the application sidebar, navigate to **Bot**.
2. Click **Add Bot** (or **Reset Token** if already created).
3. Copy the **Token** (keep this secret!).
4. Enable **Privileged Gateway Intents** if needed (the bot only requires default Guilds access).

#### 3. Generate Invite Link

1. Navigate to **OAuth2** > **URL Generator**.
2. Under **Scopes**, check:
   - `bot`
3. Under **Bot Permissions**, check:
   - `Send Messages`
   - `Embed Links`
   - `View Channels`
   - `Read Message History`
4. Copy the generated URL at the bottom and paste it in your browser to invite the bot to your Discord server / guild.

#### 4. Configure Environment Variables

1. In Discord, enable Developer Mode (**User Settings** > **Advanced** > **Developer Mode**).
2. Right-click the channel where you want commitment events posted and click **Copy Channel ID**.
3. In your `backend/.env` file:
   ```env
   DISCORD_BOT_TOKEN=your_bot_token_here
   DISCORD_CHANNEL_ID=your_discord_channel_id_here
   ```

---

### Option 3: Slack Webhook

1. Go to [Slack API: Your Apps](https://api.slack.com/apps) and create a new App in your workspace.
2. Select **Incoming Webhooks** and switch the toggle to **On**.
3. Click **Add New Webhook to Workspace**, select the channel, and click **Authorize**.
4. Copy the **Webhook URL** and configure your `.env`:
   ```env
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/XXXX
   ```

---

## ⚙️ Environment Variables Summary

| Variable               | Description                                  | Required                  | Default                  |
| ---------------------- | -------------------------------------------- | ------------------------- | ------------------------ |
| `DISCORD_WEBHOOK_URL`  | Discord incoming webhook endpoint            | Optional                  | —                        |
| `DISCORD_BOT_TOKEN`    | Discord Bot application token                | Optional                  | —                        |
| `DISCORD_CHANNEL_ID`   | Discord channel ID to send messages to       | Required if bot token set | —                        |
| `SLACK_WEBHOOK_URL`    | Slack incoming webhook URL                   | Optional                  | —                        |
| `BOT_POLL_INTERVAL_MS` | Polling frequency in milliseconds            | Optional                  | `5000`                   |
| `BOT_START_TIME`       | Starting ISO timestamp for historical events | Optional                  | Current time - 1m        |
| `DASHBOARD_URL`        | Public base URL for Pactum dashboard links   | Optional                  | `https://pactum.network` |

---

## 🏃 Running the Bot

### In Development

```bash
cd backend
npm run dev:bot
```

### In Production

```bash
cd backend
npm run build
npm run pactum-bot
```

Or via Docker / process manager (e.g., PM2, systemd, Kubernetes).
