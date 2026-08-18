/* Focused study session: timer, AI-generated flashcards, quizzes and concepts. */

import { el, toast, formatClock, ICONS } from "../util.js";
import { api } from "../api.js";
import { refreshMeters } from "../app.js";
import { htmlToText } from "../export.js";

const TABS = [
  { id: "flashcards", label: "Flashcards" },
  { id: "quiz", label: "Quiz" },
  { id: "key-concepts", label: "Key concepts" },
  { id: "summarize", label: "Summary" },
  { id: "questions", label: "Review prompts" },
];

export function openStudySession(note) {
  const text = htmlToText(note.content || "").slice(0, 6000);
  if (text.length < 40) {
    toast("Add a little more to this note before starting a study session.", "error");
    return;
  }

  const startedAt = Date.now();
  let duration = 25 * 60;
  let remaining = duration;
  let running = true;
  let cache = {};
  let tab = "flashcards";
  let cardIndex = 0;
  let showBack = false;
  let quizAnswers = {};
  let stats = { cardsReviewed: 0, quizCorrect: 0, quizAnswered: 0 };

  const overlay = el("div", { class: "study" });
  const timerNode = el("div", { class: "study-timer", text: formatClock(remaining) });
  const statsNode = el("div", { class: "faint", style: "font-size:12.5px" });
  const body = el("div", { class: "study-body" });
  const inner = el("div", { class: "study-inner" });
  body.append(inner);

  const pauseButton = el("button", { class: "btn btn-sm", text: "Pause" });
  const durationSelect = el("select", { class: "select", style: "width:auto;height:31px;font-size:13px" });
  for (const minutes of [10, 15, 25, 45, 60]) {
    durationSelect.append(el("option", { value: String(minutes), text: `${minutes} min`, ...(minutes === 25 ? { selected: true } : {}) }));
  }

  const bar = el("div", { class: "study-bar" }, [
    el("span", { class: "badge badge-accent", text: "Focus session" }),
    timerNode,
    durationSelect,
    pauseButton,
    el("div", { style: "margin-left:auto;display:flex;align-items:center;gap:12px" }, [
      statsNode,
      el("button", { class: "btn btn-sm", html: `${ICONS.close}<span>End session</span>`, onclick: () => end() }),
    ]),
  ]);

  overlay.append(bar, body);
  document.body.append(overlay);

  const tick = setInterval(() => {
    if (!running) return;
    remaining -= 1;
    timerNode.textContent = formatClock(remaining);
    if (remaining <= 0) {
      running = false;
      toast("Focus session complete — nice work.");
      timerNode.textContent = "00:00";
    }
  }, 1000);

  pauseButton.onclick = () => {
    running = !running;
    pauseButton.textContent = running ? "Pause" : "Resume";
  };

  durationSelect.onchange = () => {
    duration = Number(durationSelect.value) * 60;
    remaining = duration;
    timerNode.textContent = formatClock(remaining);
  };

  const updateStats = () => {
    const minutes = Math.round((Date.now() - startedAt) / 60000);
    statsNode.textContent = `${minutes}m studied · ${stats.cardsReviewed} cards · ${stats.quizCorrect}/${stats.quizAnswered} correct`;
  };
  updateStats();

  async function end() {
    clearInterval(tick);
    overlay.remove();
    const minutes = Math.round((Date.now() - startedAt) / 60000);
    try {
      await api.recordStudySession({
        note_id: note.id,
        minutes,
        cards_reviewed: stats.cardsReviewed,
        quiz_correct: stats.quizCorrect,
        quiz_total: stats.quizAnswered,
      });
    } catch (error) {
      console.warn("study session not recorded", error);
    }
    toast(`Session saved — ${minutes} minute${minutes === 1 ? "" : "s"} of focused study.`);
  }

  async function load(tool) {
    if (cache[tool]) return cache[tool];
    const result = await api.tool({ tool, text, title: note.title });
    await refreshMeters();
    cache[tool] = result.content;
    return result.content;
  }

  function parseJson(raw, fallback) {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : fallback;
    } catch {
      return fallback;
    }
  }

  async function renderTab() {
    inner.innerHTML = "";
    const tabs = el("div", { class: "study-tabs" });
    for (const item of TABS) {
      tabs.append(
        el("button", {
          class: `btn btn-sm${item.id === tab ? " btn-primary" : ""}`,
          text: item.label,
          onclick: () => {
            tab = item.id;
            cardIndex = 0;
            showBack = false;
            renderTab();
          },
        })
      );
    }
    inner.append(
      el("div", {}, [
        el("h2", { style: "font-size:20px;letter-spacing:-.02em", text: note.title || "Untitled note" }),
        el("p", { class: "muted", style: "font-size:13.5px;margin-top:6px", text: "Distraction-free study, generated from this document." }),
      ]),
      tabs
    );

    const slot = el("div", { style: "min-height:220px;display:grid;gap:12px" }, [
      el("div", { class: "row", style: "gap:9px" }, [el("span", { class: "spinner" }), el("span", { class: "muted", text: "Cadiilac AI is preparing your material…" })]),
    ]);
    inner.append(slot);

    let content;
    try {
      content = await load(tab);
    } catch (error) {
      slot.innerHTML = "";
      slot.append(el("p", { class: "muted", text: error.message }));
      return;
    }
    slot.innerHTML = "";

    if (tab === "flashcards") {
      const cards = parseJson(content, { cards: [] }).cards || [];
      if (!cards.length) return slot.append(el("p", { class: "muted", text: content }));
      const card = cards[cardIndex % cards.length];
      const face = el("div", {
        class: "flashcard",
        text: showBack ? card.back : card.front,
        onclick: () => {
          showBack = !showBack;
          if (showBack) {
            stats.cardsReviewed += 1;
            updateStats();
          }
          renderTab();
        },
      });
      slot.append(
        face,
        el("div", { class: "row" }, [
          el("span", { class: "faint", text: `Card ${(cardIndex % cards.length) + 1} of ${cards.length} · tap to flip` }),
          el("div", { style: "margin-left:auto;display:flex;gap:8px" }, [
            el("button", {
              class: "btn btn-sm",
              text: "Previous",
              onclick: () => {
                cardIndex = (cardIndex - 1 + cards.length) % cards.length;
                showBack = false;
                renderTab();
              },
            }),
            el("button", {
              class: "btn btn-sm btn-primary",
              text: "Next",
              onclick: () => {
                cardIndex = (cardIndex + 1) % cards.length;
                showBack = false;
                renderTab();
              },
            }),
          ]),
        ])
      );
      return;
    }

    if (tab === "quiz") {
      const questions = parseJson(content, { questions: [] }).questions || [];
      if (!questions.length) return slot.append(el("p", { class: "muted", text: content }));
      questions.forEach((question, index) => {
        const block = el("div", { class: "panel-block" }, [el("h3", { text: `${index + 1}. ${question.question}` })]);
        question.options.forEach((option, optionIndex) => {
          const button = el("button", { class: "quiz-option", text: option });
          const answered = quizAnswers[index] !== undefined;
          if (answered) {
            if (optionIndex === question.answer) button.classList.add("is-correct");
            else if (quizAnswers[index] === optionIndex) button.classList.add("is-wrong");
          }
          button.onclick = () => {
            if (quizAnswers[index] !== undefined) return;
            quizAnswers[index] = optionIndex;
            stats.quizAnswered += 1;
            if (optionIndex === question.answer) stats.quizCorrect += 1;
            updateStats();
            renderTab();
          };
          block.append(button);
        });
        if (quizAnswers[index] !== undefined && question.explanation) {
          block.append(el("p", { class: "muted", style: "font-size:13.5px", text: question.explanation }));
        }
        slot.append(block);
      });
      return;
    }

    if (tab === "key-concepts") {
      const concepts = parseJson(content, { concepts: [] }).concepts || [];
      if (!concepts.length) return slot.append(el("p", { class: "muted", style: "white-space:pre-wrap", text: content }));
      const block = el("div", { class: "panel-block" });
      concepts.forEach((concept) =>
        block.append(el("div", { class: "kv" }, [el("strong", { text: concept.term }), el("span", { class: "muted", text: concept.note })]))
      );
      slot.append(block);
      return;
    }

    slot.append(el("div", { class: "panel-block" }, [el("div", { style: "white-space:pre-wrap;line-height:1.65", text: content })]));
  }

  renderTab();

  const onKey = (event) => {
    if (event.key === "Escape") {
      document.removeEventListener("keydown", onKey);
      end();
    }
  };
  document.addEventListener("keydown", onKey);
}
