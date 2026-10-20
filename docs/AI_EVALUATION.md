# AI evaluation
Automated checks in `tests/admin-ai.js` (run against a live server with a mock Ollama on :3199):
- Analytics figures equal independent recomputation from the admin order/reservation APIs (order count and value, top dish quantity, reservation count).
- Empty date range reports no data; out-of-scope and injection-style questions do not answer or change data.
- LLM guard: grounded text accepted; text with an invented number, a 500 error, and a timeout all fall back to the template.
- Recommendations: total <= budget, strict dietary tags only, impossible budget declined, hidden dishes never recommended.
- Concierge: policy answers cite their source; no revenue figures leak to the public Concierge.
Not yet measured: retrieval recall@k on a larger question set, latency percentiles, a real local model (Ollama was not available in the build environment), and any LLM-based tool calling.
