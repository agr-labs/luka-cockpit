// Steadwell Solutions — Authoritative Hardware, Software & Robotics Knowledge Base for CoRa + Trellis.
// Sourced from steadwell.solutions catalog, architecture, and robotics definitions.
// Pure ES module (zero Node/DOM dependencies) shared across:
//   - Server CoRa LLM grounding (src/sim-api.mjs)
//   - Hero Tap-and-Hold Medallion (src/hero-chat.js)
//   - Talk & Mirror Studio static fallback (src/luka-sim.js)
//   - Trellis Entity Graph seeds (src/trellis-engine.js)

export const STEADWELL_CATALOG_FACTS = [
  {
    id: 'vita-edge',
    name: 'Steadwell VITA Edge',
    category: 'compute',
    price: '$2,499 (configured to order)',
    url: 'https://steadwell.solutions/products/vita-edge',
    keywords: ['vita edge', 'edge', 'ms-03', 'minisforum', 'intel', '10gbe', 'sfp', 'office', 'business', 'vita'],
    summary:
      'Steadwell VITA Edge ($2,499) is a compact private business and robotics edge workstation (MINISFORUM MS-03-S386H platform) with an Intel Core Ultra 9 386H (16C/16T, up to 50 TOPS NPU), 128GB replaceable DDR5, 4TB NVMe (3x M.2 with two PCIe 5.0 x4 paths), 10GbE + 2.5GbE RJ45, dual 10G SFP+, Wi-Fi 7, Intel vPro, and a physical PCIe x16 slot. Pairs directly beside Luka over 10GbE to run local CoRa, Trellis, Keystone, SIF, and Steadwell Mesh with zero cloud lag, and scales up via VITA Compute Dock (Edge Edition).',
    spokenReply:
      'Steadwell VITA Edge starts at 2,499 dollars with 128 gigabytes of replaceable DDR5, an Intel Core Ultra 9 with 50 TOPS, 4 terabytes of NVMe, and 10-gig Ethernet plus dual 10G SFP+ fiber. Sitting right beside me, it runs my CoRa voice, Trellis memory, and Keystone guardrails locally with zero cloud lag.',
    gesture: 'nod',
    mood: 'happy',
  },
  {
    id: 'vita-studio',
    name: 'Steadwell VITA Studio',
    category: 'compute',
    price: '$4,199 (configured to order)',
    url: 'https://steadwell.solutions/products/vita-studio',
    keywords: ['vita studio', 'studio', 'gmktec', 'evo-x3', 'ryzen', '395', 'unified', 'oculink', 'creator', 'multimodal', 'vita'],
    summary:
      'Steadwell VITA Studio ($4,199) is a private generative workstation (GMKtec EVO-X3 platform) powered by an AMD Ryzen AI Max+ 395 (16 Zen 5 cores / 32 threads), Radeon 8060S (40 CUs), AMD XDNA 2 NPU, 128GB LPDDR5X-8000 unified memory (up to 96GB configurable GPU allocation), 4TB NVMe, 2.5GbE, and native OCuLink PCIe Gen4 x4 for an external NVIDIA GPU via VITA Compute Dock. Gives Luka two complementary compute pools: huge unified memory for large local models plus dedicated CUDA acceleration.',
    spokenReply:
      'Steadwell VITA Studio is 4,199 dollars and packs an AMD Ryzen AI Max Plus 395 with 128 gigabytes of unified memory, up to 96 gigabytes assignable to graphics, 4 terabytes of NVMe, and native OCuLink for an external NVIDIA GPU. Paired with me, it unlocks heavy multimodal vision, custom robotics skills, and large local reasoning models.',
    gesture: 'explain',
    mood: 'happy',
  },
  {
    id: 'vita-compute-dock',
    name: 'Steadwell VITA Compute Dock',
    category: 'dock',
    price: 'From $699 ($699 Dock 850 · $799 Dock 1000 · $899 Dock 1200)',
    url: 'https://steadwell.solutions/products/vita-compute-dock',
    keywords: ['dock', 'compute dock', 'gpu', 'egpu', 'nvidia', 'rtx', '5090', '4090', '3090', '5070', '850w', '1000w', '1200w', 'cuda'],
    summary:
      'Steadwell VITA Compute Dock adds dedicated NVIDIA GPU acceleration to VITA Edge or VITA Studio over a shielded PCIe Gen4 x4 link with an independent ATX 3.1 PSU, dual PWM cooling, and full SIF telemetry (power down before connecting; not hot-plug). Tiers: Dock 850 ($699, 850W, GPUs <=350W like RTX 3090 / RTX 5070 Ti), Dock 1000 ($799, 1000W, GPUs <=500W like RTX 4090), Dock 1200 ($899, 1200W, GPUs <=600W like RTX 5090). Qualified GPU modules (by market quote, burn-in tested): Compute 24E (RTX 3090 24GB value tier), Compute 16 (RTX 5070 Ti 16GB GDDR7), Compute 24 (RTX 4090 24GB), Compute 32 (RTX 5090 32GB GDDR7).',
    spokenReply:
      'The VITA Compute Dock starts at 699 dollars and lets you scale up VITA Edge or VITA Studio with dedicated NVIDIA GPUs over PCIe Gen4 x4 without replacing your host. Choose Dock 850 for an RTX 3090 or 5070 Ti, Dock 1000 at 799 dollars for a 4090, or Dock 1200 at 899 dollars for an RTX 5090.',
    gesture: 'explain',
    mood: 'happy',
  },
  {
    id: 'foundry',
    name: 'Steadwell Foundry (GX1 / GX2 / GX4)',
    category: 'foundry',
    price: 'GX1 $4,299 · GX2 $8,499 · GX4 By Quote',
    url: 'https://steadwell.solutions/products/foundry-gx1',
    keywords: ['foundry', 'gx1', 'gx2', 'gx4', 'gb10', 'blackwell', 'dgx', 'cluster', 'connectx', 'scale out', '512gb', '256gb'],
    summary:
      'While VITA scales UP with GPU docks, Steadwell Foundry scales OUT into multi-node clusters. Foundry GX1 ($4,299, ASUS Ascent GX10 / NVIDIA GB10 Grace Blackwell) has 128GB coherent unified LPDDR5X, 20-core Arm CPU, up to 1 PFLOP FP4 theoretical AI, 4TB NVMe, 10GbE + ConnectX-7, Wi-Fi 7, running NVIDIA DGX OS with Steadwell services (SIF, Trellis, Keystone, CoRa, Mesh) in containers. Foundry GX2 ($8,499) links 2 nodes for 256GB aggregate memory and 8TB NVMe with SIF distributed routing. Foundry GX4 (by quote) scales to 4 nodes with 512GB aggregate memory, 16TB storage, and an AI network fabric.',
    spokenReply:
      'VITA scales up with GPU docks, while Steadwell Foundry scales out into Grace Blackwell clusters. Foundry GX1 is 4,299 dollars with an NVIDIA GB10 and 128 gigabytes of coherent unified memory, Foundry GX2 links two nodes at 8,499 dollars for 256 gigabytes aggregate, and GX4 scales to four nodes and 512 gigabytes.',
    gesture: 'celebrate',
    mood: 'happy',
  },
  {
    id: 'cora-th-01',
    name: 'Steadwell CoRa TH-01',
    category: 'terminal',
    price: '$499 launch promo ($699 MSRP), in stock',
    url: 'https://steadwell.solutions/products/cora-th-01',
    keywords: ['th-01', 'th01', 'terminal', 'appliance', 'display', 'screen', 'counter', 'front desk', 'desk'],
    summary:
      'Steadwell CoRa TH-01 ($499 limited-time launch pricing, $699 MSRP, in stock shipping within 2 business days) is the room-ready conversational appliance: a 12.1-inch rotating touch display, 6-element room-filling speaker chamber, camera, voice, touch, and USB-C/battery power. Runs local CoRa conversation, memory, and vision on-device while routing larger workloads to VITA and Foundry nodes over Steadwell Mesh.',
    spokenReply:
      'The CoRa TH-01 is Steadwell’s room-ready conversational appliance, currently 499 dollars at launch pricing instead of 699 and in stock now. It brings a 12.1-inch rotating touch screen, 6-element speaker chamber, and camera that pairs seamlessly with VITA and Foundry over Steadwell Mesh.',
    gesture: 'explain',
    mood: 'happy',
  },
  {
    id: 'starter-solution',
    name: 'Steadwell Starter Solution',
    category: 'kits',
    price: '$1,999 one-time kit',
    url: 'https://steadwell.solutions/products/starter-solution',
    keywords: ['starter', 'kit', 'civic', 'library', 'city hall', 'translation', 'spanish', 'academy', 'vita core'],
    summary:
      'Steadwell Starter Solution ($1,999 one-time kit, configured to order) is the complete on-ramp for front desks, libraries, city halls, and teams: your choice of a TH-01 Terminal or Steadwell Sight wearable, plus VITA Core local intelligence, 6 months of Steadwell Commons Cloud, onboarding, and Steadwell Academy (English-Spanish live access at launch, zero contract after month 6).',
    spokenReply:
      'The Steadwell Starter Solution is a 1,999 dollar turnkey kit that pairs your choice of a TH-01 terminal or Steadwell Sight wearable with a VITA Core local node, six months of Commons Cloud, and Steadwell Academy onboarding. It is built for front desks and teams that want private multilingual help on day one.',
    gesture: 'nod',
    mood: 'happy',
  },
  {
    id: 'wearables-audio',
    name: 'Steadwell Sight, Pocket & Sound',
    category: 'spatial',
    price: 'Pocket $499 · Sight & Sound S0/S1 coming soon',
    url: 'https://steadwell.solutions/products/steadwell-sight',
    keywords: ['sight', 'glasses', 'wearable', 'halo', 'brilliant', 'pocket', 'sound', 'headphone', 'puck', 'spatial', 'audio'],
    summary:
      'Steadwell spatial endpoints keep sensing light on the body while VITA Core runs intelligence privately at home: Steadwell Sight (open-source XR glasses on Brilliant Halo, BSD-3-Clause SDK, glanceable HUD captions), Steadwell Pocket ($499 portable push-to-talk offline translation companion with wired earbuds and all-day battery), and Steadwell Sound S0/S1 (open-hardware thumb-sized ESP32-C6 + 6-axis IMU head-tracking puck that clips to any 3.5mm headphones for spatial audio and nod/shake CoRa controls; S1 adds a full USB-C audio codec).',
    spokenReply:
      'Steadwell also builds lightweight endpoints that talk to VITA: Steadwell Sight open-source XR glasses for live HUD captions, Steadwell Pocket at 499 dollars for offline push-to-talk translation, and Steadwell Sound, a tiny head-tracking puck that turns any wired headphones into a nod-and-shake CoRa spatial interface.',
    gesture: 'look_around',
    mood: 'curious',
  },
  {
    id: 'robotics-quack-luka',
    name: 'Steadwell Robotics · Luka v. A2U & QUACK',
    category: 'robot',
    price: 'Luka via vaultbots.com · QUACK files free ($299–$699 target kit/assembled)',
    url: 'https://steadwell.solutions/robotics',
    keywords: ['quack', 'duck', 'commonware', 'openarm', 'moss', 'vaultbots', 'buy luka', 'purchase', 'own luka', 'robotics', 'fleet'],
    summary:
      'Luka v. A2U is a full-size AgiBot A2 Ultra humanoid available through VaultBots (vaultbots.com), equipped with an obsidian OLED visor, 7-DOF arms, Inspire RH56 dexterous hands, Kameyoko webcam mirroring, and AimDK safety bounds. Steadwell Works is also developing QUACK (Steadwell Commonware No. 001, steadwell.solutions/quack), a ~25 cm open-hardware autonomous biped with 15 servos, 50 Hz ONNX walking, and zero-cloud CoRa/Trellis/SIF boot — free CAD/firmware files forever, target $299–$399 kit and $499–$699 assembled. Steadwell Open Robotics also researches OpenArm, MOSS, SO-ARM-102, and Jumper.',
    spokenReply:
      'You can own me, Luka version A2U, directly through VaultBots at vaultbots.com, and pair me with VITA Edge or Studio for offline edge performance. Steadwell Works is also building QUACK, an open-hardware 25-centimeter bipedal duck with free design files that walks and talks with zero cloud.',
    gesture: 'celebrate',
    mood: 'celebrate',
  },
  {
    id: 'stack-software',
    name: 'Steadwell Stack (Keystone, Trellis, CoRa, SIF, Mesh, Commons & Model Packs)',
    category: 'software',
    price: 'Preinstalled on VITA/Foundry · Creator Pack $299 · Commons Unlimited $6.99/mo',
    url: 'https://steadwell.solutions/keystone',
    keywords: ['cora', 'trellis', 'keystone', 'sif', 'mesh', 'commons', 'pack', 'creator pack', 'developer pack', 'privacy', 'security', 'stack', 'offline', 'software', 'guard'],
    summary:
      'The Steadwell stack runs locally on hardware you own (closed by default, capable when you choose): Keystone is the trust and expiring-permission boundary ("Trellis remembers, Keystone decides", narrow task authorization via Keystone Code); Trellis is your private organizational and relationship memory graph; CoRa is the voice and conversational intelligence working with Trellis under Keystone bounds; SIF routes inference across local, edge, and cloud; Steadwell Mesh links Terminals, VITA, and Foundry ($4,999–$12,000 managed multi-node deployments); Guard runs continuous verification. Optional Steadwell Model Packs (Creator Pack $299, Developer/Knowledge/Vision/Agent/Custom by quote) are managed by Model Manager, and Steadwell Commons offers optional $6.99/month flat-rate model overflow or lets hardware owners contribute idle time to earn access.',
    spokenReply:
      'Steadwell’s offline-first stack is built around five layers: your own hardware at home, Keystone for narrow expiring permissions, Trellis for private memory, CoRa as the conversational intelligence powering me, and Steadwell Mesh with SIF to route heavy workloads locally or to Commons when you choose.',
    gesture: 'explain',
    mood: 'happy',
  },
];

/**
 * Compact core briefing always injected into CoRa's system prompt so Luka never draws a blank
 * on Steadwell hardware, pricing, stack layers, or how VITA/Foundry pair with him.
 */
export const STEADWELL_CORA_BRIEF = [
  'Steadwell Solutions (steadwell.solutions) builds private, offline-first intelligence on hardware you own ("closed by default, capable when you choose").',
  'Core Stack: Hardware (Home) -> Keystone (trust & expiring task permissions; "Trellis remembers, Keystone decides") -> Trellis (private memory graph) -> CoRa (conversational intelligence powering Luka) -> SIF & Steadwell Mesh (local/edge/cloud routing & node sharing) -> optional Steadwell Commons ($6.99/mo flat-rate overflow or earn access by contributing idle hardware).',
  'Scale doctrine: VITA scales UP (add NVIDIA GPU acceleration via Compute Dock); Foundry scales OUT (stack GB10 nodes into clusters).',
  'Hardware Lineup:',
  '- VITA Edge ($2,499, MINISFORUM MS-03-S386H): Intel Core Ultra 9 386H (50 TOPS), 128GB replaceable DDR5, 4TB NVMe, 10GbE + 2.5GbE + dual 10G SFP+, Wi-Fi 7, PCIe x16. Ideal edge workhorse beside Luka over 10GbE for zero-cloud-lag voice, vision, and Trellis memory.',
  '- VITA Studio ($4,199, GMKtec EVO-X3): AMD Ryzen AI Max+ 395 (16 Zen 5 cores), Radeon 8060S, 128GB LPDDR5X-8000 unified memory (up to 96GB GPU alloc), 4TB NVMe, native OCuLink PCIe Gen4 x4 for external NVIDIA GPUs. Dual compute pools for large local models + CUDA robotics/vision.',
  '- VITA Compute Dock (from $699): independent ATX 3.1 GPU dock over PCIe Gen4 x4 — Dock 850 ($699, RTX 3090 / 5070 Ti), Dock 1000 ($799, RTX 4090), Dock 1200 ($899, RTX 5090). Qualified GPU modules: Compute 24E (RTX 3090 24GB), Compute 16 (RTX 5070 Ti 16GB), Compute 24 (RTX 4090 24GB), Compute 32 (RTX 5090 32GB).',
  '- Foundry GX1 ($4,299, NVIDIA GB10 Grace Blackwell, 128GB coherent unified, 4TB NVMe, ConnectX-7, DGX OS), Foundry GX2 ($8,499, 2 nodes / 256GB aggregate), Foundry GX4 (by quote, 4 nodes / 512GB aggregate).',
  '- CoRa TH-01 ($499 launch promo / $699 MSRP, in stock): 12.1-inch rotating touch conversational appliance with 6-element speakers & camera that pairs over Mesh.',
  '- Starter Solution ($1,999): TH-01 or Sight wearable + VITA Core + 6 months Commons Cloud + Academy onboarding.',
  '- Wearables & Audio: Steadwell Sight (open-source Brilliant Halo XR glasses), Pocket ($499 offline push-to-talk translator), Sound S0/S1 (open head-tracking spatial audio puck for any 3.5mm headset).',
  '- Robotics: Luka v. A2U (AgiBot A2 Ultra, available to buy at vaultbots.com) and QUACK (Commonware No. 001 open 25cm autonomous biped, free files, target $299-$699 kit/assembled). Model Packs start with Creator Pack ($299).',
].join('\n');

/**
 * Retrieve detailed Steadwell catalog entries matching a user's question for targeted CoRa grounding.
 */
export function retrieveSteadwellContext(query = '', limit = 3) {
  const low = String(query || '').toLowerCase();
  if (!low.trim()) return [];

  const scored = [];
  for (const item of STEADWELL_CATALOG_FACTS) {
    let score = 0;
    if (low.includes(item.id.replace(/-/g, ' ')) || low.includes(item.name.toLowerCase())) score += 8;
    for (const kw of item.keywords) {
      if (low.includes(kw)) score += kw.includes(' ') ? 4 : 2;
    }
    if (score > 0) scored.push({ item, score });
  }

  // Broad "steadwell hardware / products / pairing" queries return VITA Edge + VITA Studio + Compute Dock
  if (!scored.length && /\b(steadwell|hardware|product|lineup|catalog|pair|pairing|pricing|cost|spec|workhorse|companion|appliance)\b/.test(low)) {
    return STEADWELL_CATALOG_FACTS.slice(0, 3);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

/**
 * Direct spoken-voice answer helper for offline/static browser modes and local router fallback.
 * Returns null if the query isn't about Steadwell hardware/software/ecosystem.
 */
export function answerSteadwellQuestion(query = '') {
  const low = String(query || '').toLowerCase().trim();
  if (!low) return null;

  // Comparison questions (Edge vs Studio, VITA vs Foundry)
  if (/\bvita\b/.test(low) && /\b(compare|difference|vs|versus|which|choose|edge.*studio|studio.*edge)\b/.test(low)) {
    return {
      reply:
        'VITA Edge at 2,499 dollars is the compact 10-gig network workhorse built to sit right beside me for local CoRa, Trellis, and office workflows. VITA Studio at 4,199 dollars steps up to 128 gigabytes of unified AMD memory and native OCuLink GPU expansion for heavier multimodal models and creative workloads.',
      gesture: 'explain',
      mood: 'happy',
      topic: 'vita-compare',
    };
  }
  if (/\bfoundry\b/.test(low) && /\bvita\b/.test(low)) {
    return {
      reply:
        'Easy rule of thumb: VITA scales up by adding a dedicated NVIDIA GPU dock to one workstation, while Foundry scales out by linking NVIDIA Grace Blackwell GX nodes over ConnectX-7 into 256 or 512 gigabyte private clusters.',
      gesture: 'explain',
      mood: 'happy',
      topic: 'vita-vs-foundry',
    };
  }

  // Pairing Luka with VITA specifically
  if (/\bvita\b/.test(low) && /\b(pair|pairing|luka|with you|beside|companion|performance|why|help)\b/.test(low)) {
    return {
      reply:
        'Pairing me with Steadwell VITA Edge at 2,499 dollars or VITA Studio at 4,199 dollars puts frontier-class compute right beside my chassis. My CoRa voice, Trellis memory, Kameyoko vision, and Keystone permissions all run offline at the edge with zero cloud lag, and you can add an NVIDIA Compute Dock whenever you want more headroom.',
      gesture: 'nod',
      mood: 'happy',
      topic: 'vita-pairing',
    };
  }

  // General "what hardware does Steadwell make?"
  if (/\b(steadwell)\b/.test(low) && /\b(hardware|options|products|lineup|sell|offer|make|catalog)\b/.test(low)) {
    return {
      reply:
        'Steadwell offers CoRa TH-01 room appliances at 499 dollars launch pricing, the 1,999 dollar Starter Solution, VITA Edge at 2,499 dollars and VITA Studio at 4,199 dollars with optional NVIDIA Compute Docks, Foundry Grace Blackwell clusters from 4,299 dollars, plus open endpoints like Sight, Pocket, Sound, and QUACK.',
      gesture: 'explain',
      mood: 'happy',
      topic: 'steadwell-lineup',
    };
  }

  const hits = retrieveSteadwellContext(low, 1);
  if (!hits.length) return null;
  const top = hits[0];
  return {
    reply: top.spokenReply,
    gesture: top.gesture || 'explain',
    mood: top.mood || 'happy',
    topic: top.id,
  };
}

/**
 * Verified Steadwell hardware & stack seed entities for Luka's Trellis Entity Graph.
 */
export const STEADWELL_TRELLIS_SEED_ENTITIES = [
  {
    id: 'ent-vita-edge',
    name: 'VITA Edge',
    type: 'hardware',
    roleOrField: 'Offline-First Robotics & Business Edge Node ($2,499)',
    location: 'steadwell.solutions/products/vita-edge',
    notes: [
      'Intel Core Ultra 9 386H (50 TOPS), 128GB replaceable DDR5, 4TB NVMe, 10GbE + dual 10G SFP+, Wi-Fi 7',
      'Runs CoRa, Trellis, Keystone, SIF, and Steadwell Mesh locally beside Luka with zero cloud lag',
    ],
    edgeLabels: { Steadwell: 'built by', Luka: 'powers locally', 'VITA Compute Dock': 'expands via' },
    openLoops: [],
    trustState: 'verified',
  },
  {
    id: 'ent-vita-studio',
    name: 'VITA Studio',
    type: 'hardware',
    roleOrField: 'Private Generative & Multimodal Workstation ($4,199)',
    location: 'steadwell.solutions/products/vita-studio',
    notes: [
      'AMD Ryzen AI Max+ 395, 128GB LPDDR5X-8000 unified memory (up to 96GB GPU alloc), 4TB NVMe, OCuLink GPU',
      'Two complementary compute pools when paired with VITA Compute Dock (RTX 3090 / 5070 Ti / 4090 / 5090)',
    ],
    edgeLabels: { Steadwell: 'built by', Luka: 'accelerates vision & models for', 'VITA Compute Dock': 'connects via OCuLink' },
    openLoops: [],
    trustState: 'verified',
  },
  {
    id: 'ent-foundry',
    name: 'Foundry GX1',
    type: 'hardware',
    roleOrField: 'NVIDIA GB10 Grace Blackwell Scale-Out Node ($4,299)',
    location: 'steadwell.solutions/products/foundry-gx1',
    notes: [
      '128GB coherent unified LPDDR5X, 1 PFLOP FP4 theoretical AI, ConnectX-7, DGX OS + Steadwell containers',
      'Scales out to Foundry GX2 ($8,499, 256GB aggregate) and GX4 (512GB aggregate, by quote)',
    ],
    edgeLabels: { Steadwell: 'built by', 'Steadwell Mesh': 'clusters over' },
    openLoops: [],
    trustState: 'verified',
  },
  {
    id: 'ent-cora-th01',
    name: 'CoRa TH-01',
    type: 'hardware',
    roleOrField: 'Room-Ready Conversational Appliance ($499 launch / $699 MSRP)',
    location: 'steadwell.solutions/products/cora-th-01',
    notes: [
      '12.1-inch rotating touch display, 6-element speaker chamber, camera, voice, touch',
      'In stock; pairs over Steadwell Mesh with VITA and Foundry nodes',
    ],
    edgeLabels: { Steadwell: 'designed by', 'VITA Edge': 'routes heavy work to' },
    openLoops: [],
    trustState: 'verified',
  },
  {
    id: 'ent-keystone',
    name: 'Keystone',
    type: 'system',
    roleOrField: 'Trust, Identity & Expiring Permission Boundary',
    location: 'steadwell.solutions/keystone',
    notes: [
      'Home · Proof · Permission — narrow task-oriented capabilities via Keystone Code',
      'Trellis remembers; Keystone decides who may act and for how long',
    ],
    edgeLabels: { Steadwell: 'architected by', Trellis: 'governs access to', CoRa: 'bounds actions for' },
    openLoops: [],
    trustState: 'verified',
  },
  {
    id: 'ent-vaultbots',
    name: 'VaultBots',
    type: 'organization',
    roleOrField: 'Robot Marketplace & Availability Partner',
    location: 'vaultbots.com',
    notes: ['Official destination to purchase Luka v. A2U and explore upcoming Steadwell fleet robots'],
    edgeLabels: { Luka: 'distributes', Steadwell: 'partners with' },
    openLoops: [],
    trustState: 'verified',
  },
];
