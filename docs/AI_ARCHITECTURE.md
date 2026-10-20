# AI architecture
Principle: numbers and actions come from deterministic code and parameterised SQL; a model may only re-word verified facts.

| Component | File | How it works |
|---|---|---|
| Élan Concierge | `extra.js`, `ai.js` | Rule-based intent routing over public tools: menu, price, hours, availability, own order status, recommendations, policy answers. No LLM. Never books, orders or certifies allergen safety. |
| Recommendation engine | `ai.js` `recommend()` | Hard filters (available, not hidden, strict dietary tag) -> ranking (featured + published review average) -> budget fitting (downgrade by price cap, then drop dessert/starter) -> template explanation. Conditional dietary tags ("if", "verify", "not") are excluded, never assumed safe. |
| Knowledge retrieval | `ai.js`, `data/knowledge/*.md`, `faqs.json` | SQLite FTS5 index rebuilt at start. Replies cite the source file. No vector DB. |
| Admin analytics | `ai.js` `TOOLS` | Four fixed queries: order summary, popular dishes, reservation summary, enquiry topics. Admin-only, 366-day cap, limit<=20, audit-logged, response includes the SQL for verification. |
| Optional local LLM | `ai.js` `llm()` | Set `OLLAMA_URL` (+ `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`). It only rewrites the analytics summary; the text is discarded if it contains any number not present in the computed facts, or on error/timeout. |

Definitions: order value = orders not cancelled/failed by created date (UTC); popular dish = total quantity; reservation demand = reservation records by reservation date (cancelled counted separately, excluded from busiest hours).
Admin AI is a separate route (`/api/admin/ai/analytics`) with its own session check; the Concierge has no access to it.
Not done: LLM-driven Concierge/tool calling, embeddings, AI actions that change data.
