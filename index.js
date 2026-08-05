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
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import { getVoiceBuffer } from "google-tts-api";

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

const leaveCommand = new SlashCommandBuilder()
  .setName("leave")
  .setDescription("Leave the voice channel.");

const muteCommand = new SlashCommandBuilder()
  .setName("mute")
  .setDescription("Self-mute the bot (client side, not a server mute).");

const unmuteCommand = new SlashCommandBuilder()
  .setName("unmute")
  .setDescription("Remove the bot's self-mute.");

const deafenCommand = new SlashCommandBuilder()
  .setName("deafen")
  .setDescription("Self-deafen the bot (client side, not a server deafen).");

const undeafenCommand = new SlashCommandBuilder()
  .setName("undeafen")
  .setDescription("Remove the bot's self-deafen.");

const speakCommand = new SlashCommandBuilder()
  .setName("speak")
  .setDescription("Say text out loud in the voice channel via TTS.")
  .addStringOption((opt) =>
    opt
      .setName("message")
      .setDescription("The text to speak.")
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("lang")
      .setDescription("Speech language code (default: en)"),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("speed")
      .setDescription("Speech speed (0.24 – 4.0, default 1.0)"),
  );

// current client-side voice state of the bot
const voiceState = { selfMute: true, selfDeaf: true };

// one audio player shared by the whole bot
const player = createAudioPlayer();
player.on(AudioPlayerStatus.Idle, () => {});
player.on("error", (err) => console.error("Audio player error:", err));

function applyVoiceState() {
  const connection = getVoiceConnection(GUILD_ID);
  if (!connection) return false;
  // rejoin with the same channel but updated self-mute/self-deaf flags
  connection.rejoin({
    channelId: connection.joinConfig.channelId,
    selfMute: voiceState.selfMute,
    selfDeaf: voiceState.selfDeaf,
  });
  return true;
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [
      joinCommand,
      leaveCommand,
      muteCommand,
      unmuteCommand,
      deafenCommand,
      undeafenCommand,
      speakCommand,
    ].map((c) => c.toJSON()),
  });
  console.log("Slash commands registered.");
}

client.once("clientReady", (c) => console.log(`Logged in as ${c.user.tag}`));

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (name === "leave") {
      const connection = getVoiceConnection(GUILD_ID);
      if (!connection) {
        await interaction.editReply("I'm not in a voice channel.");
        return;
      }
      player.stop();
      connection.destroy();
      await interaction.editReply("Left the voice channel.");
      return;
    }

    if (["mute", "unmute", "deafen", "undeafen"].includes(name)) {
      if (name === "mute") voiceState.selfMute = true;
      if (name === "unmute") voiceState.selfMute = false;
      if (name === "deafen") voiceState.selfDeaf = true;
      if (name === "undeafen") voiceState.selfDeaf = false;

      const ok = applyVoiceState();
      await interaction.editReply(
        ok
          ? `Self-mute: **${voiceState.selfMute ? "on" : "off"}**, self-deafen: **${
              voiceState.selfDeaf ? "on" : "off"
            }**.`
          : "I'm not in a voice channel — run `/join` first. (Setting saved for next join.)",
      );
      return;
    }

    if (name === "speak") {
      const connection = getVoiceConnection(GUILD_ID);
      if (!connection) {
        await interaction.editReply(
          "I'm not in a voice channel — run `/join` first.",
        );
        return;
      }

      const text = interaction.options.getString("message", true);
      const lang = interaction.options.getString("lang") ?? "en";
      const speed =
        interaction.options.getInteger("speed") ?? 1.0; // matches google-tts-api range

      try {
        const buffer = await getVoiceBuffer(text, {
          lang,
          speed,
        });

        // TTS should be audible, so unmute briefly while speaking
        const hadMute = voiceState.selfMute;
        if (hadMute) {
          voiceState.selfMute = false;
          applyVoiceState();
        }

        const resource = createAudioResource(buffer, {
          inputType: "unknown", // raw MP3 bytes from google-tts-api
        });

        connection.subscribe(player);
        player.play(resource);

        // restore mute state after playback finishes
        player.once(AudioPlayerStatus.Idle, () => {
          if (hadMute) {
            voiceState.selfMute = true;
            applyVoiceState();
          }
        });

        await interaction.editReply(
          `Speaking **${text.length > 100 ? text.slice(0, 100) + "…" : text}** (${
            lang
          }, speed ${speed}).`,
        );
      } catch (err) {
        console.error(err);
        await interaction.editReply(
          "TTS failed. The text may be too long, or google-tts-api is temporarily unavailable.",
        );
      }
      return;
    }

    if (name !== "join") return;

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
      selfDeaf: voiceState.selfDeaf,
      selfMute: voiceState.selfMute,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    await interaction.editReply(`Joined **${channel.name}**. Doing nothing. 🙂`);
  } catch (err) {
    console.error(err);
    await interaction.editReply("Something went wrong with that command.");
  }
});

await registerCommands();
await client.login(TOKEN);
