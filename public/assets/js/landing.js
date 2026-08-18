import { $, $$ } from "./util.js";

const nav = $("#nav");
const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 8);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

const links = $("#navLinks");
$("#navToggle").addEventListener("click", () => links.classList.toggle("is-open"));
links.addEventListener("click", (event) => {
  if (event.target.closest("a")) links.classList.remove("is-open");
});

$("#year").textContent = String(new Date().getFullYear());

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-in");
      observer.unobserve(entry.target);
    }
  },
  { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
);

$$(".reveal").forEach((node) => observer.observe(node));

document.documentElement.dataset.theme =
  localStorage.getItem("cadiilac.theme") === "dark" ||
  (localStorage.getItem("cadiilac.theme") === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
