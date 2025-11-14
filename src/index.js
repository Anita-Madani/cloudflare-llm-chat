// Tiny chat thing for the Cloudflare AI assignment.
// Goal: LLM on Workers AI + memory via Durable Objects. Nothing too serious.

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Cloudflare Edge Chat</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #020617;
      color: #e5e7eb;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      display: flex;
      justify-content: center;
    }
    .page {
      width: 100%;
      max-width: 750px;
      padding: 24px 16px 40px;
    }
    h1 {
      font-size: 1.5rem;
      margin: 0 0 4px;
    }
    .subtitle {
      font-size: 0.9rem;
      color: #9ca3af;
      margin-bottom: 16px;
    }
    .chat {
      height: 460px;
      border-radius: 12px;
      border: 1px solid #1f2937;
      background: #020617;
      padding: 12px;
      overflow-y: auto;
      margin-bottom: 10px;
    }
    .msg {
      max-width: 80%;
      margin-bottom: 8px;
      padding: 8px 10px;
      border-radius: 10px;
      font-size: 0.9rem;
      line-height: 1.35;
      white-space: pre-wrap;
    }
    .msg.user {
      margin-left: auto;
      background: #1d4ed8;
    }
    .msg.bot {
      margin-right: auto;
      background: #020617;
      border: 1px solid #1f2937;
    }
    form {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    textarea {
      flex: 1;
      resize: none;
      border-radius: 10px;
      border: 1px solid #4b5563;
      padding: 8px 10px;
      font-size: 0.9rem;
      background: #020617;
      color: #e5e7eb;
    }
    button {
      border: none;
      border-radius: 10px;
      padding: 8px 14px;
      font-size: 0.9rem;
      font-weight: 600;
      background: #22c55e;
      color: #022c22;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .note {
      margin-top: 6px;
      font-size: 0.8rem;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <div class="page">
    <h1>Cloudflare Edge Chat</h1>
    <div class="subtitle">
      Workers AI + Durable Objects. One session per browser, short memory on the edge.
    </div>

    <div id="chat" class="chat"></div>

    <form id="form">
      <textarea id="input" rows="2" placeholder="Ask something..."></textarea>
      <button id="send" type="submit">Send</button>
    </form>

    <div class="note">
      This is meant as a small demo, not a full product. I mainly wanted to show stateful LLM calls on Cloudflare.
    </div>
  </div>

  <script>
    const chatEl = document.getElementById("chat");
    const form = document.getElementById("form");
    const input = document.getElementById("input");
    const sendBtn = document.getElementById("send");

    // one id per tab, good enough for this
    const sessionId = crypto.randomUUID();

    function addMessage(text, role) {
      const div = document.createElement("div");
      div.className = "msg " + role;
      div.textContent = text;
      chatEl.appendChild(div);
      chatEl.scrollTop = chatEl.scrollHeight;
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;

      addMessage(text, "user");
      input.value = "";
      sendBtn.disabled = true;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: text })
        });

        const data = await res.json();
        if (data.reply) {
          addMessage(data.reply, "bot");
        } else if (data.error) {
          addMessage("error: " + data.error, "bot");
        }
      } catch (err) {
        addMessage("request failed", "bot");
      } finally {
        sendBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

const MAX_TURNS = 10;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // serve the UI
    if (url.pathname === "/") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html;charset=UTF-8" }
      });
    }

    // simple JSON API the frontend calls
    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = await request.json();
      const sessionId = body.sessionId || "default";
      const message = (body.message || "").trim();

      if (!message) {
        return new Response(
          JSON.stringify({ error: "empty message" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const id = env.CHAT_SESSIONS.idFromName(sessionId);
      const stub = env.CHAT_SESSIONS.get(id);

      const doReq = new Request("https://do/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message })
      });

      return stub.fetch(doReq);
    }

    return new Response("not found", { status: 404 });
  }
};

// one Durable Object = one chat session
export class ChatSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const { sessionId = "default", message } = await request.json();

    let history = await this.state.storage.get("history");
    if (!Array.isArray(history)) history = [];

    history.push({ role: "user", content: message });

    const recent = history.slice(-MAX_TURNS);

    const systemPrompt =
      "You are a direct, technical assistant. " +
      "Use the short chat history and answer clearly, no fluff.";

    const prompt =
      systemPrompt +
      "\n\nConversation:\n" +
      recent.map(m => m.role.toUpperCase() + ": " + m.content).join("\n") +
      "\nASSISTANT:";

    const result = await this.env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct",
      {
        prompt,
        max_tokens: 256
      }
    );

    const reply =
      typeof result === "string"
        ? result
        : result.response || JSON.stringify(result);

    history.push({ role: "assistant", content: reply });
    await this.state.storage.put("history", history);

    return new Response(
      JSON.stringify({
        reply,
        history: history.slice(-MAX_TURNS)
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
}
