const DEFAULT_ASSISTANT_NAME = "CafeBot";
let assistantName = DEFAULT_ASSISTANT_NAME;

function applyBrand(brand) {
  assistantName = brand.assistantName || DEFAULT_ASSISTANT_NAME;

  if (brand.cafeName && brand.tagline) {
    document.title = `${brand.cafeName} — ${brand.tagline}`;
  }

  const rootStyle = document.documentElement.style;
  if (brand.colors) {
    if (brand.colors.primary) rootStyle.setProperty("--color-rust", brand.colors.primary);
    if (brand.colors.primaryDark) rootStyle.setProperty("--color-rust-dark", brand.colors.primaryDark);
    if (brand.colors.accent) rootStyle.setProperty("--color-forest", brand.colors.accent);
  }

  document.querySelectorAll("[data-brand='cafeName']").forEach((el) => {
    if (brand.cafeName) el.textContent = brand.cafeName;
  });
  document.querySelectorAll("[data-brand='assistantName']").forEach((el) => {
    el.textContent = assistantName;
  });

  const logoIcon = document.getElementById("site-logo-icon");
  if (logoIcon && brand.logoIcon) {
    logoIcon.src = brand.logoIcon;
    logoIcon.alt = `${brand.cafeName || "Cafe"} logo`;
    logoIcon.hidden = false;
  }

  const footerYear = document.getElementById("footer-year");
  if (footerYear) footerYear.textContent = new Date().getFullYear();

  const heroPhoto = document.getElementById("hero-photo");
  if (heroPhoto && brand.images && brand.images.hero) {
    heroPhoto.src = brand.images.hero;
    heroPhoto.alt = brand.images.heroAlt || heroPhoto.alt;
  }
}

async function hydrateSite() {
  try {
    const [brandRes, menuRes] = await Promise.all([
      fetch("/api/brand"),
      fetch("/api/menu"),
    ]);
    if (brandRes.ok) {
      applyBrand(await brandRes.json());
    }
    if (menuRes.ok) {
      const items = await menuRes.json();
      document.querySelectorAll(".menu-card[data-item-id]").forEach((card) => {
        const item = items.find((i) => i.id === card.dataset.itemId);
        if (!item || !item.image) return;
        const img = card.querySelector(".menu-card-img");
        if (img) {
          img.src = item.image;
          img.alt = item.name;
        }
      });
    }
  } catch (networkError) {
    // Static defaults already in the markup keep the page correct if this fails.
  }
}

hydrateSite();

const navToggle = document.getElementById("nav-toggle");
document.querySelectorAll(".site-nav a").forEach((link) => {
  link.addEventListener("click", () => {
    navToggle.checked = false;
  });
});

const chatToggle = document.getElementById("chat-toggle");
const chatWindow = document.getElementById("chat-window");
const chatClose = document.getElementById("chat-close");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatMessages = document.getElementById("chat-messages");

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInline(escapedText) {
  return escapedText.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

const BULLET_LINE_RE = /^[-*]\s+(.*)$/;
const NUMBERED_LINE_RE = /^\d+\.\s+(.*)$/;
const HEADING_LINE_RE = /^\*\*(.+?):\*\*$/;

function renderList(lines, tag, lineRe) {
  const items = lines.map((line) => `<li>${formatInline(line.replace(lineRe, "$1"))}</li>`).join("");
  return `<${tag} class="msg-list">${items}</${tag}>`;
}

function renderBlock(block) {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";

  let html = "";
  let rest = lines;

  // A leading standalone "**Label:**" line (e.g. "**Items:**") is peeled off
  // as a heading before classifying the rest, since the model's real output
  // puts a bold label and its list in the SAME block (no blank line between).
  if (HEADING_LINE_RE.test(lines[0])) {
    html += `<div class="msg-heading">${formatInline(lines[0].match(HEADING_LINE_RE)[1])}</div>`;
    rest = lines.slice(1);
  }

  if (rest.length === 0) return html;
  if (rest.every((l) => BULLET_LINE_RE.test(l))) return html + renderList(rest, "ul", BULLET_LINE_RE);
  if (rest.every((l) => NUMBERED_LINE_RE.test(l))) return html + renderList(rest, "ol", NUMBERED_LINE_RE);

  return html + `<p class="msg-para">${rest.map(formatInline).join("<br>")}</p>`;
}

function renderMessageHtml(rawText) {
  const escaped = escapeHtml(rawText).replace(/\r\n/g, "\n");
  return escaped.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).map(renderBlock).join("");
}

function addMessage(text, sender) {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${sender}`;
  if (sender === "bot") {
    bubble.innerHTML = renderMessageHtml(text);
  } else {
    bubble.textContent = text;
  }
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let closeTimeoutId = null;
let isChatOpen = false;

function openChat() {
  isChatOpen = true;
  clearTimeout(closeTimeoutId);
  chatWindow.classList.remove("chat-window--closing");
  chatWindow.hidden = false;
  chatToggle.setAttribute("aria-label", "Close chat");
  chatInput.focus();
}

function closeChat() {
  isChatOpen = false;
  chatToggle.setAttribute("aria-label", "Open chat");
  clearTimeout(closeTimeoutId);

  if (prefersReducedMotion) {
    chatWindow.hidden = true;
    return;
  }

  chatWindow.classList.add("chat-window--closing");
  closeTimeoutId = setTimeout(() => {
    chatWindow.hidden = true;
    chatWindow.classList.remove("chat-window--closing");
  }, 200);
}

chatToggle.addEventListener("click", () => {
  if (isChatOpen) {
    closeChat();
  } else {
    openChat();
  }
});

chatClose.addEventListener("click", closeChat);

let conversationHistory = [];
let isSending = false;
const MAX_HISTORY_MESSAGES = 20;

function showTypingIndicator() {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble bot";
  bubble.id = "typing-indicator";
  bubble.textContent = `${assistantName} is typing…`;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function hideTypingIndicator() {
  const indicator = document.getElementById("typing-indicator");
  if (indicator) indicator.remove();
}

async function sendChatMessage(text) {
  isSending = true;
  showTypingIndicator();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        conversationHistory: conversationHistory.slice(-MAX_HISTORY_MESSAGES),
      }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (parseError) {
      data = null;
    }

    hideTypingIndicator();

    if (!response.ok) {
      addMessage(
        (data && data.reply) || "Sorry, something went wrong. Please try again.",
        "bot"
      );
      return;
    }

    conversationHistory = data.conversationHistory || conversationHistory;
    addMessage(data.reply || "Sorry, I didn't catch that.", "bot");
  } catch (networkError) {
    hideTypingIndicator();
    addMessage(
      `Sorry, I couldn't reach ${assistantName} right now. Please check your connection and try again.`,
      "bot"
    );
  } finally {
    isSending = false;
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (isSending) return;

  const text = chatInput.value.trim();
  if (!text) return;

  addMessage(text, "user");
  chatInput.value = "";

  sendChatMessage(text);
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});
