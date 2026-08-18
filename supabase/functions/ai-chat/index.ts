/**
 * Cadiilac AI — chat and document tools.
 *
 * Routes requests to OpenRouter using the platform's own key, after checking
 * the caller's session, rate limit and credit balance. The browser never sees
 * the provider key or the raw provider response envelope.
 */

import {
  admin,
  authenticate,
  handleError,
  HttpError,
  json,
  planOf,
  preflight,
  rateLimit,
  readJson,
  spendCredits,
  type Caller,
} from "../_shared/mod.ts";

const MODEL = Deno.env.get("OPENROUTER_MODEL") ?? "openai/gpt-4o-mini";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const IDENTITY = `You are Cadiilac AI, the assistant inside the Cadiilac productivity and learning workspace.
You help people study, understand difficult material, write and organise notes, plan work and manage documents.
Be accurate, concrete and useful. Prefer structured answers with short paragraphs, lists and worked examples.
If you are unsure, say so plainly. Decline requests unrelated to productivity, learning or the user's documents,
and offer a study-oriented alternative instead.`;

const TOOL_PROMPTS: Record<string, string> = {
  rewrite: "Rewrite the text so it reads clearly and naturally. Preserve meaning, length and voice. Return only the rewritten text.",
  summarize: "Summarise the text into its essential points. Return a short paragraph followed by up to five bullets.",
  explain: "Explain the text as a patient tutor would: what it means, why it matters, and a concrete example.",
  simplify: "Rewrite the text in plain language a motivated beginner can follow. Keep every fact intact.",
  expand: "Expand the text with additional depth, detail and examples while keeping the original argument.",
  grammar: "Correct grammar, spelling and punctuation. Change nothing else. Return only the corrected text.",
  concise: "Tighten the text to the fewest words that keep the full meaning. Return only the revised text.",
  continue: "Continue writing from where the text stops, matching its voice and structure. Return only the continuation.",
  tone: "Rewrite the text in the requested tone. Return only the rewritten text.",
  "study-notes": "Turn the text into structured study notes: headings, bullet points, and a short 'remember this' list.",
  questions: "Write insightful comprehension and reflection questions about the text. Number them.",
  flashcards:
    'Create flashcards from the text. Return strict JSON only: {"cards":[{"front":"...","back":"..."}]} with 6-12 cards.',
  quiz:
    'Create a multiple choice quiz from the text. Return strict JSON only: {"questions":[{"question":"...","options":["..","..","..",".."],"answer":0,"explanation":"..."}]} with 4-8 questions.',
  "key-concepts":
    'Extract the key concepts. Return strict JSON only: {"concepts":[{"term":"...","note":"..."}]} with 4-10 entries.',
  summary: "Summarise the text for revision: one paragraph overview then the five most important takeaways.",
};

const JSON_TOOLS = new Set(["flashcards", "quiz", "key-concepts"]);
const COST: Record<string, number> = { chat: 1, tool: 1, flashcards: 2, quiz: 2, "key-concepts": 2 };

interface Preferences {
  personality?: string;
  custom_instructions?: string;
  formality?: string;
  tone?: string;
  length?: string;
  encouragement?: string;
  teaching_style?: string;
  creativity?: number;
}

function personaPrompt(caller: Caller): { prompt: string; temperature: number } {
  const plan = planOf(caller.profile.plan);
  const settings = (caller.profile.settings ?? {}) as { ai?: Preferences };
  const ai = plan.features.personality ? settings.ai ?? {} : {};

  const traits = [
    ai.personality ? `Adopt this persona: ${ai.personality}.` : null,
    ai.formality ? `Formality: ${ai.formality}.` : null,
    ai.tone ? `Tone: ${ai.tone}.` : null,
    ai.length ? `Response length: ${ai.length}.` : null,
    ai.encouragement ? `Encouragement level: ${ai.encouragement}.` : null,
    ai.teaching_style ? `Teaching style: ${ai.teaching_style}.` : null,
    ai.custom_instructions ? `User instructions: ${ai.custom_instructions}` : null,
  ].filter(Boolean);

  return {
    prompt: [IDENTITY, ...traits].join("\n"),
    temperature: Math.min(1, Math.max(0, ai.creativity ?? 0.6)),
  };
}

async function callOpenRouter(messages: unknown[], temperature: number, jsonMode: boolean) {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new HttpError(503, "The AI provider is not configured yet.", "provider_unconfigured");

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": Deno.env.get("PUBLIC_SITE_URL") ?? "https://cadiilac.ai",
      "X-Title": "Cadiilac AI",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature,
      max_tokens: 1400,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("openrouter", response.status, detail);
    throw new HttpError(502, "The AI provider could not complete this request.", "provider_error");
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new HttpError(502, "The AI provider returned an empty response.");
  return { content: content.trim(), usage: payload?.usage };
}

Deno.serve(async (request) => {
  const early = preflight(request);
  if (early) return early;

  try {
    const db = admin();
    const caller = await authenticate(request, db);
    await rateLimit(db, caller.userId, "ai-chat", 40, 60);

    const body = await readJson<{
      action?: string;
      messages?: { role: string; content: string }[];
      context?: string | null;
      tool?: string;
      text?: string;
      tone?: string;
      title?: string;
    }>(request);

    const { prompt, temperature } = personaPrompt(caller);
    const action = body.action ?? "chat";

    if (action === "tool") {
      const tool = body.tool ?? "";
      const instruction = TOOL_PROMPTS[tool];
      if (!instruction) throw new HttpError(400, `Unknown tool “${tool}”.`);
      const text = (body.text ?? "").slice(0, 12000);
      if (!text.trim()) throw new HttpError(400, "Select some text first.");

      const credits = await spendCredits(db, caller, COST[tool] ?? COST.tool, `tool:${tool}`, MODEL);
      const result = await callOpenRouter(
        [
          { role: "system", content: `${prompt}\n\n${instruction}` },
          {
            role: "user",
            content: [
              body.title ? `Document: ${body.title}` : null,
              body.tone ? `Requested tone: ${body.tone}` : null,
              body.context ? `Surrounding context:\n${body.context.slice(0, 6000)}` : null,
              `Text:\n${text}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        temperature,
        JSON_TOOLS.has(tool)
      );
      return json({ content: result.content, credits, model: MODEL });
    }

    const messages = (body.messages ?? []).slice(-16).filter((message) => typeof message?.content === "string");
    if (!messages.length) throw new HttpError(400, "No messages supplied.");

    const credits = await spendCredits(db, caller, COST.chat, "chat", MODEL);
    const result = await callOpenRouter(
      [
        { role: "system", content: prompt },
        ...(body.context
          ? [{ role: "system", content: `The user is working on this document:\n${String(body.context).slice(0, 8000)}` }]
          : []),
        ...messages.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: String(message.content).slice(0, 8000),
        })),
      ],
      temperature,
      false
    );

    return json({ content: result.content, credits, model: MODEL });
  } catch (error) {
    return handleError(error);
  }
});
