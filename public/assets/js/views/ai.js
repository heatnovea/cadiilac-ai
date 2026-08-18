/* Cadiilac AI conversation tab: text chat plus spoken conversations. */

import { el, $, toast, ICONS, confirmDialog } from "../util.js";
import { api } from "../api.js";
import { state, refreshMeters, navigate } from "../app.js";
import { htmlToText } from "../export.js";

const SUGGESTIONS = [
  "Plan a revision week for my exams",
  "Explain spaced repetition and how to use it",
  "Turn my last note into a study plan",
  "Quiz me on what I learned today",
];

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export async function render({ view, actions }) {
  let conversations = await api.listConversations();
  let activeId = conversations[0]?.id || null;
  let busy = false;
  let voiceMode = false;
  let recognition = null;
  let audio = null;

  const list = el("div", { class: "chat-list" });
  const messagesNode = el("div", { class: "messages" });
  const textarea = el("textarea", { rows: "1", placeholder: "Ask Cadiilac AI anything about your work…" });
  const sendButton = el("button", { class: "btn btn-icon", title: "Send", html: ICONS.send });
  const voiceButton = el("button", { class: "voice-orb", title: "Talk to Cadiilac AI", html: ICONS.mic });
  const suggestions = el("div", { class: "suggestions" });

  const composer = el("div", { class: "composer" }, [
    el("div", { class: "composer-inner" }, [textarea, voiceButton, sendButton]),
    suggestions,
  ]);

  const main = el("div", { class: "chat-main" }, [messagesNode, composer]);
  const chat = el("div", { class: "chat" }, [list, main]);
  view.append(chat);

  for (const text of SUGGESTIONS) {
    suggestions.append(
      el("button", {
        class: "suggestion",
        text,
        onclick: () => {
          textarea.value = text;
          textarea.focus();
          send();
        },
      })
    );
  }

  const activeConversation = () => conversations.find((item) => item.id === activeId) || null;

  function paintList() {
    list.innerHTML = "";
    list.append(
      el("button", {
        class: "btn btn-sm",
        style: "width:100%;margin-bottom:10px",
        html: `${ICONS.plus}<span>New conversation</span>`,
        onclick: newConversation,
      })
    );
    for (const conversation of conversations) {
      list.append(
        el("div", { class: `chat-item${conversation.id === activeId ? " is-active" : ""}`, onclick: () => {
          activeId = conversation.id;
          paintList();
          paintMessages();
        } }, [
          el("span", { text: conversation.title }),
          el("button", {
            class: "btn btn-icon",
            style: "margin-left:auto;width:26px;height:26px",
            title: "Delete conversation",
            html: ICONS.trash,
            onclick: async (event) => {
              event.stopPropagation();
              if (!(await confirmDialog("Delete conversation?", "The transcript will be removed.", "Delete"))) return;
              await api.deleteConversation(conversation.id);
              conversations = conversations.filter((item) => item.id !== conversation.id);
              if (activeId === conversation.id) activeId = conversations[0]?.id || null;
              paintList();
              paintMessages();
            },
          }),
        ])
      );
    }
  }

  function paintMessages() {
    const conversation = activeConversation();
    messagesNode.innerHTML = "";
    suggestions.classList.toggle("hidden", Boolean(conversation?.messages?.length));

    if (!conversation || !conversation.messages.length) {
      messagesNode.append(
        el("div", { class: "empty" }, [
          el("div", { class: "brand-mark", style: "width:38px;height:38px;font-size:19px", text: "C" }),
          el("h3", { text: "Cadiilac AI" }),
          el("p", { text: "Your assistant for productivity, learning and organisation. Ask a question, or hold the mic to talk." }),
        ])
      );
      return;
    }

    for (const message of conversation.messages) {
      const node = el("div", { class: `msg${message.role === "user" ? " is-user" : ""}` }, [
        el("div", { class: "msg-role" }, [
          el("span", { text: message.role === "user" ? state.profile?.name || "You" : "Cadiilac AI" }),
          message.spoken ? el("span", { class: "badge", text: "Voice" }) : null,
          el("div", { class: "msg-actions" }, [
            el("button", { class: "btn btn-icon", title: "Copy", html: ICONS.check, onclick: () => navigator.clipboard.writeText(message.content).then(() => toast("Copied.")) }),
            message.role === "assistant"
              ? el("button", { class: "btn btn-icon", title: "Read aloud", html: ICONS.mic, onclick: () => speak(message.content) })
              : null,
          ]),
        ]),
        el("div", { class: "msg-body", text: message.content }),
      ]);
      messagesNode.append(node);
    }
    messagesNode.scrollTop = messagesNode.scrollHeight;
  }

  async function newConversation() {
    const conversation = await api.createConversation("New conversation");
    conversations = [conversation, ...conversations];
    activeId = conversation.id;
    paintList();
    paintMessages();
    textarea.focus();
  }

  function setBusy(value, label = "Cadiilac AI is thinking…") {
    busy = value;
    sendButton.innerHTML = value ? '<span class="spinner"></span>' : ICONS.send;
    sendButton.disabled = value;
    if (value) {
      const pending = el("div", { class: "msg", id: "pending" }, [
        el("div", { class: "msg-role", text: "Cadiilac AI" }),
        el("div", { class: "row", style: "gap:9px" }, [el("span", { class: "spinner" }), el("span", { class: "muted", text: label })]),
      ]);
      messagesNode.append(pending);
      messagesNode.scrollTop = messagesNode.scrollHeight;
    } else {
      $("#pending")?.remove();
    }
  }

  async function noteContext() {
    // The assistant answers with the most recently edited note as background.
    try {
      const notes = await api.listNotes();
      const latest = notes[0];
      if (!latest) return null;
      const text = htmlToText(latest.content || "").slice(0, 2500);
      return text ? `Most recent note “${latest.title}”:\n${text}` : null;
    } catch {
      return null;
    }
  }

  async function send(spoken = false) {
    const content = textarea.value.trim();
    if (!content || busy) return;
    let conversation = activeConversation();
    if (!conversation) {
      conversation = await api.createConversation(content.slice(0, 42));
      conversations = [conversation, ...conversations];
      activeId = conversation.id;
      paintList();
    }

    textarea.value = "";
    textarea.style.height = "auto";
    conversation.messages = [...conversation.messages, { role: "user", content, spoken, at: new Date().toISOString() }];
    paintMessages();
    setBusy(true);

    try {
      const result = await api.chat({
        messages: conversation.messages.slice(-14).map(({ role, content: text }) => ({ role, content: text })),
        context: await noteContext(),
        preferences: state.profile?.settings?.ai,
      });
      conversation.messages = [...conversation.messages, { role: "assistant", content: result.content, at: new Date().toISOString() }];
      const title = conversation.title === "New conversation" ? content.slice(0, 42) : conversation.title;
      await api.updateConversation(conversation.id, { messages: conversation.messages, title });
      conversation.title = title;
      await refreshMeters();
      paintList();
      paintMessages();
      if (spoken || voiceMode) await speak(result.content);
    } catch (error) {
      if (error.code === "no_credits") {
        toast(error.message, "error", 6000);
        navigate("settings", { section: "subscription" });
      } else {
        toast(error.message, "error");
      }
    } finally {
      setBusy(false);
      paintMessages();
    }
  }

  async function speak(text) {
    voiceButton.classList.add("is-speaking");
    try {
      const result = await api.speak({ text: text.slice(0, 1200), voice: state.profile?.settings?.ai?.voice_id });
      await refreshMeters();
      if (result.audioUrl) {
        audio?.pause();
        audio = new Audio(result.audioUrl);
        audio.playbackRate = state.profile?.settings?.ai?.voice_speed || 1;
        await audio.play();
        audio.onended = () => voiceButton.classList.remove("is-speaking");
        return;
      }
      // No ElevenLabs key configured: fall back to the browser speech engine.
      const utterance = new SpeechSynthesisUtterance(result.speak || text);
      utterance.rate = state.profile?.settings?.ai?.voice_speed || 1;
      utterance.onend = () => voiceButton.classList.remove("is-speaking");
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    } catch (error) {
      voiceButton.classList.remove("is-speaking");
      toast(error.message, "error");
    }
  }

  function stopSpeaking() {
    audio?.pause();
    speechSynthesis.cancel();
    voiceButton.classList.remove("is-speaking");
  }

  voiceButton.onclick = () => {
    if (voiceButton.classList.contains("is-speaking")) return stopSpeaking();
    if (!SpeechRecognition) {
      toast("Speech input is not supported in this browser — type your message instead.", "error", 5000);
      return;
    }
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SpeechRecognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    voiceButton.classList.add("is-recording");
    let transcript = "";

    recognition.onresult = (event) => {
      transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join(" ");
      textarea.value = transcript;
    };
    recognition.onerror = (event) => {
      toast(`Microphone error: ${event.error}`, "error");
    };
    recognition.onend = () => {
      voiceButton.classList.remove("is-recording");
      recognition = null;
      if (transcript.trim()) {
        voiceMode = true;
        send(true);
      }
    };
    recognition.start();
  };

  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(168, textarea.scrollHeight)}px`;
  });

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  sendButton.onclick = () => send();

  actions.append(
    el("button", { class: "btn btn-sm", text: "Stop audio", onclick: stopSpeaking }),
    el("button", { class: "btn btn-sm btn-primary", html: `${ICONS.plus}<span>New chat</span>`, onclick: newConversation })
  );

  paintList();
  paintMessages();
  textarea.focus();

  return {
    destroy() {
      stopSpeaking();
      recognition?.stop();
    },
  };
}
