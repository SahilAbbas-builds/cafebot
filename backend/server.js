const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Anthropic({ maxRetries: 3 });
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "..", "prompts", "system-prompt.md"),
  "utf-8"
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));

app.post("/api/chat", async (req, res) => {
  const { message, conversationHistory } = req.body;

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  const messages = [
    ...(Array.isArray(conversationHistory) ? conversationHistory : []),
    { role: "user", content: message },
  ];

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages,
    });

    const textBlock = response.content.find((block) => block.type === "text");

    res.json({
      reply: textBlock ? textBlock.text : "Sorry, I couldn't come up with a reply.",
      conversationHistory: [
        ...messages,
        { role: "assistant", content: response.content },
      ],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("Claude API authentication error:", error.message);
    } else if (error instanceof Anthropic.RateLimitError) {
      console.error("Claude API rate limited:", error.message);
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}:`, error.message);
    } else {
      console.error("Unexpected error calling Claude API:", error);
    }

    res.status(500).json({
      reply:
        "Sorry, I'm having trouble thinking right now. Please try again in a moment.",
      error: "chat_failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`CafeBot server running at http://localhost:${PORT}`);
});
