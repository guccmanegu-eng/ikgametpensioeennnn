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
} from "@discordjs/voice";
import { getAllAudioBase64 } from "google-tts-api";

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
    opt.setName("message").setDescription("The text to speak.").setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName("lang").setDescription("Speech language code (default: en)"),
  )
  .addBooleanOption((opt) =>
    opt
      .setName("slow")
      .setDescription("Speak at the slowest speed (default: false)"),
  );

// current client-side voice state of the bot
const voiceState = { selfMute: true, selfDeaf: true };

// one audio player shared by the whole bot
const player = createAudioPlayer();
player.on("error", (err) => console.error("Audio player error:", err));

// FIFO queue so multi-chunk TTS plays in order
const speakQueue = [];

function pumpQueue() {
  if (speakQueue.length === 0) {
    restoreMuteIfNeeded();
    return;
  }
  player.play(speakQueue.shift());
}

// true while the bot is temporarily unmuted for speech
let speaking = false;
let muteQueueRestore = false;

function restoreMuteIfNeeded() {
  if (speaking) {
    speaking = false;
    if (muteQueueRestore && !voiceState.selfMute) {
      voiceState.selfMute = true;
      applyVoiceState();
    }
    muteQueueRestore = false;
  }
}

function applyVoiceState() {
  const connection = getVoiceConnection(GUILD_ID);
  if (!connection) return false;
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
      speakQueue.length = 0;
      speaking = false;
      muteQueueRestore = false;
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
        await interaction.editReply("I'm not in a voice channel — run `/join` first.");
        return;
      }

      const text = interaction.options.getString("message", true);
      const lang = interaction.options.getString("lang") ?? "en";
      const slow = interaction.options.getBoolean("slow") ?? false;

      try {
        // getAllAudioBase64 handles short AND long text (splits >200 chars)
        const chunks = await getAllAudioBase64(text, { lang, slow });

        // unmute briefly while speaking, so everyone hears the TTS
        speaking = true;
        if (voiceState.selfMute) {
          muteQueueRestore = true;
          voiceState.selfMute = false;
          applyVoiceState();
        }

        connection.subscribe(player);

        // add this batch to the queue
        for (const c of chunks) {
          speakQueue.push(
            createAudioResource(Buffer.from(c.base64, "base64"), {
              inputType: "unknown",
            }),
          );
        }
        if (player.state.status !== AudioPlayerStatus.Playing) {
          pumpQueue();
        } else {
          // a previous batch is still playing; restore-mute will run when queue drains
        }

        await interaction.editReply(
          `Speaking **${text.length > 100 ? text.slice(0, 100) + "…" : text}** (${
            lang
          }${slow ? ", slow" : ""}).`,
        );
      } catch (err) {
        console.error(err);
        await interaction.editReply(
          "TTS failed. Google may be rate-limiting you, or the lang code is wrong.",
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

// idle => play next queued chunk; when queue empties, restore mute
player.on(AudioPlayerStatus.Idle, () => pumpQueue());

await registerCommands();
await client.login(TOKEN);
