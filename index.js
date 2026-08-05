import express from "express";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} from "@discordjs/voice";

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;          // server the bot lives in
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID; // the specific VC to join
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error(
    "Missing env vars: DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, VOICE_CHANNEL_ID",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 1. Tiny HTTP server so Render (Web Service) has a port to monitor    */
/* ------------------------------------------------------------------ */
const app = express();
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) =>
  res.status(200).json({ status: "ok", ready: client.isReady() }),
);
app.listen(PORT, () => console.log(`HTTP server listening on :${PORT}`));

/* ------------------------------------------------------------------ */
/* 2. Discord client                                                    */
/* ------------------------------------------------------------------ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const joinCommand = new SlashCommandBuilder()
  .setName("join")
  .setDescription("Join the configured voice channel and sit there silently.");

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [joinCommand.toJSON()],
  });
  console.log("Slash command /join registered.");
}

client.once("clientReady", (c) => console.log(`Logged in as ${c.user.tag}`));

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "join")
    return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const guild = interaction.guild ?? (await client.guilds.fetch(GUILD_ID));
    const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

    if (!channel || !channel.isVoiceBased()) {
      await interaction.editReply("That channel isn't a voice channel.");
      return;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    await interaction.editReply(`Joined **${channel.name}**. Doing nothing. 🙂`);
  } catch (err) {
    console.error(err);
    await interaction.editReply("Couldn't join the voice channel.");
  }
});

await registerCommands();
await client.login(TOKEN);
