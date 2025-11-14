Small edge chat app I built for the Cloudflare internship.
It runs a Llama model on Workers AI and uses a Durable Object to keep short per-session memory. The UI is a single HTML page that talks to one /api/chat route.
The goal was to show a simple stateful LLM setup on Cloudflare with model calls at the edge, lightweight chat history per session, and a minimal frontend.
