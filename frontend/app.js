const MOCK_REPLY = "Hi! I'm CafeBot. My AI brain isn't connected yet.";

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

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  addMessage(text, "user");
  chatInput.value = "";

  addMessage(MOCK_REPLY, "bot");
});
