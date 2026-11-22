// Sovereign Trellis Unbounded Context & Emergent Capabilities Engine for Luka Upper-Body Sim.
//
// Integrates the core Trellis architecture:
//   - TRP-1 Append-Only Write-Ahead Log (cyrb128 content hashes, checkpoints, branches)
//   - Grounded Atomic Claim Extraction (span-anchored people, orgs, locations, projects, commitments)
//   - Entity & Relationship Graph with directional edgeLabels & open loops
//   - TMI-1 Inverted Memory Index over unbounded WAL history
//   - TVP-1 Cache-Aware Viewport Knapsack Optimizer (level0/level1/level2 progressive resolution)
//   - TIC-1 Context Fingerprinting & Hot/Warm/Cool/Cold tier telemetry
//   - Emergent Capability Service (composition discovery + Teach-by-Pose embodied skills)

const STORAGE_KEY = 'luka_trellis_sovereign_v1';

/* ----------------------------------------------------- Deterministic Hash */

export function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return `cyrb128:${hex(h1 ^ h2 ^ h3 ^ h4)}${hex(h2 ^ h1)}${hex(h3 ^ h1)}${hex(h4 ^ h1)}`;
}

const estimateTokens = (text) => (text ? Math.ceil(String(text).length / 3.4) : 0);
const titleCase = (s) =>
  String(s || '')
    .trim()
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');

/* ----------------------------------------------------- Seed Graph & Skills */

const SEED_ENTITIES = [
  {
    id: 'ent-luka',
    name: 'Luka',
    type: 'robot',
    roleOrField: 'AgiBot A2 Ultra Humanoid Twin',
    location: 'Steadwell / AGR Labs',
    notes: ['Glossy obsidian black head with OLED visor', 'White and gunmetal upper-body chassis with 7-DOF arms and Inspire RH56 dexterous hands'],
    edgeLabels: { Steadwell: 'operated by', 'AGR Labs': 'commissioned at', Toby: 'collaborates with' },
    openLoops: [],
    trustState: 'verified',
    updatedAt: Date.now(),
  },
  {
    id: 'ent-toby',
    name: 'Toby',
    type: 'person',
    roleOrField: 'Builder & Operator',
    location: 'Steadwell Lab',
    notes: ['Building Luka upper-body digital twin with Kameyoko tracking and Trellis unbounded context'],
    edgeLabels: { Luka: 'operates', Steadwell: 'builds at', Trellis: 'architects' },
    openLoops: [],
    trustState: 'verified',
    updatedAt: Date.now(),
  },
  {
    id: 'ent-steadwell',
    name: 'Steadwell',
    type: 'organization',
    roleOrField: 'Local-First Embodied AI & Trellis Lab',
    location: 'AGR Labs',
    notes: ['Sovereign local memory, CoRa, Trellis TRP-1, and AgiBot A2 commissioning'],
    edgeLabels: { Luka: 'hosts', Trellis: 'develops' },
    openLoops: [],
    trustState: 'verified',
    updatedAt: Date.now(),
  },
];

const SEED_SKILLS = [
  {
    id: 'skill-wave-greeting',
    name: 'wave_greeting',
    version: 1,
    source: 'builtin',
    gesture: 'wave',
    description: 'Raise right arm with open Inspire palm and perform a friendly human greeting wave while maintaining eye contact.',
    triggerPhrases: ['wave', 'say hi', 'say hello', 'greet'],
    procedureSteps: ['Turn head toward speaker', 'Lift right shoulder and flex elbow', 'Open RH56 fingers', 'Oscillate wrist smoothly'],
    confidenceScore: 0.96,
    successfulRuns: 18,
    totalRuns: 18,
  },
  {
    id: 'skill-explain-hands',
    name: 'explain_open_hands',
    version: 1,
    source: 'builtin',
    gesture: 'explain',
    description: 'Synchronize expressive two-hand open-palm conversational gestures and head nods with spoken replies.',
    triggerPhrases: ['explain', 'tell me about', 'walk me through'],
    procedureSteps: ['Lift forearms to conversational zone', 'Modulate hand openness with voice RMS', 'Add subtle affirmative head cadence'],
    confidenceScore: 0.94,
    successfulRuns: 24,
    totalRuns: 25,
  },
  {
    id: 'skill-inspect-hands',
    name: 'inspect_hands',
    version: 1,
    source: 'builtin',
    gesture: 'inspect',
    description: 'Bring both Inspire RH56 dexterous hands in front of the visor and ripple each finger to verify articulation.',
    triggerPhrases: ['inspect hands', 'show your hands', 'wiggle fingers', 'check fingers'],
    procedureSteps: ['Flex elbows to chest height', 'Pitch head down toward palms', 'Ripple thumb through pinky channels'],
    confidenceScore: 0.95,
    successfulRuns: 12,
    totalRuns: 12,
  },
  {
    id: 'skill-trellis-anchor',
    name: 'trellis_anchor_memory',
    version: 1,
    source: 'builtin',
    gesture: 'nod',
    description: 'Extract grounded atomic claims (people, orgs, locations, commitments, projects) and commit them to the immutable TRP-1 WAL.',
    triggerPhrases: ['remember that', 'met with', 'i promised', 'works at', 'lives in'],
    procedureSteps: ['Run DeterministicClaimDetector', 'Fuse claims preserving role metadata', 'Upsert entity graph & edgeLabels', 'Append cyrb128 WAL commit'],
    confidenceScore: 0.95,
    successfulRuns: 30,
    totalRuns: 31,
  },
  {
    id: 'skill-kameyoko-mirror',
    name: 'kameyoko_mirror_body',
    version: 1,
    source: 'builtin',
    gesture: 'open_hands',
    description: 'Track operator head, arms, and 10 fingers via MediaPipe 3D world landmarks and mirror onto Luka upper body.',
    triggerPhrases: ['mirror me', 'copy my moves', 'track my hands', 'follow my arms'],
    procedureSteps: ['Filter 33 pose + 42 hand landmarks with One Euro Filter', 'Solve torso-frame shoulder/elbow angles', 'Apply 10-finger curls to RH56 joints'],
    confidenceScore: 0.93,
    successfulRuns: 14,
    totalRuns: 15,
  },
];

/* ------------------------------------------------ Grounded Claim Extractor */

const INVALID_NAMES = new Set([
  'who', 'whom', 'what', 'where', 'when', 'why', 'how', 'which', 'anyone', 'someone',
  'i', 'me', 'my', 'you', 'your', 'he', 'she', 'they', 'them', 'we', 'us', 'our',
  'the', 'a', 'an', 'and', 'or', 'but', 'at', 'in', 'on', 'to', 'with', 'for',
  'today', 'yesterday', 'tomorrow', 'tonight', 'now', 'here', 'there', 'this', 'that',
]);

function isInvalidName(name) {
  const c = String(name || '').toLowerCase().trim().replace(/^[\s"'.,!?;:]+|[\s"'.,!?;:]+$/g, '');
  return !c || c.length < 2 || INVALID_NAMES.has(c);
}

function findSpan(text, needle) {
  if (!needle) return undefined;
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return undefined;
  return { text: text.slice(idx, idx + needle.length), start: idx, end: idx + needle.length };
}

const ORG_CAPTURE = '([^.,;!?]+?)(?=[.,;!?]|$|\\s+(?:and|but|who|which|based|lives|living|located|working|since|in)\\b)';
const AFFILIATION_PATTERNS = [
  { re: new RegExp(`i(?:'m|\\s+am|\\s+was)\\s+on\\s+the\\s+board\\s+of\\s+${ORG_CAPTURE}`, 'i'), role: 'board member' },
  { re: new RegExp(`i\\s+(?:work|worked|working)\\s+(?:at|for|with)\\s+${ORG_CAPTURE}`, 'i'), role: 'works at' },
  { re: new RegExp(`i(?:'m|\\s+am|\\s+was)\\s+(?:the\\s+)?(?:founder|co-founder|ceo|cto|lead|director)\\s+(?:at|of)\\s+${ORG_CAPTURE}`, 'i'), role: 'leads' },
  { re: new RegExp(`([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)\\s+(?:works|working)\\s+(?:at|for)\\s+${ORG_CAPTURE}`), role: 'works at', hasSubject: true },
];

export function extractClaimsSync(utterance, knownEntities = []) {
  const clean = String(utterance || '').trim();
  if (!clean) return [];

  // Questions are recall lookups unless explicitly saying "remember ..."
  if ((/\?\s*$/.test(clean) || /^(?:who|what|where|when|why|how|which|do you know|tell me)\b/i.test(clean)) && !/\bremember\b/i.test(clean)) {
    return [];
  }

  const claims = [];
  const push = (kind, value, opts = {}) => {
    const v = String(value || '').trim();
    if (!v || isInvalidName(v)) return;
    claims.push({
      id: `clm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind,
      value: v,
      role: opts.role,
      subject: opts.subject,
      provenance: opts.provenance || 'asserted',
      confidence: opts.confidence ?? 0.9,
      surfaceSpan: findSpan(clean, opts.surface || v),
      qualifiers: opts.qualifiers,
    });
  };

  // 1. URLs & Emails
  for (const m of clean.matchAll(/https?:\/\/[^\s]+/gi)) {
    push('url', m[0], { provenance: 'deterministic_resolved', confidence: 1.0 });
  }
  const emailM = clean.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (emailM) push('email', emailM[0].toLowerCase(), { provenance: 'deterministic_resolved', confidence: 1.0 });

  // 2. Project codes (e.g. A2-T3D1, TH-01, RH-56)
  for (const m of clean.matchAll(/\b([A-Z][A-Z0-9]{1,4}-[A-Z0-9]{2,6})\b/g)) {
    if (/\d/.test(m[1])) {
      push('project', m[1].toUpperCase(), { provenance: 'deterministic_resolved', confidence: 0.96 });
    }
  }

  // 3. Known entities mentioned in utterance
  let primaryPerson = null;
  for (const ent of knownEntities) {
    if (!ent?.name || ent.name.length < 2) continue;
    const re = new RegExp(`\\b${ent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const m = clean.match(re);
    if (!m) continue;
    const kind = ent.type === 'organization' ? 'organization' : ent.type === 'location' ? 'location' : ent.type === 'project' ? 'project' : ent.type === 'robot' ? 'robot' : 'person';
    if (kind === 'person' && !primaryPerson) primaryPerson = ent.name;
    push(kind, ent.name, { provenance: 'deterministic_resolved', confidence: 0.97, surface: m[0], role: kind === 'person' ? 'primary' : undefined });
  }

  // 4. Explicit "my name is X" / "I'm X" / "met with X" / "spoke with X"
  const selfName = clean.match(/(?:my\s+name\s+is|call\s+me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (selfName && !isInvalidName(selfName[1])) {
    primaryPerson = titleCase(selfName[1]);
    push('person', primaryPerson, { role: 'operator', confidence: 0.96, surface: selfName[1] });
  }

  const personM = clean.match(/(?:with|met|called|spoke\s+with|talked\s+to|introduced\s+to|remember)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (personM && !isInvalidName(personM[1])) {
    primaryPerson = primaryPerson || titleCase(personM[1]);
    push('person', titleCase(personM[1]), { role: 'primary', confidence: 0.92, surface: personM[1] });
  }

  // Subject leading statement: "Maya is based in Austin", "Alex builds drones"
  const leadSubj = clean.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:is\s+(?:based\s+in|from|living\s+in|working\s+on)|lives\s+in|works\s+at|builds|leads|runs)\s+([^.,;!?]+)/);
  if (leadSubj && !isInvalidName(leadSubj[1])) {
    primaryPerson = titleCase(leadSubj[1]);
    push('person', primaryPerson, { role: 'primary', confidence: 0.93, surface: leadSubj[1] });
  }

  // 5. Affiliations
  for (const pat of AFFILIATION_PATTERNS) {
    const m = clean.match(pat.re);
    if (!m) continue;
    if (pat.hasSubject) {
      const subj = titleCase(m[1]);
      const org = titleCase(m[2].replace(/^(?:the|a|an)\s+/i, ''));
      if (!isInvalidName(subj)) {
        primaryPerson = subj;
        push('person', subj, { role: 'primary', confidence: 0.92, surface: m[1] });
      }
      push('organization', org, { role: pat.role, subject: subj, confidence: 0.92, surface: m[2] });
    } else {
      const org = titleCase(m[1].replace(/^(?:the|a|an)\s+/i, ''));
      push('organization', org, { role: pat.role, subject: primaryPerson || 'Toby', confidence: 0.91, surface: m[1] });
    }
    break;
  }

  // 6. Location / Origin
  const locM = clean.match(/(?:based\s+in|lives\s+in|living\s+in|located\s+in|moved\s+to|from)\s+([A-Z][a-zA-Z\s-]{1,30}?)(?=[.,;!?]|$|\s+(?:and|working|who|with)\b)/);
  if (locM && !isInvalidName(locM[1])) {
    push('location', titleCase(locM[1]), { role: 'based in', subject: primaryPerson || 'Toby', confidence: 0.91, surface: locM[1] });
  }

  // 7. Projects / Products
  const projM = clean.match(/(?:working\s+on|building|launching|shipping|demoing|testing)\s+(?:the\s+|a\s+|an\s+)?([A-Za-z0-9][A-Za-z0-9\s'-]{2,40}?)(?=[.,;!?]|$|\s+(?:with|at|in|for|by)\b)/i);
  if (projM && !isInvalidName(projM[1])) {
    push('project', projM[1].trim(), { role: 'working on', subject: primaryPerson || 'Toby', confidence: 0.86, surface: projM[1] });
  }

  // 8. Commitments / Open Loops
  const oweM = clean.match(/(?:i\s+(?:owe|promised|need\s+to\s+send|will\s+send|should\s+follow\s+up\s+on)|remind\s+me\s+to)\s+([^.,;!?]+)/i);
  if (oweM) {
    push('commitment', oweM[1].trim(), { role: 'you_owe', subject: primaryPerson || 'Toby', confidence: 0.92, surface: oweM[1] });
  }

  // 9. Explicit "remember that <fact>"
  const remM = clean.match(/(?:remember\s+that|note\s+that|keep\s+in\s+mind\s+that)\s+([^.!?]+)/i);
  if (remM) {
    push('fact', remM[1].trim(), { role: 'verified_note', subject: primaryPerson || 'Luka', confidence: 0.94, surface: remM[1] });
  }

  // Fuse & deduplicate preserving role / subject / span metadata
  const byKey = new Map();
  for (const c of claims) {
    const key = `${c.kind}:${c.value.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, c);
      continue;
    }
    const prevScore = (prev.provenance === 'deterministic_resolved' ? 1 : 0) * 100 + prev.confidence;
    const nextScore = (c.provenance === 'deterministic_resolved' ? 1 : 0) * 100 + c.confidence;
    const win = nextScore > prevScore ? c : prev;
    const lose = nextScore > prevScore ? prev : c;
    byKey.set(key, {
      ...win,
      role: win.role ?? lose.role,
      subject: win.subject ?? lose.subject,
      surfaceSpan: win.surfaceSpan ?? lose.surfaceSpan,
      qualifiers: win.qualifiers ?? lose.qualifiers,
    });
  }
  return Array.from(byKey.values());
}

/* ----------------------------------------- Sovereign Trellis Memory Engine */

export class TrellisEngine {
  constructor() {
    this.entities = [];
    this.commits = [];
    this.skills = [];
    this.candidates = [];
    this.experiences = [];
    this.workingState = {
      objective: 'Natural upper-body embodiment, speech interaction & Kameyoko tracking',
      knownState: [
        { fact: 'Luka head dome is obsidian black with active OLED visor', verified: true },
        { fact: 'Upper body skinned in live AgiBot A2 Ultra pearl-white and gunmetal', verified: true },
      ],
      unresolvedBlockers: [],
      activeEntityNames: ['Luka', 'Toby', 'Steadwell'],
      lastUpdated: Date.now(),
    };
    this.indexTerms = new Map(); // term -> Set<commitHash>
    this.indexEntities = new Map(); // lowerName -> Set<commitHash>
    this.cachedSegments = new Set(); // TIC-1 warm segment hashes
    this.lastCompiled = null;
    this.listeners = new Set();
    this._syncTimer = null;

    this._loadLocal();
    if (!this.commits.length) this._seedGenesis();
    this._rebuildIndex();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) {
      try { fn(this.getSnapshot()); } catch { /* ignore subscriber errors */ }
    }
  }

  _seedGenesis() {
    this.entities = JSON.parse(JSON.stringify(SEED_ENTITIES));
    this.skills = JSON.parse(JSON.stringify(SEED_SKILLS));
    this.recordCommit({
      operation: 'GENESIS',
      actor: 'Luka Trellis Boot',
      targetNodes: this.entities.map((e) => e.name),
      message: 'Initialized sovereign Trellis TRP-1 graph for Luka Upper-Body Sim',
      isCheckpoint: true,
    });
  }

  _loadLocal() {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.entities) && parsed.entities.length) this.entities = parsed.entities;
      if (Array.isArray(parsed.commits)) this.commits = parsed.commits;
      if (Array.isArray(parsed.skills) && parsed.skills.length) this.skills = parsed.skills;
      if (Array.isArray(parsed.candidates)) this.candidates = parsed.candidates;
      if (Array.isArray(parsed.experiences)) this.experiences = parsed.experiences;
      if (parsed.workingState) this.workingState = { ...this.workingState, ...parsed.workingState };
    } catch (err) {
      console.warn('[trellis] local load warning:', err);
    }
  }

  async hydrateFromDisk(baseUrl = '') {
    try {
      const res = await fetch(`${baseUrl}/sim-api/trellis/state`, { cache: 'no-store' });
      if (!res.ok) return false;
      const { data } = await res.json();
      if (!data || !Array.isArray(data.commits)) return false;
      // Prefer whichever store has more TRP-1 commits
      if (data.commits.length > this.commits.length) {
        this.entities = data.entities?.length ? data.entities : this.entities;
        this.commits = data.commits;
        this.skills = data.skills?.length ? data.skills : this.skills;
        this.candidates = data.candidates || [];
        this.experiences = data.experiences || [];
        if (data.workingState) this.workingState = { ...this.workingState, ...data.workingState };
        this._rebuildIndex();
        this._persistLocal();
        this._emit();
        return true;
      }
    } catch {
      /* offline or static mode */
    }
    return false;
  }

  _persistLocal() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        entities: this.entities,
        commits: this.commits.slice(0, 1500),
        skills: this.skills,
        candidates: this.candidates,
        experiences: this.experiences.slice(-400),
        workingState: this.workingState,
      }));
    } catch {
      /* quota exceeded */
    }
    if (typeof fetch === 'function') {
      clearTimeout(this._syncTimer);
      this._syncTimer = setTimeout(() => {
        fetch('/sim-api/trellis/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entities: this.entities,
            commits: this.commits.slice(0, 2000),
            skills: this.skills,
            candidates: this.candidates,
            experiences: this.experiences.slice(-500),
            workingState: this.workingState,
          }),
        }).catch(() => {});
      }, 600);
    }
  }

  /* ------------------------------------------------------------- TRP-1 WAL */

  recordCommit({ operation, actor = 'Luka Trellis', targetNodes = [], message, payload = null, branch = 'main', isCheckpoint = false }) {
    const parent = this.commits[0]?.commitHash || null;
    const timestamp = Date.now();
    const seed = `${parent || 'ROOT'}:${branch}:${timestamp}:${operation}:${message}:${targetNodes.join(',')}:${JSON.stringify(payload || {})}`;
    const commitHash = cyrb128(seed);
    const checkpoint = isCheckpoint || (this.commits.length > 0 && this.commits.length % 15 === 0);

    const commit = {
      commitHash,
      parentCommitHash: parent,
      branch,
      timestamp,
      operation,
      actor,
      targetNodes,
      message,
      payload,
      isCheckpoint: checkpoint,
      entityCount: this.entities.length,
      skillCount: this.skills.length,
    };

    this.commits.unshift(commit);
    this._indexCommit(commit);
    this._persistLocal();
    this._emit();
    return commit;
  }

  _indexCommit(commit) {
    const tokens = `${commit.operation} ${commit.message} ${(commit.targetNodes || []).join(' ')}`
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((w) => w.length >= 3);
    for (const tok of tokens) {
      if (!this.indexTerms.has(tok)) this.indexTerms.set(tok, new Set());
      this.indexTerms.get(tok).add(commit.commitHash);
    }
    for (const node of commit.targetNodes || []) {
      const k = node.toLowerCase();
      if (!this.indexEntities.has(k)) this.indexEntities.set(k, new Set());
      this.indexEntities.get(k).add(commit.commitHash);
    }
  }

  _rebuildIndex() {
    this.indexTerms.clear();
    this.indexEntities.clear();
    for (const c of this.commits) this._indexCommit(c);
  }

  /* --------------------------------------------------- Graph & Turn Ingest */

  upsertEntity(name, type = 'person', patch = {}) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    let ent = this.entities.find((e) => e.name.toLowerCase() === clean.toLowerCase());
    if (!ent) {
      ent = {
        id: `ent-${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 5)}`,
        name: clean,
        type,
        roleOrField: patch.roleOrField || '',
        location: patch.location || '',
        notes: [],
        edgeLabels: {},
        openLoops: [],
        trustState: 'verified',
        updatedAt: Date.now(),
      };
      this.entities.push(ent);
    }
    if (patch.roleOrField && !ent.roleOrField) ent.roleOrField = patch.roleOrField;
    if (patch.location) ent.location = patch.location;
    if (patch.note && !ent.notes.includes(patch.note)) ent.notes.push(patch.note);
    if (patch.openLoop && !ent.openLoops.includes(patch.openLoop)) ent.openLoops.push(patch.openLoop);
    if (patch.edgeTarget && patch.edgeLabel) {
      ent.edgeLabels[patch.edgeTarget] = patch.edgeLabel;
    }
    ent.updatedAt = Date.now();
    if (!this.workingState.activeEntityNames.includes(ent.name)) {
      this.workingState.activeEntityNames = [...this.workingState.activeEntityNames.slice(-7), ent.name];
    }
    return ent;
  }

  /** Ingest a user/Luka conversational turn, extract grounded claims, update graph & WAL. */
  ingestTurn(userText, assistantReply = '', meta = {}) {
    const claims = extractClaimsSync(userText, this.entities);
    const touched = new Set();

    const primary = claims.find((c) => c.kind === 'person')?.value || 'Toby';

    for (const c of claims) {
      if (c.kind === 'person') {
        this.upsertEntity(c.value, 'person', { roleOrField: c.role === 'operator' ? 'Operator' : '' });
        touched.add(c.value);
      } else if (c.kind === 'organization') {
        const subj = c.subject || primary;
        this.upsertEntity(c.value, 'organization', { edgeTarget: subj, edgeLabel: 'includes' });
        this.upsertEntity(subj, 'person', { edgeTarget: c.value, edgeLabel: c.role || 'affiliated with' });
        touched.add(c.value);
        touched.add(subj);
      } else if (c.kind === 'location') {
        const subj = c.subject || primary;
        this.upsertEntity(c.value, 'location');
        this.upsertEntity(subj, 'person', { location: c.value, edgeTarget: c.value, edgeLabel: c.role || 'based in' });
        touched.add(c.value);
        touched.add(subj);
      } else if (c.kind === 'project') {
        const subj = c.subject || primary;
        this.upsertEntity(c.value, 'project', { edgeTarget: subj, edgeLabel: 'built by' });
        this.upsertEntity(subj, 'person', { edgeTarget: c.value, edgeLabel: c.role || 'working on' });
        touched.add(c.value);
        touched.add(subj);
      } else if (c.kind === 'commitment') {
        const subj = c.subject || primary;
        this.upsertEntity(subj, 'person', { openLoop: c.value });
        if (!this.workingState.unresolvedBlockers.includes(c.value)) {
          this.workingState.unresolvedBlockers = [...this.workingState.unresolvedBlockers.slice(-5), c.value];
        }
        touched.add(subj);
      } else if (c.kind === 'fact' || c.kind === 'url') {
        const subj = c.subject || primary;
        this.upsertEntity(subj, 'person', { note: c.value });
        this.workingState.knownState = [
          ...this.workingState.knownState.filter((k) => k.fact !== c.value).slice(-9),
          { fact: c.value, verified: true },
        ];
        touched.add(subj);
      }
    }

    const touchedArr = Array.from(touched);
    if (claims.length > 0) {
      this.recordCommit({
        operation: 'NODE_EDIT',
        actor: 'Trellis Claim Extractor',
        targetNodes: touchedArr,
        message: `Anchored ${claims.length} claim(s): ${claims.map((c) => `${c.kind}:${c.value}`).slice(0, 3).join(', ')}`,
        payload: { claims, sourceText: userText.slice(0, 240) },
      });
    }

    const epCommit = this.recordCommit({
      operation: 'EPISODE_COMMIT',
      actor: 'Luka Conversation',
      targetNodes: touchedArr.length ? touchedArr : ['Luka'],
      message: `Turn: "${userText.slice(0, 72)}" → "${String(assistantReply).slice(0, 72)}"`,
      payload: { userText: userText.slice(0, 400), assistantReply: String(assistantReply).slice(0, 400), gesture: meta.gesture || null },
    });

    return { claims, commit: epCommit };
  }

  /** Record a Kameyoko camera / gesture sensor observation with provenance. */
  recordObservation(label, details = {}) {
    const commit = this.recordCommit({
      operation: 'SENSOR_OBSERVATION',
      actor: 'Kameyoko Vision Sensor',
      targetNodes: ['Luka', 'Toby'],
      message: `Observed ${label}`,
      payload: details,
    });
    this.workingState.knownState = [
      ...this.workingState.knownState.filter((k) => !k.fact.startsWith('Latest visual pose:')).slice(-9),
      { fact: `Latest visual pose: ${label}`, verified: true, evidenceHash: commit.commitHash },
    ];
    this.workingState.lastUpdated = Date.now();
    return commit;
  }

  /* ------------------------------------- TVP-1 Unbounded Context Compiler */

  /**
   * Compile a strictly token-budgeted context package from an arbitrarily large
   * Trellis graph & TRP-1 WAL history using progressive resolution knapsack optimization.
   */
  compileContextPackage({ currentPrompt = '', recentMessages = [], tokenBudget = 1600 } = {}) {
    const outputReserve = Math.min(350, Math.round(tokenBudget * 0.2));
    const usableBudget = Math.max(400, tokenBudget - outputReserve);
    const wmBudget = Math.round(usableBudget * 0.22);
    const memoryBudget = Math.round(usableBudget * 0.52);
    const dialogueBudget = Math.max(120, usableBudget - wmBudget - memoryBudget);

    const promptLower = currentPrompt.toLowerCase();
    const promptTerms = promptLower.split(/[^a-z0-9_-]+/).filter((w) => w.length >= 3);

    // 1. Build Hot Working Memory block
    let wmBlock = `[HOT WORKING MEMORY]\nObjective: ${this.workingState.objective}\n`;
    if (this.workingState.knownState.length) {
      wmBlock += 'Verified State:\n' + this.workingState.knownState.slice(-5).map((k) => `  - ${k.fact}`).join('\n') + '\n';
    }
    if (this.workingState.unresolvedBlockers.length) {
      wmBlock += 'Open Commitments:\n' + this.workingState.unresolvedBlockers.slice(-4).map((b) => `  - ${b}`).join('\n') + '\n';
    }

    // 2. Gather memory candidates across Entities, Skills, and TRP-1 Evidence
    const candidates = [];

    // 2a. Semantic Graph Entities
    for (const ent of this.entities) {
      const nameLower = ent.name.toLowerCase();
      const mentioned = promptLower.includes(nameLower);
      const active = this.workingState.activeEntityNames.some((a) => a.toLowerCase() === nameLower);
      const edges = Object.entries(ent.edgeLabels || {}).map(([tgt, rel]) => `${rel} ${tgt}`);
      const termHits = promptTerms.filter((t) =>
        `${ent.name} ${ent.roleOrField} ${ent.location} ${(ent.notes || []).join(' ')} ${edges.join(' ')}`.toLowerCase().includes(t),
      ).length;

      const relevance = (mentioned ? 5.0 : 0) + (active ? 2.4 : 0.8) + termHits * 1.4 + (ent.openLoops?.length ? 1.0 : 0);
      const l0 = `- ${ent.name} (${ent.type})`;
      const l1 = `- [${ent.type.toUpperCase()}] ${ent.name}${ent.roleOrField ? ` — ${ent.roleOrField}` : ''}${ent.location ? ` (${ent.location})` : ''}${edges.length ? ` | Links: ${edges.slice(0, 3).join(', ')}` : ''}`;
      const l2 = `${l1}${ent.notes?.length ? ` | Notes: ${ent.notes.slice(-2).join('; ')}` : ''}${ent.openLoops?.length ? ` | Open loops: ${ent.openLoops.slice(-2).join('; ')}` : ''}`;

      const uri = `trellis://entity/${ent.id}`;
      const isWarm = this.cachedSegments.has(uri);
      candidates.push({
        uri,
        type: 'entity',
        relevance,
        isWarm,
        reps: {
          level0: { level: 'level0', text: l0, tokens: estimateTokens(l0) },
          level1: { level: 'level1', text: l1, tokens: estimateTokens(l1) },
          level2: { level: 'level2', text: l2, tokens: estimateTokens(l2) },
        },
      });
    }

    // 2b. Experiential & Emergent Embodied Skills
    for (const sk of this.skills) {
      const triggerHits = (sk.triggerPhrases || []).filter((p) => promptLower.includes(p.toLowerCase())).length;
      const termHits = promptTerms.filter((t) => `${sk.name} ${sk.description}`.toLowerCase().includes(t)).length;
      const relevance = 2.2 + triggerHits * 3.8 + termHits * 1.2 + (sk.source === 'emergent' ? 1.4 : 0);
      const l0 = `- ${sk.name} (${sk.source}): ${sk.description}`;
      const l1 = `- Skill ${sk.name}@v${sk.version} [${sk.source}${sk.gesture ? ` · gesture:${sk.gesture}` : ''}]: ${sk.description} Triggers: ${(sk.triggerPhrases || []).join(', ')}`;
      const uri = `trellis://skill/${sk.name}`;
      candidates.push({
        uri,
        type: 'skill',
        relevance,
        isWarm: this.cachedSegments.has(uri),
        reps: {
          level0: { level: 'level0', text: l0, tokens: estimateTokens(l0) },
          level1: { level: 'level1', text: l1, tokens: estimateTokens(l1) },
        },
      });
    }

    // 2c. TMI-1 Indexed TRP-1 Evidence Commits
    const commitScores = new Map();
    for (const tok of promptTerms) {
      const set = this.indexTerms.get(tok);
      if (!set) continue;
      for (const h of set) commitScores.set(h, (commitScores.get(h) || 0) + 1.8);
    }
    for (const act of this.workingState.activeEntityNames) {
      const set = this.indexEntities.get(act.toLowerCase());
      if (!set) continue;
      for (const h of set) commitScores.set(h, (commitScores.get(h) || 0) + 0.9);
    }
    // Always include the latest 4 commits as cool/warm recency candidates
    for (const c of this.commits.slice(0, 4)) {
      commitScores.set(c.commitHash, (commitScores.get(c.commitHash) || 0) + 1.5);
    }

    const commitByHash = new Map(this.commits.map((c) => [c.commitHash, c]));
    const rankedCommits = Array.from(commitScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    for (const [hash, score] of rankedCommits) {
      const c = commitByHash.get(hash);
      if (!c) continue;
      const shortH = hash.slice(0, 14);
      const l0 = `- [${shortH}] ${c.operation}: ${c.message.slice(0, 64)}`;
      const l1 = `- [${shortH}] ${c.operation} (${c.actor}): ${c.message}`;
      const uri = `trellis://commit/${shortH}`;
      candidates.push({
        uri,
        type: 'evidence',
        relevance: score + 1.0,
        isWarm: this.cachedSegments.has(uri),
        reps: {
          level0: { level: 'level0', text: l0, tokens: estimateTokens(l0) },
          level1: { level: 'level1', text: l1, tokens: estimateTokens(l1) },
        },
      });
    }

    // 3. TVP-1 Cache-Aware Marginal Utility Knapsack Optimization
    const chosen = new Map(); // uri -> 'none' | 'level0' | 'level1' | 'level2'
    for (const c of candidates) chosen.set(c.uri, 'none');

    let usedMemTokens = 0;
    let cachedTokensSaved = 0;
    let improved = true;

    while (improved && usedMemTokens < memoryBudget) {
      improved = false;
      let best = null;
      for (const c of candidates) {
        const cur = chosen.get(c.uri);
        const nextLevels = cur === 'none'
          ? ['level0', 'level1'].filter((l) => c.reps[l])
          : cur === 'level0'
            ? ['level1', 'level2'].filter((l) => c.reps[l])
            : cur === 'level1'
              ? ['level2'].filter((l) => c.reps[l])
              : [];
        const curCost = cur === 'none' ? 0 : c.reps[cur].tokens;
        for (const lvl of nextLevels) {
          const rep = c.reps[lvl];
          const deltaCost = rep.tokens - curCost;
          if (deltaCost <= 0 || usedMemTokens + deltaCost > memoryBudget) continue;
          const mult = lvl === 'level2' ? 1.55 : lvl === 'level1' ? 1.28 : 1.0;
          const effCompute = Math.max(1, c.isWarm ? deltaCost * 0.12 : deltaCost);
          const utilGain = c.relevance * mult + (c.isWarm ? 0.6 : 0);
          const density = utilGain / effCompute;
          if (!best || density > best.density) {
            best = { candidate: c, level: lvl, deltaCost, density };
          }
        }
      }
      if (best) {
        chosen.set(best.candidate.uri, best.level);
        usedMemTokens += best.deltaCost;
        if (best.candidate.isWarm) cachedTokensSaved += best.deltaCost;
        improved = true;
      }
    }

    const attributedItems = [];
    for (const c of candidates) {
      const lvl = chosen.get(c.uri);
      if (!lvl || lvl === 'none') continue;
      const rep = c.reps[lvl];
      this.cachedSegments.add(c.uri);
      attributedItems.push({
        sourceRef: c.uri,
        type: c.type,
        resolution: lvl,
        tokens: rep.tokens,
        relevance: Number(c.relevance.toFixed(2)),
        text: rep.text,
      });
    }

    const entityBlock = attributedItems.filter((i) => i.type === 'entity').map((i) => i.text).join('\n');
    const skillBlock = attributedItems.filter((i) => i.type === 'skill').map((i) => i.text).join('\n');
    const evidenceBlock = attributedItems.filter((i) => i.type === 'evidence').map((i) => i.text).join('\n');

    // Trim recent dialogue inside dialogueBudget
    const trimmedMsgs = [];
    let dlgTokens = 0;
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const line = `${recentMessages[i].role.toUpperCase()}: ${recentMessages[i].content}`;
      const tok = estimateTokens(line);
      if (dlgTokens + tok > dialogueBudget && trimmedMsgs.length > 0) break;
      trimmedMsgs.unshift(line);
      dlgTokens += tok;
    }

    let assembledContextText = [
      wmBlock.trim(),
      entityBlock ? `[SEMANTIC GRAPH NODES]\n${entityBlock}` : '',
      skillBlock ? `[EXPERIENTIAL & EMERGENT SKILLS]\n${skillBlock}` : '',
      evidenceBlock ? `[TRP-1 EVIDENCE LOG]\n${evidenceBlock}` : '',
      trimmedMsgs.length ? `[RECENT DIALOGUE]\n${trimmedMsgs.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    let estimatedTokensUsed = estimateTokens(assembledContextText);
    if (estimatedTokensUsed > usableBudget) {
      assembledContextText = assembledContextText.slice(0, Math.floor(usableBudget * 3.3));
      estimatedTokensUsed = estimateTokens(assembledContextText);
    }

    const fingerprint = cyrb128(`${assembledContextText}:${this.commits[0]?.commitHash || 'empty'}`);
    const hitRate = Math.min(1, Number((cachedTokensSaved / Math.max(1, estimatedTokensUsed)).toFixed(2)));

    const pkg = {
      tokenBudget,
      usableBudget,
      estimatedTokensUsed,
      isGuaranteedFit: estimatedTokensUsed <= usableBudget,
      fingerprint,
      kvCacheMatch: {
        matchedTokens: cachedTokensSaved,
        hitRate,
        prefillSavedMs: Math.round(cachedTokensSaved * 1.6),
      },
      temperatureSummary: {
        hot: this.workingState.knownState.length + this.workingState.unresolvedBlockers.length,
        warm: attributedItems.length,
        cool: this.entities.length + this.skills.length,
        cold: this.commits.length,
      },
      attributedItems,
      assembledContextText,
      summary: `I have ${this.entities.length} entities, ${this.skills.length} skills, and ${this.commits.length} immutable TRP-1 commits indexed in Trellis.`,
    };
    this.lastCompiled = pkg;
    this._emit();
    return pkg;
  }

  /* --------------------------------------- Emergent Capability Discovery */

  /** Record capability executions and automatically propose composed emergent skills. */
  recordCapabilitySequence(prompt, capabilityNames = []) {
    const seq = capabilityNames.filter(Boolean);
    if (!seq.length) return;
    const now = Date.now();
    for (const cap of seq) {
      this.experiences.push({ prompt: prompt.slice(0, 80), capability: cap, timestamp: now, success: true });
      const sk = this.skills.find((s) => s.name === cap);
      if (sk) {
        sk.totalRuns = (sk.totalRuns || 0) + 1;
        sk.successfulRuns = (sk.successfulRuns || 0) + 1;
        sk.confidenceScore = Number((((sk.successfulRuns + 1) / (sk.totalRuns + 2))).toFixed(2));
      }
    }

    // Multi-capability sequence composition -> propose Emergent Capability candidate
    if (seq.length >= 2) {
      const uniq = seq.filter((c, i) => i === 0 || c !== seq[i - 1]);
      if (uniq.length >= 2) {
        const candId = `cand-${uniq.join('-to-')}`;
        const existingSkill = this.skills.some((s) => s.id === `emergent-${candId}`);
        if (!existingSkill) {
          let cand = this.candidates.find((c) => c.id === candId);
          if (cand) {
            cand.occurrences += 1;
            cand.lastSeenAt = now;
            if (!cand.samplePrompts.includes(prompt) && cand.samplePrompts.length < 4) {
              cand.samplePrompts.push(prompt);
            }
          } else {
            const label = uniq.map((s) => titleCase(s.replace(/_/g, ' '))).join(' → ');
            this.candidates.unshift({
              id: candId,
              name: `emergent_${uniq.join('_')}`,
              label,
              description: `Emergent composed capability chaining ${uniq.join(' → ')}.`,
              composedFrom: uniq,
              samplePrompts: [prompt],
              occurrences: 1,
              firstSeenAt: now,
              lastSeenAt: now,
            });
          }
        }
      }
    }
    this._persistLocal();
    this._emit();
  }

  /** Promote an emergent candidate onto main in the TRP-1 WAL. */
  approveCandidate(candidateId) {
    const idx = this.candidates.findIndex((c) => c.id === candidateId);
    if (idx < 0) return null;
    const cand = this.candidates[idx];
    this.candidates.splice(idx, 1);

    const lastCap = cand.composedFrom[cand.composedFrom.length - 1];
    const lastSkill = this.skills.find((s) => s.name === lastCap);

    const skill = {
      id: `emergent-${cand.id}`,
      name: cand.name,
      version: 1,
      source: 'emergent',
      gesture: lastSkill?.gesture || 'explain',
      description: cand.description,
      triggerPhrases: cand.samplePrompts.map((p) => p.toLowerCase().slice(0, 40)),
      procedureSteps: cand.composedFrom.map((c, i) => `Step ${i + 1}: Execute ${c}`),
      composedFrom: cand.composedFrom,
      confidenceScore: 0.9,
      successfulRuns: cand.occurrences,
      totalRuns: cand.occurrences,
    };
    this.skills.push(skill);
    this.recordCommit({
      operation: 'SKILL_MERGE',
      actor: 'Emergent Capability Gatekeeper',
      targetNodes: [skill.name],
      message: `Promoted emergent capability "${skill.name}" (${cand.composedFrom.join(' → ')})`,
      payload: skill,
    });
    return skill;
  }

  dismissCandidate(candidateId) {
    this.candidates = this.candidates.filter((c) => c.id !== candidateId);
    this._persistLocal();
    this._emit();
  }

  /**
   * Teach Luka a brand-new Emergent Embodied Skill from a live captured upper-body
   * pose (via Kameyoko camera tracking or manual sliders) + voice trigger phrases!
   */
  registerTaughtSkill({ name, description, triggerPhrases = [], poseSnapshot }) {
    const slug = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
    if (!slug) throw new Error('Skill name is required');
    const triggers = (Array.isArray(triggerPhrases) ? triggerPhrases : String(triggerPhrases || '').split(','))
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!triggers.length) triggers.push(slug.replace(/_/g, ' '));

    const existingIdx = this.skills.findIndex((s) => s.name === slug);
    const version = existingIdx >= 0 ? (this.skills[existingIdx].version || 1) + 1 : 1;

    const skill = {
      id: existingIdx >= 0 ? this.skills[existingIdx].id : `emergent-pose-${slug}-${Date.now()}`,
      name: slug,
      version,
      source: 'emergent',
      gesture: null,
      poseSnapshot,
      description: description?.trim() || `Taught upper-body & hand skill "${slug.replace(/_/g, ' ')}"`,
      triggerPhrases: triggers,
      procedureSteps: [
        `Match voice trigger (${triggers.join(' / ')})`,
        'Interpolate upper-body 16-DOF shoulder, elbow, wrist & neck pose',
        'Apply 10-finger RH56 articulation snapshot',
      ],
      confidenceScore: 0.95,
      successfulRuns: 1,
      totalRuns: 1,
    };

    if (existingIdx >= 0) this.skills[existingIdx] = skill;
    else this.skills.unshift(skill);

    this.recordCommit({
      operation: 'SKILL_MERGE',
      actor: 'Operator Teach-by-Pose',
      targetNodes: [skill.name, 'Luka'],
      message: `Taught emergent embodied skill "${skill.name}" v${skill.version} (triggers: ${triggers.join(', ')})`,
      payload: skill,
    });
    return skill;
  }

  findMatchingSkill(text) {
    const lower = String(text || '').toLowerCase();
    for (const sk of this.skills) {
      if ((sk.triggerPhrases || []).some((p) => p && lower.includes(p.toLowerCase()))) {
        return sk;
      }
    }
    return null;
  }

  getSkillByName(name) {
    if (!name) return null;
    const clean = name.toLowerCase().trim();
    return this.skills.find((s) => s.name.toLowerCase() === clean) || null;
  }

  getSnapshot() {
    return {
      entities: this.entities,
      commits: this.commits,
      skills: this.skills,
      candidates: this.candidates,
      workingState: this.workingState,
      lastCompiled: this.lastCompiled,
    };
  }
}
