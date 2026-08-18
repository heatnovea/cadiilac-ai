/**
 * Cadiilac AI — speech synthesis via ElevenLabs.
 *
 * The ElevenLabs key belongs to the platform and stays server side. Audio is
 * returned as base64 so the browser can play it without a signed provider URL.
 * When no key is configured the client falls back to browser speech.
 */

import {
  admin,
  authenticate,
  handleError,
  HttpError,
  json,
  preflight,
  rateLimit,
  readJson,
  spendCredits,
} from "../_shared/mod.ts";

const VOICES: Record<string, string> = {
  rachel: "21m00Tcm4TlvDq8ikWAM",
  adam: "pNInz6obpgDQGcFmaJgB",
  bella: "EXAVITQu4vr4xnSDxMaL",
  antoni: "ErXwobaYiN019PkySvjV",
};

const MODEL = Deno.env.get("ELEVENLABS_MODEL") ?? "eleven_turbo_v2_5";
const MAX_CHARACTERS = 1500;

function base64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;

  try {
    const db = admin();
    const caller = await authenticate(request, db);
    await rateLimit(db, caller.userId, "tts", 20, 60);

    const body = await readJson<{ text?: string; voice?: string }>(request);
    const text = (body.text ?? "").trim().slice(0, MAX_CHARACTERS);
    if (!text) throw new HttpError(400, "Nothing to read aloud.");

    const key = Deno.env.get("ELEVENLABS_API_KEY");
    if (!key) {
      // Not an error: the client speaks with the browser engine instead.
      return json({ audio: null, mime: null, fallback: "browser", credits: null });
    }

    const credits = await spendCredits(db, caller, 2, "tts", MODEL);
    const voiceId = VOICES[body.voice ?? "rachel"] ?? VOICES.rachel;

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
      }),
    });

    if (!response.ok) {
      console.error("elevenlabs", response.status, await response.text());
      throw new HttpError(502, "Voice generation failed.", "provider_error");
    }

    return json({ audio: base64(await response.arrayBuffer()), mime: "audio/mpeg", credits });
  } catch (error) {
    return handleError(error);
  }
});
