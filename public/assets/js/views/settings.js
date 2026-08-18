/* Settings: account, appearance, AI personality, storage, subscription, API. */

import { el, toast, formatBytes, formatDate, formatCountdown, modal, confirmDialog, copyToClipboard, ICONS } from "../util.js";
import { api, isDemo } from "../api.js";
import { state, applyAppearance, refreshMeters, reloadProfile } from "../app.js";
import { PLANS } from "../config.js";

const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "appearance", label: "Appearance" },
  { id: "ai", label: "AI" },
  { id: "storage", label: "Storage" },
  { id: "subscription", label: "Subscription" },
  { id: "api", label: "API" },
];

export async function render({ view, params }) {
  let section = SECTIONS.some((item) => item.id === params.section) ? params.section : "account";

  const nav = el("div", { class: "settings-nav" });
  const panel = el("div", { class: "panel" });
  view.append(el("div", { class: "settings" }, [nav, panel]));

  function paintNav() {
    nav.innerHTML = "";
    for (const item of SECTIONS) {
      nav.append(
        el("button", {
          class: item.id === section ? "is-active" : "",
          text: item.label,
          onclick: () => {
            section = item.id;
            paintNav();
            paint();
          },
        })
      );
    }
  }

  const block = (title, children, description) =>
    el("div", { class: "panel-block" }, [
      el("h3", { text: title }),
      description ? el("p", { class: "muted", style: "font-size:13.5px;margin-top:-6px", text: description }) : null,
      ...[].concat(children),
    ]);

  const field = (label, node, hint) =>
    el("label", { class: "field" }, [
      el("span", { class: "field-label", text: label }),
      node,
      hint ? el("span", { class: "field-hint", text: hint }) : null,
    ]);

  const segmented = (options, value, onChange) => {
    const wrap = el("div", { class: "segmented" });
    for (const option of options) {
      wrap.append(
        el("button", {
          class: option.value === value ? "is-active" : "",
          text: option.label,
          onclick: () => {
            wrap.querySelectorAll("button").forEach((node) => node.classList.remove("is-active"));
            wrap.querySelectorAll("button").forEach((node) => {
              if (node.textContent === option.label) node.classList.add("is-active");
            });
            onChange(option.value);
          },
        })
      );
    }
    return wrap;
  };

  const select = (options, value, onChange) => {
    const node = el("select", { class: "select" });
    for (const option of options) {
      node.append(el("option", { value: option.value, text: option.label, ...(option.value === value ? { selected: true } : {}) }));
    }
    node.onchange = () => onChange(node.value);
    return node;
  };

  async function saveSettings(patch) {
    const profile = await api.updateSettings(patch);
    state.profile = profile;
    applyAppearance(profile.settings);
    return profile;
  }

  /* -------------------------------------------------------------- sections */

  function accountSection() {
    const nameInput = el("input", { class: "input", value: state.profile?.name || "" });
    const emailInput = el("input", { class: "input", value: state.profile?.email || state.user?.email || "", disabled: true });

    return [
      el("h2", { text: "Account" }),
      block("Profile", [
        el("div", { class: "row" }, [field("Name", nameInput), field("Email", emailInput, "Contact support to change your sign-in email.")]),
        el("div", { class: "row" }, [
          el("button", {
            class: "btn btn-sm btn-primary",
            text: "Save profile",
            onclick: async () => {
              await api.updateProfile({ name: nameInput.value.trim() });
              await reloadProfile();
              toast("Profile updated.");
            },
          }),
        ]),
      ]),
      block(
        "Security",
        [
          el("div", { class: "kv" }, [el("span", { text: "Password" }), el("span", { class: "faint", text: isDemo ? "Managed locally in demo mode" : "Managed by Supabase Auth" })]),
          el("div", { class: "kv" }, [el("span", { text: "Member since" }), el("span", { class: "faint", text: formatDate(state.profile?.created_at) })]),
          el("div", { class: "row" }, [
            el("button", {
              class: "btn btn-sm",
              text: "Send password reset email",
              onclick: async () => {
                if (isDemo) return toast("Password resets require a configured Supabase project.", "error");
                await api.client.auth.resetPasswordForEmail(state.profile.email, { redirectTo: `${location.origin}/auth.html` });
                toast("Reset email sent.");
              },
            }),
            el("button", {
              class: "btn btn-sm btn-danger",
              text: "Sign out everywhere",
              onclick: async () => {
                if (!(await confirmDialog("Sign out?", "You will need to sign in again on this device."))) return;
                await api.signOut();
                location.href = "/";
              },
            }),
          ]),
        ],
        "Authentication is handled by Supabase Auth with row-level security on every table."
      ),
    ];
  }

  function appearanceSection() {
    const settings = state.profile?.settings || {};
    return [
      el("h2", { text: "Appearance" }),
      block("Theme", [
        segmented(
          [
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            { value: "system", label: "System" },
          ],
          settings.theme || "system",
          (value) => saveSettings({ theme: value })
        ),
      ]),
      block("Interface density", [
        segmented(
          [
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ],
          settings.density || "comfortable",
          (value) => saveSettings({ density: value })
        ),
      ]),
      block("Animations", [
        segmented(
          [
            { value: "on", label: "On" },
            { value: "off", label: "Reduced" },
          ],
          settings.animations || "on",
          (value) => saveSettings({ animations: value })
        ),
      ]),
    ];
  }

  function aiSection() {
    const ai = state.profile?.settings?.ai || {};
    const locked = !state.plan.features.personality;

    const personality = el("input", { class: "input", value: ai.personality || "", placeholder: "Focused study partner", disabled: locked });
    const instructions = el("textarea", { class: "textarea", placeholder: "Always answer with examples from chemistry.", disabled: locked }, [ai.custom_instructions || ""]);
    const creativity = el("input", { class: "input", type: "range", min: "0", max: "1", step: "0.1", value: String(ai.creativity ?? 0.6), disabled: locked });
    const voice = select(
      [
        { value: "rachel", label: "Rachel — warm, clear" },
        { value: "adam", label: "Adam — steady, low" },
        { value: "bella", label: "Bella — bright" },
        { value: "antoni", label: "Antoni — measured" },
      ],
      ai.voice_id || "rachel",
      (value) => saveSettings({ ai: { voice_id: value } })
    );
    const speed = el("input", { class: "input", type: "range", min: "0.7", max: "1.3", step: "0.05", value: String(ai.voice_speed ?? 1) });

    return [
      el("h2", { text: "AI" }),
      locked
        ? block("Cadiilac Cloud feature", [
            el("p", { class: "muted", style: "font-size:14px", text: "Personality customisation is part of Cadiilac Cloud. Your assistant still answers with the balanced default profile." }),
            el("button", { class: "btn btn-sm btn-primary", text: "See Cadiilac Cloud", onclick: () => {
              section = "subscription";
              paintNav();
              paint();
            } }),
          ])
        : null,
      block("Personality", [
        field("Persona", personality),
        el("div", { class: "row" }, [
          field("Formality", select([
            { value: "casual", label: "Casual" },
            { value: "balanced", label: "Balanced" },
            { value: "formal", label: "Formal" },
          ], ai.formality || "balanced", (value) => saveSettings({ ai: { formality: value } }))),
          field("Response length", select([
            { value: "brief", label: "Brief" },
            { value: "balanced", label: "Balanced" },
            { value: "thorough", label: "Thorough" },
          ], ai.length || "balanced", (value) => saveSettings({ ai: { length: value } }))),
        ]),
        el("div", { class: "row" }, [
          field("Tone", select([
            { value: "warm", label: "Warm" },
            { value: "neutral", label: "Neutral" },
            { value: "direct", label: "Direct" },
          ], ai.tone || "warm", (value) => saveSettings({ ai: { tone: value } }))),
          field("Encouragement", select([
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ], ai.encouragement || "medium", (value) => saveSettings({ ai: { encouragement: value } }))),
          field("Teaching style", select([
            { value: "socratic", label: "Socratic" },
            { value: "direct", label: "Direct explanation" },
            { value: "examples", label: "Example-led" },
          ], ai.teaching_style || "socratic", (value) => saveSettings({ ai: { teaching_style: value } }))),
        ]),
        field("Creativity", creativity, "Lower is more literal, higher is more exploratory."),
        field("Custom instructions", instructions),
        el("div", { class: "row" }, [
          el("button", {
            class: "btn btn-sm btn-primary",
            "aria-disabled": locked ? "true" : null,
            text: "Save AI preferences",
            onclick: async () => {
              await saveSettings({
                ai: {
                  personality: personality.value,
                  custom_instructions: instructions.value,
                  creativity: Number(creativity.value),
                },
              });
              toast("AI preferences saved.");
            },
          }),
        ]),
      ]),
      block("Voice", [
        field("Voice", voice, "Voices are generated with the platform's ElevenLabs account — you never supply a key."),
        field("Speaking rate", speed),
        el("div", { class: "row" }, [
          el("button", {
            class: "btn btn-sm",
            text: "Save voice settings",
            onclick: async () => {
              await saveSettings({ ai: { voice_speed: Number(speed.value) } });
              toast("Voice settings saved.");
            },
          }),
        ]),
      ]),
    ];
  }

  async function storageSection() {
    const storage = state.storage || (await api.storageUsage());
    const files = await api.listFiles(null);
    const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
    const ratio = Math.min(100, (storage.used / storage.limit) * 100);

    return [
      el("h2", { text: "Storage" }),
      block("Usage", [
        el("div", { class: "meter-row" }, [
          el("span", { text: `${formatBytes(storage.used)} of ${formatBytes(storage.limit)} used` }),
          el("span", { class: "faint", text: `${ratio.toFixed(1)}%` }),
        ]),
        el("div", { class: "meter-bar" }, [el("span", { style: `width:${Math.max(2, ratio)}%` })]),
      ]),
      block(
        "Largest files at the root of your Drive",
        largest.length
          ? largest.map((file) => el("div", { class: "kv" }, [el("span", { text: file.name }), el("span", { class: "faint", text: formatBytes(file.size) })]))
          : [el("p", { class: "muted", style: "font-size:14px", text: "No files uploaded yet." })]
      ),
      state.plan.features.backups
        ? block("Cloud backups", [
            el("p", { class: "muted", style: "font-size:14px", text: "Your notes are snapshotted automatically. Create a manual backup at any time." }),
            el("div", { class: "row" }, [
              el("button", {
                class: "btn btn-sm",
                text: "Back up notes now",
                onclick: async () => {
                  await api.createBackup();
                  toast("Backup created.");
                  paint();
                },
              }),
            ]),
            ...(await api.listBackups()).map((backup) =>
              el("div", { class: "kv" }, [el("span", { text: formatDate(backup.created_at) }), el("span", { class: "faint", text: `${backup.notes} notes` })])
            ),
          ])
        : block("Cloud backups", [el("p", { class: "muted", style: "font-size:14px", text: "Automatic backups and version history are included with Cadiilac Cloud." })]),
    ];
  }

  function subscriptionSection() {
    const credits = state.credits;
    const quota = state.noteQuota;
    const isCloud = state.plan.id === "cloud";

    const planCard = (plan, current) =>
      el("div", { class: `panel-block${current ? "" : ""}` }, [
        el("div", { class: "row" }, [
          el("h3", { text: plan.label }),
          current ? el("span", { class: "badge badge-accent", text: "Current plan" }) : null,
        ]),
        el("ul", { style: "display:grid;gap:8px;font-size:14px;color:var(--text-muted)" }, [
          el("li", { text: `${formatBytes(plan.storageBytes)} Drive storage` }),
          el("li", { text: plan.notesPerWeek === Infinity ? "Unlimited saved notes" : `${plan.notesPerWeek} saved notes per week` }),
          el("li", { text: `${plan.creditAllowance} AI credits every ${plan.creditWindowHours} hours` }),
          el("li", { text: plan.features.backups ? "Cloud backups and version history" : "Manual export only" }),
          el("li", { text: plan.features.api ? "Cadiilac API access" : "No API access" }),
        ]),
        current
          ? el("button", { class: "btn btn-sm", "aria-disabled": "true", text: "Active" })
          : el("button", {
              class: "btn btn-sm btn-primary",
              text: plan.id === "cloud" ? "Upgrade to Cadiilac Cloud" : "Switch to Free",
              onclick: async () => {
                if (!isDemo) {
                  const proceed = await confirmDialog(
                    "Change plan",
                    "Billing is handled by the checkout webhook in production. Continue with the development plan switch?",
                    "Continue"
                  );
                  if (!proceed) return;
                }
                await api.setPlan(plan.id);
                await reloadProfile();
                toast(`Now on ${plan.label}.`);
                paint();
              },
            }),
      ]);

    return [
      el("h2", { text: "Subscription" }),
      block("Current usage", [
        el("div", { class: "kv" }, [el("span", { text: "Plan" }), el("span", { text: state.plan.label })]),
        el("div", { class: "kv" }, [
          el("span", { text: "AI credits" }),
          el("span", { text: credits ? `${credits.balance} of ${credits.max} · +${credits.allowance} in ${formatCountdown(credits.resetsAt)}` : "—" }),
        ]),
        el("div", { class: "kv" }, [el("span", { text: "Credits used all time" }), el("span", { text: String(credits?.usedTotal ?? 0) })]),
        el("div", { class: "kv" }, [
          el("span", { text: "Notes this week" }),
          el("span", { text: quota ? (quota.limit === Infinity ? `${quota.used} · unlimited` : `${quota.used} / ${quota.limit}`) : "—" }),
        ]),
        el("div", { class: "kv" }, [
          el("span", { text: "Storage" }),
          el("span", { text: state.storage ? `${formatBytes(state.storage.used)} / ${formatBytes(state.storage.limit)}` : "—" }),
        ]),
      ]),
      el("div", { class: "row", style: "align-items:stretch;gap:16px" }, [
        el("div", { style: "flex:1 1 300px" }, [planCard(PLANS.free, !isCloud)]),
        el("div", { style: "flex:1 1 300px" }, [planCard(PLANS.cloud, isCloud)]),
      ]),
      block("Billing", [
        el("p", { class: "muted", style: "font-size:14px", text: isDemo ? "Demo mode: plan changes are applied instantly without payment." : "Invoices and payment methods are managed by the billing provider configured by the platform owner." }),
      ]),
    ];
  }

  async function apiSection() {
    const locked = !state.plan.features.api;
    const keys = locked ? [] : await api.listApiKeys();
    const usage = await api.listUsage();

    const sample = `curl https://YOUR-PROJECT.functions.supabase.co/cadiilac-api \\
  -H "Authorization: Bearer cad_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "action": "chat",
    "messages": [{ "role": "user", "content": "Summarise photosynthesis" }]
  }'`;

    return [
      el("h2", { text: "API" }),
      locked
        ? block("Cadiilac API", [
            el("p", { class: "muted", style: "font-size:14px", text: "API access is included with Cadiilac Cloud. Cadiilac provides the AI infrastructure — your application calls Cadiilac, and Cadiilac pays for the underlying models." }),
            el("button", { class: "btn btn-sm btn-primary", text: "See Cadiilac Cloud", onclick: () => {
              section = "subscription";
              paintNav();
              paint();
            } }),
          ])
        : block("API keys", [
            el("p", { class: "muted", style: "font-size:14px", text: "Keys are shown once at creation and stored as hashes. Requests draw from your Cadiilac credit balance." }),
            ...(keys.length
              ? keys.map((key) =>
                  el("div", { class: "kv" }, [
                    el("span", {}, [
                      el("strong", { style: "font-weight:540", text: key.name }),
                      el("span", { class: "mono faint", style: "margin-left:10px", text: `${key.prefix}…` }),
                      key.revoked ? el("span", { class: "badge", style: "margin-left:10px", text: "Revoked" }) : null,
                    ]),
                    el("span", { class: "row" }, [
                      el("span", { class: "faint", text: `${key.requests || 0} requests · ${key.last_used_at ? formatDate(key.last_used_at) : "never used"}` }),
                      key.revoked
                        ? null
                        : el("button", {
                            class: "btn btn-sm btn-danger",
                            text: "Revoke",
                            onclick: async () => {
                              if (!(await confirmDialog("Revoke key?", "Applications using this key will stop working immediately.", "Revoke"))) return;
                              await api.revokeApiKey(key.id);
                              toast("Key revoked.");
                              paint();
                            },
                          }),
                    ]),
                  ])
                )
              : [el("p", { class: "muted", style: "font-size:14px", text: "No keys yet." })]),
            el("div", { class: "row" }, [
              el("button", {
                class: "btn btn-sm btn-primary",
                html: `${ICONS.plus}<span>Generate key</span>`,
                onclick: async () => {
                  const name = await modal({
                    title: "Generate API key",
                    render: (body) => {
                      const input = el("input", { class: "input", placeholder: "Revision app" });
                      body.append(el("label", { class: "field" }, [el("span", { class: "field-label", text: "Key name" }), input]));
                      return { value: () => input.value.trim() };
                    },
                    actions: [
                      { label: "Cancel", value: null },
                      { label: "Generate", variant: "primary", validate: Boolean },
                    ],
                  });
                  if (!name) return;
                  const { secret } = await api.createApiKey(name);
                  await modal({
                    title: "Copy your API key",
                    description: "This is the only time the full key is shown.",
                    render: (body) => {
                      body.append(el("div", { class: "code-block", text: secret }));
                      body.append(
                        el("button", {
                          class: "btn btn-sm",
                          text: "Copy key",
                          onclick: async () => {
                            await copyToClipboard(secret);
                            toast("API key copied.");
                          },
                        })
                      );
                      return {};
                    },
                    actions: [{ label: "Done", variant: "primary", value: true }],
                  });
                  paint();
                },
              }),
            ]),
          ]),
      block("Documentation", [
        el("p", { class: "muted", style: "font-size:14px", text: "Send requests to the Cadiilac API with your key. Supported actions: chat, tool, speak, credits." }),
        el("div", { class: "code-block", text: sample }),
      ]),
      block(
        "Recent AI usage",
        usage.length
          ? usage.slice(0, 12).map((entry) =>
              el("div", { class: "kv" }, [el("span", { text: entry.kind }), el("span", { class: "faint", text: `${entry.cost} credit${entry.cost === 1 ? "" : "s"} · ${formatDate(entry.created_at)}` })])
            )
          : [el("p", { class: "muted", style: "font-size:14px", text: "No AI usage recorded yet." })]
      ),
    ];
  }

  async function paint() {
    await refreshMeters();
    panel.innerHTML = "";
    const builders = {
      account: accountSection,
      appearance: appearanceSection,
      ai: aiSection,
      storage: storageSection,
      subscription: subscriptionSection,
      api: apiSection,
    };
    const nodes = await builders[section]();
    nodes.filter(Boolean).forEach((node) => panel.append(node));
  }

  paintNav();
  await paint();
  return {};
}
