// Hand-labelled ground truth for the content_kind classifier.
//
// Every label here was set by reading the video's actual transcript chunks on
// 2026-08-28, not by reading its title. That distinction is the whole point:
// the read found titles that promise a technique over a transcript of song
// lyrics ("Keenan Cornelius passing lapel guards", "Guard Passing Drills",
// "Getting to the Lachy lock") and titles that sound like chatter over real
// instruction ("Beginners Guide To Inside Camping").
//
// A classifier that scores well on titles alone and badly here is the failure
// this file exists to catch.

export type ContentKind =
  | "instruction"
  | "training_advice"
  | "event_coverage"
  | "interview"
  | "promotional"
  | "no_content"
  | "off_topic";

export interface GoldItem {
  video_id: string;
  expected: ContentKind;
  /** Why, in the words of what the transcript actually says. */
  because: string;
}

export const GOLD: GoldItem[] = [
  // ── instruction ───────────────────────────────────────────────────────────
  {
    video_id: "jDPpo2X6rTY",
    expected: "instruction",
    because: "Brian Glick teaching half-guard camping: 'move our hand to our partner's hip, our second hand to our partner's knee'. Flagged non-relevant, and it is straight technique.",
  },
  {
    video_id: "BUB4YtDPJjc",
    expected: "instruction",
    because: "Foam roller work for the lower extremity. Physical prep is instruction even though it produced no BJJ technique card.",
  },
  {
    video_id: "YLyNImsRQiE",
    expected: "instruction",
    because: "'I slam on that handgun choke... drive my knee over and across'. One chunk, but it is a taught technique.",
  },
  // Relabelled instruction -> interview on 2026-08-28 after re-reading all ten
  // chunks. The original note said "the subject is how to do the technique";
  // the transcript says otherwise. Chunks 0-6 and 9 are Bernardo Faria
  // interviewing Josh Lean about quitting his job, YouTube ad revenue and mean
  // comments; only chunks 7-8 teach anything ("going to that butterfly ashi
  // position... use my feet to keep their leg extended"). Eight of ten chunks
  // are career talk, so interview is the honest per-video label.
  //
  // The model was right here and the label was wrong, which is worth stating
  // plainly rather than counting as a miss. It also changes nothing about the
  // gate: instruction and interview are both KEPT, so this disagreement never
  // reaches a retrieval decision either way.
  //
  // It does expose the real limit of a per-video field: this video genuinely
  // contains two chunks a practitioner searching "ankle lock" should find.
  // A per-chunk kind would answer that; content_kind cannot.
  {
    video_id: "1xo4quTN0bo",
    expected: "interview",
    because: "Bernardo Faria interviewing Josh Lean: 'I made like 700 bucks in ad revenue on YouTube and I was like, I'm quitting'. 8 of 10 chunks are career talk; only 7-8 teach a technique.",
  },
  { video_id: "Uw0qzqqd1bE", expected: "instruction", because: "Seminar footage, 13 technique cards." },
  { video_id: "pzjMS7-SBls", expected: "instruction", because: "Double wrist lock mini-seminar, 11 cards." },
  { video_id: "t2MGRSc1xh4", expected: "instruction", because: "41 no-gi open guard concepts, 11 cards." },
  { video_id: "Sw49QUMjlOc", expected: "instruction", because: "Side control masterclass, 10 cards." },
  { video_id: "2fkAMJ2lH7Y", expected: "instruction", because: "Camp class countering armbar counters, 11 cards." },
  {
    video_id: "5xyxrtpXuY4",
    expected: "instruction",
    because: "Rolling commentary, but the commentary is the teaching and it produced 12 cards.",
  },

  // ── training_advice ───────────────────────────────────────────────────────
  {
    video_id: "8lYPvNFPVwU",
    expected: "training_advice",
    because: "56-year-old brown belt handling a disrespectful younger training partner. Practitioner-facing, no technique.",
  },
  {
    video_id: "JkdUD9kC0X8",
    expected: "training_advice",
    because: "Student retention for gym owners. Advice about training, not a technique.",
  },
  {
    video_id: "IQeNKA3mKNw",
    expected: "training_advice",
    because: "'monologues at the end of class... you need to be concise'. Coaching advice.",
  },
  {
    video_id: "_xl5QiA6eeE",
    expected: "training_advice",
    because: "'not compare them to their peers... everyone has their own journey'. Mindset.",
  },
  {
    video_id: "4DHd4Py55Ik",
    expected: "training_advice",
    because: "Black belt attrition: 'out of 100 people who start, about 60 quit at white belt'.",
  },
  {
    video_id: "StUKCSIxW5o",
    expected: "training_advice",
    because: "Training around a newborn. Training-life logistics, the same category as the Zahabi back-pain AMAs.",
  },
  {
    video_id: "dh5EBVPsXuI",
    expected: "training_advice",
    because: "How steroid use ruptures tendons. Injury and health, practitioner-facing.",
  },

  // ── event_coverage ────────────────────────────────────────────────────────
  {
    video_id: "TYTu0vZj59w",
    expected: "event_coverage",
    because: "Full match, Polaris 38, walkout-to-result commentary.",
  },
  {
    video_id: "5V2wnxDCFBg",
    expected: "event_coverage",
    because: "Rankings show: 'who's falling, who's rising'. Results talk, not instruction.",
  },

  // ── interview ─────────────────────────────────────────────────────────────
  {
    video_id: "x2Rbb2QZdT8",
    expected: "interview",
    because: "Documentary profile of Nathan Haddad's road to ADCC. About a person and the sport, not a technique.",
  },
  {
    video_id: "KlZod5spqts",
    expected: "interview",
    because: "Zahabi's round-by-round MMA fight analysis. Analysis of an event, conversational, no instruction.",
  },

  // Both of the following were found on 2026-08-28 by dry-running the top 60
  // videos by chunk count and auditing every EXCLUDE, not by inventing cases.
  // The classifier scored 28/28 on the gold set at the time and still produced
  // these two false excludes, which is the argument for auditing held-out rows
  // rather than trusting a gold score.
  {
    video_id: "cj0kftppPvM",
    expected: "interview",
    because: "Zahabi pre-fight breakdown. Came back event_coverage, which would have deleted it. It is style and preparation analysis, not results: 'probably was the weight cut killing him... now he's training in Big Bear' and 'the teep is like the jab and he loves to jab'. Proves the boundary cannot be decided on whether the fight has happened yet.",
  },
  {
    video_id: "5HiWBT_U_OM",
    expected: "interview",
    because: "TriStar post-fight AMA on matchmaking and careers. Came back no_content because it rambles, which is a misuse of that class: the transcript is fluent English about fighters ('Arnold Allen... his title fight time is coming'). no_content means no intelligible speech, not off-topic speech.",
  },

  // ── promotional ───────────────────────────────────────────────────────────
  {
    video_id: "X3dwAX2PGSk",
    expected: "promotional",
    because: "'Prime Day with more than 300 daily deal prices and 53% off'. A sale.",
  },
  {
    video_id: "bDC3itrSA_4",
    expected: "promotional",
    because: "'four spots left for my September Tampa Immersion camp', over testimonial audio.",
  },

  // ── no_content ────────────────────────────────────────────────────────────
  // The class the plan did not have and the one that cannot be found by
  // statistics: these read as ordinary English prose to any heuristic.
  {
    video_id: "Aj7PrOdeTaI",
    expected: "no_content",
    because: "Title promises lapel guard passing. Five chunks, entire transcript is '♪♪ ♪♪ ♪♪'.",
  },
  {
    video_id: "2svTwQrR-w8",
    expected: "no_content",
    because: "Title is 'Guard Passing Drills'. Transcript is 'I love you. I love you.' over music.",
  },
  {
    video_id: "Gwid7tCjFVM",
    expected: "no_content",
    because: "Title is 'Getting to the Lachy lock'. Transcript is a rap verse: 'I smoke on the mic like smoking Joe Frazier'.",
  },
  {
    video_id: "olfIEnHhWeQ",
    expected: "no_content",
    because: "IBJJF Worlds highlight whose transcript is the word 'Heat.' repeated for seven chunks.",
  },
  {
    video_id: "RmFA0TSfdmw",
    expected: "no_content",
    because: "Asian Championships finals. Transcript is Japanese venue PA announcements calling competitors to mats.",
  },

  // ── off_topic ─────────────────────────────────────────────────────────────
  // The seventh class, added 2026-08-28 after auditing the first real run. All
  // four were classified no_content, which is wrong by that class's own
  // definition: every one is fluent, intelligible English. The model had
  // nowhere else to put them. These are user_submitted rows whose relevance
  // check never ran, per PLAN.md.
  //
  // The one that proves it mattered is not here but alongside them: "Technical
  // Stand-up sweep" is garbled ASR of real instruction and was ALSO filed under
  // no_content, so the wastebasket had already started swallowing keepers.
  {
    video_id: "0-1i1awbGgw",
    expected: "off_topic",
    because: "Finance commentary: 'we last left off talking about how the economy was booming. Capital good orders at 3.3%'. Fluent speech, nothing to do with grappling.",
  },
  {
    video_id: "IMpLFTscAH4",
    expected: "off_topic",
    because: "A Tesla Model 3 delivery review. Intelligible, on-topic for cars, not for jiu-jitsu.",
  },
  {
    video_id: "CxLZ-LAwO4k",
    expected: "off_topic",
    because: "Bangkok travel vlog: 'I've been here 4 years and I came here for a girl'. Personal, coherent, not about training.",
  },
  {
    video_id: "7641880975810612510",
    expected: "off_topic",
    because: "Streetball: 'Spain is mine defense Barcelona is mine defense'. A different sport entirely.",
  },
  {
    video_id: "tn1xNzFOJo8",
    expected: "instruction",
    because: "Garbled ASR of a real sweep lesson: 'My go inside him like this because he know this possibility I look to the shoulder... the sweep from the leg'. Was wrongly excluded as no_content. Bad transcription is not absence of speech.",
  },
];
