// Steadwell Robotics Fleet Registry
// Add new robots here as they come online; the Hub roster, switcher, and status
// indicators render automatically from this manifest.

export const VAULTBOTS_URL = 'https://vaultbots.com';

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
