# RAG Semantic Comparison

Generated: 2026-07-07

This comparison checks where `Semantic Search` helps compared with normal keyword `Search`. It is a manual report from live API calls against TEST with 12,104 embedded chunks.

| Query | Normal Search Top Result | Semantic Search Top Result | Read |
| --- | --- | --- | --- |
| `how do I stop someone passing my guard` | `How To Pass Anyone's Guard In Jiu Jitsu No Gi by Marcelo Garcia @ 1:08` | `STOP THE GUARD PULL EVERY TIME! (Simple & Effective) @ 0:00` | Mixed: semantic found guard-prevention content, while Ask hybrid used it with citations. |
| `escape heavy mount pressure` | `2026 Polaris 37 @ 39:12` | `5 Black Belts Show You How to Apply Pressure @ 7:04` | Semantic was better: keyword search drifted into match commentary. |
| `finish a choke from the back` | `Winter Camp 2026: Black Belt Approach to Fundamental Submissions: Chokes with Matthew McPeake @ 7:09` | `How to Finish the Rear Naked Choke (Step-by-Step BJJ Guide) @ 0:00` | Semantic was better: it found a focused rear-naked-choke finish. |
| `pass guard with hip pressure` | `Very Efficient Knee Cut BJJ Guard Passing No Gi by JT Torres @ 5:47` | `Simple Concept to Make Passing Easier @ 0:00` | Semantic was useful: both were plausible, semantic found a broader concept clip. |
| `protect my neck when someone has my back` | `How to Escape the Back EVERY TIME | Jiu Jitsu Back Escape System @ 0:00` | `Mount Escape Fundamentals for BJJ | Jiu Jitsu Tutorial - Coach Nic Gregoriades @ 0:11` | Normal was better: semantic over-weighted general danger/escape language. |
| `defend leg locks safely` | `BJJ - Getting out of Side control with Karel Silver Fox Pravec - Coach Zahabi @ 3:30` | `If you want to be good at leg locks you have to know this setup @ 0:00` | Semantic was closer, but still attack-oriented rather than defense-oriented. |
| `recover guard when smashed` | `Rafael Mendes | Guard Passing Options Using the Shin Trap @ 5:48` | `BJJ Tutorial - Powerful Guard Pass Prevention - Firas Zahabi @ 3:26` | Semantic improved: it found guard-pass-prevention content, but Ask still used text fallback. |
| `control the head from side control` | `Guard Retention - How To Never Get Your Guard Passed In Jiu Jitsu by Gordon Ryan @ 6:59` | `How To Build The Perfect Half Guard Game by John Danaher @ 10:25` | Semantic found related head-control framing, but this query still needs better ranking. |

Takeaway: semantic search is most useful for concept phrasing where the exact words do not appear in the query. It still needs full corpus embedding and ranking evaluation for defensive/ambiguous queries.
