import { $, toast } from "./util.js";
import { api, isDemo } from "./api.js";

const params = new URLSearchParams(location.search);
let mode = params.get("mode") === "signup" ? "signup" : "signin";
const requestedPlan = params.get("plan") === "cloud" ? "cloud" : "free";

const form = $("#form");
const errorBox = $("#error");
const submit = $("#submit");

if (isDemo) $("#demoNote").classList.remove("hidden");

function render() {
  $("#nameField").classList.toggle("hidden", mode !== "signup");
  $("#title").textContent = mode === "signup" ? "Create your account" : "Welcome back";
  $("#subtitle").textContent =
    mode === "signup"
      ? "Free forever: 5 GB drive, 15 notes a week and 75 AI credits a day."
      : "Sign in to your notes, AI assistant and drive.";
  submit.textContent = mode === "signup" ? "Create account" : "Sign in";
  $("#password").autocomplete = mode === "signup" ? "new-password" : "current-password";
  document.querySelectorAll(".switcher button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  });
  errorBox.classList.add("hidden");
}

document.querySelectorAll(".switcher button").forEach((button) => {
  button.addEventListener("click", () => {
    mode = button.dataset.mode;
    render();
  });
});

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("#email").value.trim();
  const password = $("#password").value;
  const name = $("#name").value.trim();

  if (!email || !password) return showError("Enter your email and password.");
  if (mode === "signup" && password.length < 8) return showError("Choose a password with at least 8 characters.");

  submit.disabled = true;
  submit.textContent = mode === "signup" ? "Creating account…" : "Signing in…";
  try {
    if (mode === "signup") {
      const result = await api.signUp({ email, password, name, plan: requestedPlan });
      if (!isDemo && !result?.session) {
        toast("Check your inbox to confirm your email, then sign in.");
        mode = "signin";
        render();
        return;
      }
    } else {
      await api.signIn({ email, password });
    }
    location.href = "/app.html";
  } catch (error) {
    showError(error.message || "Something went wrong. Try again.");
  } finally {
    submit.disabled = false;
    render();
  }
});

api.getSession().then((session) => {
  if (session) location.href = "/app.html";
});

document.documentElement.dataset.theme = localStorage.getItem("cadiilac.theme") === "dark" ? "dark" : "light";
render();
