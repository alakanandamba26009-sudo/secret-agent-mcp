// Shared helpers: calls to Gnani (Vachana) REST APIs + signed audio links.
// The Gnani key is read ONLY from the GNANI_API_KEY environment variable.
const crypto = require("crypto");

const GNANI_BASE = "https://api.vachana.ai";
const STT_URL = `${GNANI_BASE}/stt/v3`;
const TTS_URL = `${GNANI_BASE}/api/v1/tts/inference`;

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB safety cap
const MAX_TTS_CHARS = 1500;

const FORMATS = {
  mp3: { container: "mp3", encoding: "linear_pcm", mime: "audio/mpeg", ext: "mp3" },
  wav: { container: "wav", encoding: "linear_pcm", mime: "audio/wav", ext: "wav" },
  // Telegram/WhatsApp voice notes want OGG/Opus
  ogg_opus: { container: "ogg", encoding: "oggopus", mime: "audio/ogg", ext: "ogg" },
};

function apiKey() {
  const k = process.env.GNANI_API_KEY;
  if (!k) throw new Error("Server misconfigured: GNANI_API_KEY environment variable is not set.");
  return k;
}

function guessName(url, contentType) {
  const fromUrl = (url.split("?")[0].split("/").pop() || "").trim();
  if (/\.(wav|mp3|ogg|oga|opus|flac|aac|m4a)$/i.test(fromUrl)) return fromUrl;
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("ogg") || ct.includes("opus")) return "audio.ogg";
  if (ct.includes("mpeg") || ct.includes("mp3")) return "audio.mp3";
  if (ct.includes("flac")) return "audio.flac";
  if (ct.includes("aac")) return "audio.aac";
  if (ct.includes("mp4") || ct.includes("m4a")) return "audio.m4a";
  return "audio.wav";
}

async function speechToText({ audio_url, language_code = "en-IN" }) {
  if (!audio_url || !/^https?:\/\//i.test(audio_url)) {
    throw new Error("audio_url must be a public http(s) URL to an audio file.");
  }
  const audioRes = await fetch(audio_url, { signal: AbortSignal.timeout(20000) });
  if (!audioRes.ok) throw new Error(`Could not download audio (HTTP ${audioRes.status}).`);
  const buf = Buffer.from(await audioRes.arrayBuffer());
  if (buf.length === 0) throw new Error("Downloaded audio file is empty.");
  if (buf.length > MAX_AUDIO_BYTES) throw new Error("Audio file is larger than 10 MB.");

  const ct = audioRes.headers.get("content-type") || "application/octet-stream";
  const form = new FormData();
  form.append("audio_file", new Blob([buf], { type: ct }), guessName(audio_url, ct));
  form.append("language_code", language_code);

  const r = await fetch(STT_URL, {
    method: "POST",
    headers: { "X-API-Key-ID": apiKey() },
    body: form,
    signal: AbortSignal.timeout(45000),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!r.ok || data.success === false) {
    throw new Error(`Gnani STT error (HTTP ${r.status}): ${JSON.stringify(data).slice(0, 500)}`);
  }
  return {
    transcript: data.transcript ?? "",
    language_code,
    request_id: data.request_id ?? null,
    model: data.model ?? null,
  };
}

async function synthesize({
  text,
  voice = "Jwala",
  language = "en-IN",
  speed = 1.0,
  format = "mp3",
}) {
  if (!text || !String(text).trim()) {
    throw new Error("text is required.");
  }

  if (String(text).length > MAX_TTS_CHARS) {
    throw new Error(
      `text must be at most ${MAX_TTS_CHARS} characters.`
    );
  }

  const f = FORMATS[format];

  if (!f) {
    throw new Error(
      `format must be one of: ${Object.keys(FORMATS).join(", ")}`
    );
  }

  let audio_config;

  if (format === "mp3") {
    audio_config = {
      container: "mp3",
      sample_rate: 48000,
      bitrate: "128k",
    };
  } else if (format === "wav") {
    audio_config = {
      container: "wav",
      sample_rate: 48000,
      encoding: "linear_pcm",
    };
  } else {
    audio_config = {
      container: "ogg",
      sample_rate: 48000,
      encoding: "oggopus",
    };
  }

  const r = await fetch(TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key-ID": apiKey(),
    },
    body: JSON.stringify({
      text: String(text),
      voice,
      model: "timbre-v2.5",
      language,
      speed: Number(speed) || 1.0,
      audio_config,
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!r.ok) {
    const errText = await r.text();

    throw new Error(
      `Gnani TTS error (HTTP ${r.status}): ${errText.slice(0, 500)}`
    );
  }

  const audio = Buffer.from(await r.arrayBuffer());

  if (!audio.length) {
    throw new Error("Gnani TTS returned an empty audio response.");
  }

  return {
    audio,
    mime: f.mime,
    ext: f.ext,
  };
}

// ---- Signed, stateless audio links ----
// The URL carries the TTS parameters + an HMAC so only links issued by this
// server work. When a messaging app fetches it, /api/audio re-synthesizes via Gnani.
function signingKey() {
  return crypto.createHash("sha256").update("gnani-mcp-audio-link:" + apiKey()).digest();
}
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makeAudioToken(params) {
  const payload = b64url(JSON.stringify(params));
  const sig = b64url(crypto.createHmac("sha256", signingKey()).update(payload).digest()).slice(0, 32);
  return { payload, sig };
}
function readAudioToken(payload, sig) {
  const expected = b64url(crypto.createHmac("sha256", signingKey()).update(payload).digest()).slice(0, 32);
  if (!sig || sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error("Invalid audio link signature.");
  }
  const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

module.exports = { speechToText, synthesize, makeAudioToken, readAudioToken, FORMATS };
