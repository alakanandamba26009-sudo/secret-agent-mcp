// GET /api/audio/<payload>/<sig>.<ext>  -> streams Gnani TTS audio for a signed link.
const { synthesize, readAudioToken } = require("../lib/gnani");

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const q = url.searchParams;
    let payload = q.get("p");
    let sig = q.get("s");
    // Support path form: /api/audio/<payload>/<sig>.<ext>
    const m = url.pathname.match(/\/audio\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\.\w+)?$/);
    if (m) { payload = m[1]; sig = m[2]; }
    if (!payload || !sig) { res.statusCode = 400; return res.end("Missing audio link parameters."); }

    const params = readAudioToken(payload, sig);
    const { audio, mime } = await synthesize(params);
    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", audio.length);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.end(audio);
  } catch (e) {
    res.statusCode = /signature/i.test(e.message) ? 403 : 502;
    res.setHeader("Content-Type", "text/plain");
    res.end(e.message);
  }
};
