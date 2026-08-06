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
import youtubedl from "youtube-dl-exec";
import { Readable } from "stream";
import { createRequire } from "module";
import { existsSync, readFileSync, writeFileSync } from "fs";

const require = createRequire(import.meta.url);

// Detect ffmpeg availability at startup (needed to transcode -> Opus).
// If ffmpeg-static is installed, @discordjs/voice uses it automatically.
let ffmpegPath = null;
let ffmpegError = null;
try {
  ffmpegPath = require("ffmpeg-static");
  if (ffmpegPath && existsSync(ffmpegPath)) {
    console.log(`[ffmpeg] using static binary: ${ffmpegPath}`);
  } else {
    ffmpegError = "ffmpeg-static installed but binary not found on disk";
  }
} catch (e) {
  ffmpegError =
    "ffmpeg-static is NOT installed. Add it to package.json dependencies: \"ffmpeg-static\": \"^5.2.0\"";
}
if (ffmpegError) console.error("[ffmpeg] WARNING: " + ffmpegError);

/* ------------------------------------------------------------------ */
/* YouTube: build a cookies.txt (Netscape format) from the user's JSON  */
/* so yt-dlp can pass YouTube's bot-check. Provide YT_COOKIES (JSON     */
/* array) or a cookies.json file in the project root.                   */
/* ------------------------------------------------------------------ */
const YT_COOKIES_TXT = "./cookies.txt";

function loadNetscapeCookies() {
  let json = null;
  try {
    if (process.env.YT_COOKIES) {
      json = JSON.parse(process.env.YT_COOKIES);
    } else if (existsSync("./cookies.json")) {
      json = JSON.parse(readFileSync("./cookies.json", "utf8"));
    }
  } catch (e) {
    console.error("[yt] Failed to parse cookies:", e.message);
  }
  if (!Array.isArray(json) || json.length === 0) {
    console.warn(
      "[yt] No cookies set (YT_COOKIES or cookies.json). Bot-check may block /play.",
    );
    return false;
  }
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of json) {
    const domain = c.domain?.startsWith(".") ? c.domain : "." + (c.domain || "");
    const secure = c.secure ? "TRUE" : "FALSE";
    const exp = c.expirationDate
      ? Math.floor(c.expirationDate)
      : c.expiry ?? 0;
    lines.push(
      `${domain}\tTRUE\t${c.path ?? "/"}\t${secure}\t${exp}\t${c.name}\t${c.value}`,
    );
  }
  writeFileSync(YT_COOKIES_TXT, lines.join("\n"), "utf8");
  console.log(`[yt] Wrote ${json.length} cookies to ${YT_COOKIES_TXT}`);
  return true;
}

const haveCookies = loadNetscapeCookies();

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

const playCommand = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Play audio from a YouTube video in the voice channel.")
  .addStringOption((opt) =>
    opt.setName("url").setDescription("YouTube video URL").setRequired(true),
  );

const stopCommand = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Stop playback and clear the queue.");

// current client-side voice state of the bot
const voiceState = { selfMute: true, selfDeaf: true };

// one audio player shared by the whole bot
const player = createAudioPlayer();
player.on("error", (err) =>
  console.error("[audio] player error:", err?.message ?? err),
);

// FIFO queue so multi-chunk TTS plays in order
const speakQueue = [];

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

function pumpQueue() {
  if (speakQueue.length === 0) {
    restoreMuteIfNeeded();
    return;
  }
  player.play(speakQueue.shift());
}

let speaking = false;
let muteQueueRestore = false;

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
      playCommand,
      stopCommand,
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

      // fail fast with a clear reason if ffmpeg is missing (no silent failure)
      if (ffmpegError) {
        await interaction.editReply(`⚠️ Can't speak because ${ffmpegError}`);
        return;
      }

      try {
        const chunks = await getAllAudioBase64(text, { lang, slow });

        speaking = true;
        if (voiceState.selfMute) {
          muteQueueRestore = true;
          voiceState.selfMute = false;
          applyVoiceState();
        }

        connection.subscribe(player);

        for (const c of chunks) {
          speakQueue.push(
            createAudioResource(
              Readable.from([Buffer.from(c.base64, "base64")]),
              { inputType: "arbitrary" },
            ),
          );
        }
        if (player.state.status !== AudioPlayerStatus.Playing) {
          pumpQueue();
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

    if (name === "play") {
      const connection = getVoiceConnection(GUILD_ID);
      if (!connection) {
        await interaction.editReply("I'm not in a voice channel — run `/join` first.");
        return;
      }

      const url = interaction.options.getString("url", true);

      if (ffmpegError) {
        await interaction.editReply(`⚠️ Can't play because ${ffmpegError}`);
        return;
      }

      try {
        // yt-dlp fetches metadata and hands us a direct audio URL;
        // we then stream that URL through ffmpeg -> Opus.
        const info = await youtubedl(url, {
  dumpSingleJson: true,
  format: "bestaudio/best",
  noCheckCertificates: true,
  cookies: YT_COOKIES_TXT,
  extractorArgs: {
    youtube: {
      playerClient: ["web"],
      playerSkip: ["configs"]
    }
  },
  jsRuntimes: {
    node: {}
  },
  remoteComponents: ["ejs:github"]
});

        const title =
          info?.title ??
          info?.fulltitle ??
          info?.uploader ??
          "YouTube audio";

        const audio =
  info?.requested_formats?.find((f) => f.acodec !== "none") ||
  (info?.formats || []).find(
    (f) => f.acodec !== "none" && f.vcodec === "none",
  ) ||
  info;
        const audioUrl = audio?.url || info?.url;

        if (!audioUrl) {
          await interaction.editReply(
            "⚠️ Couldn't find a playable audio stream for that video.",
          );
          return;
        }

        speaking = true;
        if (voiceState.selfMute) {
          muteQueueRestore = true;
          voiceState.selfMute = false;
          applyVoiceState();
        }

        connection.subscribe(player);
        // pass the direct media URL to @discordjs/voice; arbitrary routes
        // it through ffmpeg -> Opus
        speakQueue.push(createAudioResource(audioUrl, { inputType: "arbitrary" }));
        if (player.state.status !== AudioPlayerStatus.Playing) {
          pumpQueue();
        }

        await interaction.editReply(`🎉 Now playing: **${title}**`);
      } catch (err) {
        console.error(err);
        await interaction.editReply(
          "⚠️ Couldn't play that video. YouTube may be blocking this server IP (bot-check). Make sure YT_COOKIES is set.",
        );
      }
      return;
    }

    if (name === "stop") {
      player.stop();
      speakQueue.length = 0;
      speaking = false;
      muteQueueRestore = false;
      await interaction.editReply("Stopped playback and cleared the queue.");
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
