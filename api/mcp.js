// Minimal stateless MCP server (Streamable HTTP transport, JSON responses)
// exposing Gnani speech-to-text and text-to-speech as tools.
const { speechToText, synthesize, makeAudioToken, FORMATS } = require("../lib/gnani");

const SERVER_INFO = { name: "gnani-voice-mcp", version: "1.0.0" };
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LANGS = ["en-IN", "hi-IN", "hi-en", "ta-IN", "te-IN", "kn-IN", "ml-IN", "mr-IN", "pa-IN", "bn-IN", "gu-IN"];

const TOOLS = [
  {
    name: "speech_to_text",
    description:
      "Transcribe a user's voice message with Gnani (Vachana) STT. Give a public URL to the audio file " +
      "(WAV, MP3, OGG/Opus voice note, FLAC, AAC or M4A; max 60 seconds). Returns the transcript text.",
    inputSchema: {
      type: "object",
      properties: {
        audio_url: { type: "string", description: "Public http(s) URL of the audio file to transcribe." },
        language_code: {
          type: "string",
          description: "BCP-47 language of the speech, e.g. en-IN, hi-IN. Default en-IN.",
          enum: LANGS.filter((l) => l !== "hi-en"),
          default: "en-IN",
        },
      },
      required: ["audio_url"],
    },
  },
  {
    name: "text_to_speech",
    description:
      "Convert the agent's reply text to speech with Gnani (Vachana) TTS. Returns a public audio_url " +
      "that can be sent to the user (e.g. as a Telegram/WhatsApp voice note or audio file).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to speak (max 1500 characters)." },
        language: { type: "string", enum: LANGS, default: "en-IN", description: "Language code. hi-en = Hinglish." },
        voice: { type: "string", default: "Nalini", description: "Gnani voice name, e.g. Nalini, Kaveri, Deepak, Poorvi." },
        speed: { type: "number", default: 1.0, minimum: 0.85, maximum: 1.15 },
        format: {
          type: "string",
          enum: Object.keys(FORMATS),
          default: "mp3",
          description: "mp3 (general), wav, or ogg_opus (for Telegram/WhatsApp voice notes).",
        },
      },
      required: ["text"],
    },
  },
];

function baseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

async function callTool(name, args, req) {
  if (name === "speech_to_text") {
    const out = await speechToText(args || {});
    return out;
  }
  if (name === "text_to_speech") {
    const p = {
      text: args?.text,
      voice: args?.voice || "Nalini",
      language: args?.language || "en-IN",
      speed: args?.speed ?? 1.0,
      format: args?.format || "mp3",
    };
    // Real Gnani call now, so errors surface to the agent immediately.
    const { audio, mime, ext } = await synthesize(p);
    const { payload, sig } = makeAudioToken(p);
    return {
      audio_url: `${baseUrl(req)}/api/audio/${payload}/${sig}.${ext}`,
      mime_type: mime,
      bytes: audio.length,
      voice: p.voice,
      language: p.language,
    };
  }
  const err = new Error(`Unknown tool: ${name}`);
  err.code = -32602;
  throw err;
}

async function handleMessage(msg, req) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") {
    return isNotification ? null : fail(-32600, "Invalid Request");
  }
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Gnani voice tools: speech_to_text for incoming voice notes, text_to_speech for spoken replies.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      try {
        const result = await callTool(params?.name, params?.arguments, req);
        return ok({
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (e) {
        if (e.code === -32602) return fail(-32602, e.message);
        // Tool execution errors are returned as results so the agent can react to them.
        return ok({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      return isNotification ? null : fail(-32601, `Method not found: ${method}`);
  }
}

function checkAccess(req) {
  const required = process.env.MCP_ACCESS_KEY;
  if (!required) return true; // open unless an access key is configured
  const auth = req.headers["authorization"] || "";
  const candidates = [
    auth.replace(/^Bearer\s+/i, "").replace(/^Token\s+/i, ""),
    req.headers["x-api-key"],
    req.headers["api-key"],
  ].filter(Boolean);
  return candidates.includes(required);
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body) : Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString("utf8")) : req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  if (req.method === "GET") {
    // No server-initiated SSE stream; a browser visit gets a friendly status page.
    const accept = req.headers.accept || "";
    if (accept.includes("text/event-stream")) { res.statusCode = 405; res.setHeader("Allow", "POST"); return res.end(); }
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ status: "ok", server: SERVER_INFO, tools: TOOLS.map((t) => t.name),
      gnani_key_configured: Boolean(process.env.GNANI_API_KEY) }));
  }
  if (req.method === "DELETE") { res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }

  if (!checkAccess(req)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }));
  }

  let body;
  try { body = await readBody(req); } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
  }

  const batch = Array.isArray(body);
  const msgs = batch ? body : [body];
  const responses = (await Promise.all(msgs.map((m) => handleMessage(m, req)))).filter(Boolean);

  if (responses.length === 0) { res.statusCode = 202; return res.end(); }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(batch ? responses : responses[0]));
};
