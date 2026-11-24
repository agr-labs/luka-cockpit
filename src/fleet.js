// Steadwell Robotics Fleet Registry
// Add new robots here as they come online; the Hub roster, switcher, and status
// indicators render automatically from this manifest.

export const VAULTBOTS_URL = 'https://vaultbots.com';
export const STEADWELL_ORIGIN = 'https://steadwell.solutions';

export const VITA_HARDWARE = Object.freeze([
  Object.freeze({
    id: 'vita-edge',
    name: 'Steadwell VITA Edge',
    role: 'Edge Robotics Workhorse',
    price: 'From $2,499',
    href: `${STEADWELL_ORIGIN}/products/vita-edge`,
    summary: 'Compact offline-first edge node running private Trellis memory, local speech, and low-latency robot coordination over 10GbE and Wi-Fi 7.',
    specs: ['128GB DDR5', '10GbE + 2× 10G SFP+', '4TB NVMe', 'Wi-Fi 7'],
  }),
  Object.freeze({
    id: 'vita-studio',
    name: 'Steadwell VITA Studio',
    role: 'Frontier Multimodal Workstation',
    price: 'From $4,199',
    href: `${STEADWELL_ORIGIN}/products/vita-studio`,
    summary: '128GB unified memory with optional dedicated NVIDIA GPU acceleration via OCuLink for frontier local models, vision, and custom skills.',
    specs: ['128GB Unified', 'Ryzen AI Max+ 395', 'OCuLink GPU', '4TB NVMe'],
  }),
]);

export const FLEET_BOTS = Object.freeze([
  Object.freeze({
    id: 'luka',
    name: 'Luka',
    version: 'v. A2U',
    status: 'live', // 'live' | 'beta' | 'soon'
    category: 'Humanoid',
    summary: 'Voice conversation, webcam hand & arm mirroring, and full-body 3D motion explorer.',
    primaryApp: {
      label: 'Talk & Mirror Studio',
      href: './luka-sim.html',
    },
    secondaryApp: {
      label: 'Full-Body Explorer',
      href: './cockpit.html',
    },
    purchaseUrl: VAULTBOTS_URL,
  }),
]);
