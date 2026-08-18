# Cadiilac AI

Notes, cloud drive and a study assistant in one workspace. Static HTML/CSS/vanilla
JavaScript on the front end; Supabase (Auth, Postgres, Storage, Edge Functions) on
the back end, with OpenRouter for AI and ElevenLabs for voice.

```
public/                 front end (no build step, ES modules)
  index.html            landing page
  auth.html             sign in / create account
  app.html              workspace shell (#/notes, #/ai, #/drive, #/settings)
  share.html            public share-link viewer
  assets/js/backend/    swappable backends: supabase.js and local.js (demo)
supabase/migrations/    schema, quota functions, RLS policies, storage bucket
supabase/functions/     Edge Functions holding every provider secret
scripts/serve.js        dependency-free static server
```

## Run it

```bash
npm run dev      # http://localhost:4173
npm run lint     # parses every browser module
```

With no credentials configured the app boots in **demo mode**: accounts, notes,
files, sharing, credits and quotas run entirely in the browser (localStorage plus
IndexedDB for file bytes), AI replies are generated locally, and speech uses the
browser voice engine. Everything is explorable without a Supabase project.

## Connect a real backend

1. Create a Supabase project.
2. Run `supabase/migrations/0001_schema.sql` then `0002_policies.sql` in the SQL
   editor (or `supabase db push`). This creates the tables, the `drive` storage
   bucket, the quota functions and every RLS policy.
3. Copy `public/config.local.example.js` to `public/config.local.js`, fill in the
   project URL and anon key, and add `<script src="/config.local.js"></script>`
   before the module script in `index.html`, `auth.html`, `app.html` and
   `share.html`. Demo mode switches off automatically.
4. Copy `.env.example` to `.env`, fill in the provider keys, then:

   ```bash
   supabase secrets set --env-file .env
   supabase functions deploy ai-chat tts cadiilac-api create-share-link
   ```

Users are never asked for a Supabase, OpenRouter or ElevenLabs key — the platform
owner supplies them once, server side.

## Security model

- Supabase Auth issues sessions; every table has RLS restricted to `auth.uid()`.
- The anon key is the only credential in the browser. The service role key,
  OpenRouter key and ElevenLabs key exist only in Edge Function secrets.
- Paid behaviour is never trusted to the client:
  - weekly note limits are enforced by the `create_note` SQL function,
  - storage limits by a `before insert` trigger on `files`,
  - AI credits by `spendCredits` in the Edge Functions,
  - plan, credit and subscription columns are frozen for non-service-role
    updates by the `protect_billing_columns` trigger.
- Edge Functions rate limit per user and per route via the `rate_limits` table.
- Drive files are private; downloads use short-lived signed URLs, and public
  share links resolve server side, honouring the view-only flag.
- API keys are stored as salted SHA-256 hashes and shown once at creation.

## Plans

|                     | Free           | Cadiilac Cloud       |
| ------------------- | -------------- | -------------------- |
| Drive storage       | 5 GB           | 20 GB                |
| Saved notes         | 15 per week    | Unlimited            |
| AI credits          | 75 / 24 hours  | 250 / 12 hours       |
| Credit ceiling      | 75             | 500                  |
| Backups and history | —              | Included             |
| Personality control | —              | Included             |
| Cadiilac API        | —              | Included             |

Limits live in `public/assets/js/config.js`, `supabase/functions/_shared/mod.ts`
and `public.plan_limits()` — change all three together.

## Cadiilac API

Cloud subscribers generate keys in Settings → API and call the platform directly;
Cadiilac pays for the underlying models and bills the request to the caller's
credit balance.

```bash
curl https://YOUR-PROJECT.functions.supabase.co/cadiilac-api \
  -H "Authorization: Bearer cad_live_..." \
  -H "Content-Type: application/json" \
  -d '{"action":"chat","messages":[{"role":"user","content":"Summarise photosynthesis"}]}'
```

Actions: `chat`, `tool` (`summarize`, `rewrite`, `flashcards`, `quiz`, …),
`speak`, `credits`.
