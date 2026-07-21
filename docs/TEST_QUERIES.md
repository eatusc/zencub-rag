# Test Queries

Good test queries for the current text-search build. These are not just UI examples: `npm run eval:queries` runs them through the live `/api/rag/search` endpoint, checks that each query returns enough results, verifies expected BJJ terms appear in the retrieved evidence, and confirms top results include citations, timestamps, and source URLs.

- `knee cut`
- `saddle`
- `crossface`
- `underhook half guard`
- `guard retention`
- `heel hook escape`
- `single leg x`
- `kimura trap`
- `body lock pass`
- `deep half`
- `rear naked choke`
- `armbar`
- `triangle choke`
- `arm triangle`
- `ankle lock`
- `heel hook`
- `mount escape`
- `closed guard pass`
- `bow and arrow choke`
- `omoplata`

Latest generated report: [evals/rag-search-eval.md](evals/rag-search-eval.md).
