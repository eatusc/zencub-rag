# Test Queries

Good test queries for the current text-search build. These are not just UI examples: `npm run eval:queries` runs them through the live `/api/rag/search` endpoint, checks that each query returns enough results, verifies expected BJJ terms appear in the retrieved evidence, and confirms top results include citations, timestamps, and source URLs.

- `knee cut`
- `saddle`
- `crossface`
- `underhook half guard`
- `guard retention`
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

`heel hook escape` is not in this set. It is a regression check for the Ask path, where vector retrieval once matched back-control "hook escape" chunks and returned no citations; see the 2026-07-07 entries in [DEVLOG.md](DEVLOG.md).

Latest generated report: [evals/rag-search-eval.md](evals/rag-search-eval.md).
