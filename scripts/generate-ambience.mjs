import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Original electric-piano score; the door chime uses a bundled CC0 recording.
// Recording attribution and excerpt details are in public/assets/manifest.json.
// FFmpeg is only needed to regenerate assets, not to run the shipped application.
const sampleRate = 32_000;
const tempo = 72;
const beat = 60 / tempo;
const chords = [
  [48, 55, 59, 62, 64],
  [45, 52, 55, 59, 60],
  [41, 48, 52, 55, 57],
  [43, 50, 53, 57, 62],
  [48, 55, 59, 62, 64],
  [47, 54, 57, 62, 66],
  [45, 52, 55, 59, 60],
  [43, 50, 53, 57, 59],
  [41, 48, 52, 55, 60],
  [40, 47, 50, 55, 59],
  [45, 52, 55, 59, 62],
  [38, 45, 48, 52, 57],
  [41, 48, 52, 55, 57],
  [43, 50, 53, 57, 59],
  [48, 55, 59, 62, 64],
  [43, 50, 53, 57, 62],
];
const melody = [76, 71, 69, 74, 72, 69, 71, 74, 72, 71, 69, 64, 69, 71, 76, 74];

function createStereo(seconds) {
  const length = Math.round(seconds * sampleRate);
  return [new Float32Array(length), new Float32Array(length)];
}

function addNote(channels, start, midi, amplitude, pan) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  const length = Math.ceil(5.5 * sampleRate);
  const offset = Math.round(start * sampleRate);
  const left = Math.sqrt((1 - pan) / 2);
  const right = Math.sqrt((1 + pan) / 2);

  for (let frame = 0; frame < length; frame += 1) {
    const position = (offset + frame) % channels[0].length;
    if (position >= channels[0].length) break;
    const t = frame / sampleRate;
    const phase = 2 * Math.PI * frequency * t;
    const attack = 1 - Math.exp(-t / 0.016);
    const tone =
      0.8 * Math.sin(phase) * Math.exp(-t / 1.65) +
      0.18 * Math.sin(phase * 2) * Math.exp(-t / 0.8) +
      0.07 * Math.sin(phase * 3) * Math.exp(-t / 0.38) +
      0.025 * Math.sin(phase * 7) * Math.exp(-t / 0.075);
    const tremolo = 0.98 + 0.02 * Math.sin(t * Math.PI * 9);
    const value = tone * attack * amplitude * tremolo;
    channels[0][position] += value * left;
    channels[1][position] += value * right;
  }
}

function addRoom(channels, looping) {
  const dry = channels.map((channel) => Float32Array.from(channel));
  const taps = [
    [0.073, 0.12],
    [0.131, 0.08],
    [0.229, 0.045],
    [0.371, 0.025],
  ];
  for (const [delay, gain] of taps) {
    const offset = Math.round(delay * sampleRate);
    for (let frame = 0; frame < dry[0].length; frame += 1) {
      const position = looping
        ? (frame + offset) % dry[0].length
        : frame + offset;
      if (position >= dry[0].length) break;
      channels[0][position] += dry[1][frame] * gain;
      channels[1][position] += dry[0][frame] * gain;
    }
  }
}

function encodeWav(channels, peak) {
  let maximum = 0;
  for (const channel of channels)
    for (const value of channel) maximum = Math.max(maximum, Math.abs(value));
  const gain = peak / Math.max(maximum, 0.001);
  const dataSize = channels[0].length * 4;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(dataSize + 36, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < channels[0].length; frame += 1) {
    for (let channel = 0; channel < 2; channel += 1) {
      const value = Math.max(-1, Math.min(1, channels[channel][frame] * gain));
      wav.writeInt16LE(Math.round(value * 32767), 44 + frame * 4 + channel * 2);
    }
  }
  return wav;
}

const music = createStereo(chords.length * 4 * beat);
for (const [bar, notes] of chords.entries()) {
  const start = bar * 4 * beat;
  addNote(music, start, notes[0], 0.32, -0.1);
  for (let voice = 1; voice < notes.length; voice += 1) {
    addNote(
      music,
      start + 0.22 * beat + voice * 0.035,
      notes[voice],
      0.12,
      -0.35 + voice * 0.13,
    );
  }
  addNote(music, start + 1.8 * beat, melody[bar], 0.105, 0.24);
  if (bar % 2 === 0)
    addNote(music, start + 3.05 * beat, notes[3] + 12, 0.065, -0.2);
}
addRoom(music, true);

const windChimeSource = resolve(
  "server/fixtures/ambience/furin-501168-source.wav",
);
const bellOnly = process.argv.includes("--bell-only");
const assets = bellOnly ? ["furin-three-strikes"] : ["cafe-music", "furin-three-strikes"];
const windChimeFilters = [
  // Preserve the selected Furin's pitch; reuse its natural strike with softer rebounds.
  "[0:a]atrim=start=0.35:end=1.65,asetpts=PTS-STARTPTS,highpass=f=150,lowpass=f=10000,afade=t=in:d=0.003,afade=t=out:st=1.08:d=0.22,asplit=3[a][b][c]",
  "[a]adelay=30:all=1[first]",
  "[b]volume=0.67,adelay=430:all=1[second]",
  "[c]volume=0.44,adelay=930:all=1[third]",
  "[first][second][third]amix=inputs=3:normalize=0[chime]",
].join(";");
const staging = await mkdtemp(join(tmpdir(), "mira-ambience-"));
const output = resolve("public/assets/audio");
await mkdir(output, { recursive: true });

try {
  for (const name of assets) {
    const source = join(staging, `${name}.wav`);
    const encoded = join(staging, `${name}.mp3`);
    if (name === "cafe-music") {
      await writeFile(source, encodeWav(music, 0.78));
    } else {
      const pcm = execFileSync(
        process.env.FFMPEG_PATH || "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          windChimeSource,
          "-filter_complex",
          windChimeFilters,
          "-map",
          "[chime]",
          "-ar",
          String(sampleRate),
          "-ac",
          "2",
          "-f",
          "f32le",
          "pipe:1",
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      const chime = createStereo(2.1);
      if (pcm.length < chime[0].length * 8 || pcm.length % 8 !== 0)
        throw new Error("Incomplete Furin arrangement");
      for (let frame = 0; frame < chime[0].length; frame += 1) {
        // Sample-domain trimming avoids filter timestamp rounding on very short clips.
        const fade = Math.min(
          1,
          (chime[0].length - frame) / (sampleRate * 0.45),
        );
        chime[0][frame] = pcm.readFloatLE(frame * 8) * fade;
        chime[1][frame] = pcm.readFloatLE(frame * 8 + 4) * fade;
      }
      // Peak normalization preserves short transients and the exact two-second timing.
      await writeFile(source, encodeWav(chime, 0.7));
    }
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      source,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      name === "furin-three-strikes" ? "160k" : "128k",
      encoded,
    ]);
  }
  // Install only after all requested assets have encoded successfully.
  for (const name of assets) {
    await writeFile(
      join(output, `${name}.mp3`),
      await readFile(join(staging, `${name}.mp3`)),
    );
  }
  console.info(
    bellOnly
      ? "Prepared the 2.1-second Japanese Furin with three light strikes."
      : `Generated original cafe score (${(music[0].length / sampleRate).toFixed(2)} s) and recorded wind chime.`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
