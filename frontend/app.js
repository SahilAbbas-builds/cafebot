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

function addMessage(text, sender) {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${sender}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function openChat() {
  chatWindow.hidden = false;
  chatToggle.setAttribute("aria-label", "Close chat");
  chatInput.focus();
}

function closeChat() {
  chatWindow.hidden = true;
  chatToggle.setAttribute("aria-label", "Open chat");
}

chatToggle.addEventListener("click", () => {
  if (chatWindow.hidden) {
    openChat();
  } else {
    closeChat();
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
  bubble.textContent = "CafeBot is typing…";
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
      "Sorry, I couldn't reach CafeBot right now. Please check your connection and try again.",
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
