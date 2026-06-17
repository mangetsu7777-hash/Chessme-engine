# Graph Report - .  (2026-04-15)

## Corpus Check
- Corpus is ~1,742 words - fits in a single context window. You may not need a graph.

## Summary
- 20 nodes · 24 edges · 4 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Server & Cache Layer|Server & Cache Layer]]
- [[_COMMUNITY_Chess Engine Interface|Chess Engine Interface]]
- [[_COMMUNITY_HTTP & Auth Utilities|HTTP & Auth Utilities]]
- [[_COMMUNITY_Keepalive Service|Keepalive Service]]

## God Nodes (most connected - your core abstractions)
1. `Engine` - 6 edges
2. `httpsGet()` - 3 edges
3. `supabaseGet()` - 2 edges
4. `supabaseSet()` - 2 edges
5. `httpsPost()` - 2 edges
6. `verifyJWT()` - 2 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Server & Cache Layer"
Cohesion: 0.25
Nodes (2): httpsPost(), supabaseSet()

### Community 1 - "Chess Engine Interface"
Cohesion: 0.53
Nodes (1): Engine

### Community 2 - "HTTP & Auth Utilities"
Cohesion: 0.67
Nodes (3): httpsGet(), supabaseGet(), verifyJWT()

### Community 3 - "Keepalive Service"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **Thin community `Keepalive Service`** (2 nodes): `keepalive.js`, `ping()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Engine` connect `Chess Engine Interface` to `Server & Cache Layer`?**
  _High betweenness centrality (0.386) - this node is a cross-community bridge._
- **Why does `httpsGet()` connect `HTTP & Auth Utilities` to `Server & Cache Layer`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._