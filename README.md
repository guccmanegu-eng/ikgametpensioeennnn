# Discord VC Bot (`/join`)

A bot that joins one specific voice channel on `/join` and does nothing else.
Includes a tiny Express server so it can run on Render's **free Web Service** tier.

## Setup

1. Discord Developer Portal → New Application → **Bot** → copy the token.
2. Enable no privileged intents (not needed). Invite with scopes `bot applications.commands`
   and permissions **Connect** + **View Channel**.
3. In Discord, enable Developer Mode → right-click the server and the voice channel → Copy ID.

## Env vars

| Name | Value |
| --- | --- |
| `DISCORD_TOKEN` | bot token |
| `DISCORD_CLIENT_ID` | application ID |
| `GUILD_ID` | server ID |
| `VOICE_CHANNEL_ID` | the VC it should join |
| `PORT` | provided by Render automatically |

## Run locally

```bash
cd bot && npm install && npm start
```

## Deploy on Render (free)

- New → **Web Service** → connect the repo → Root Directory `bot`
- Build: `npm install` · Start: `npm start`
- Add the env vars above.

## Keep it awake 24/7

Free web services sleep after 15 min of no traffic. Create a free
[UptimeRobot](https://uptimerobot.com) / Better Stack monitor pointing at
`https://<your-service>.onrender.com/health` every 5 minutes.
