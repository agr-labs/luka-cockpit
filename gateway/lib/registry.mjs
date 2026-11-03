// Robot registry.
//
// Adapters are loaded by name from ./adapters. A robot that fails to start is
// kept in the registry as `offline` rather than removed: "the adapter did not
// come up" and "the robot is not configured" are different facts, and the
// console should be able to show which one is true.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { notFound } from './errors.mjs';
import { CAPABILITIES } from './contract.mjs';
import { modesFor } from './safety.mjs';

import * as simulator from '../adapters/simulator.mjs';
import * as aimdk from '../adapters/aimdk.mjs';
import * as ros2 from '../adapters/ros2.mjs';

export const ADAPTERS = { simulator, aimdk, ros2 };

const DEFAULT_CONFIG = fileURLToPath(new URL('../config/robots.json', import.meta.url));

export async function loadConfig(path = process.env.GATEWAY_CONFIG ?? DEFAULT_CONFIG) {
  const raw = await readFile(path, 'utf8');
  const config = JSON.parse(raw);
  if (!config || !Array.isArray(config.robots)) throw new Error(`${path}: missing robots[]`);
  for (const robot of config.robots) {
    if (!robot.id || typeof robot.id !== 'string') throw new Error(`${path}: every robot needs a string id`);
    if (!ADAPTERS[robot.adapter]) throw new Error(`${path}: robot "${robot.id}" names unknown adapter "${robot.adapter}"`);
  }
  return { ...config, path };
}

export class Registry {
  constructor(config, { physicalEnabled = false, emit = () => {} } = {}) {
    this.config = config;
    this.physicalEnabled = physicalEnabled;
    this.emit = emit;
    this.robots = new Map();
    this.startupErrors = [];

    for (const robotConfig of config.robots) {
      if (robotConfig.enabled === false) continue;
      const mod = ADAPTERS[robotConfig.adapter];
      let adapter;
      try {
        adapter = mod.create({ config: robotConfig, emit: (kind, payload) => emit(robotConfig.id, kind, payload) });
      } catch (err) {
        this.startupErrors.push({ robotId: robotConfig.id, error: String(err?.message ?? err) });
        continue;
      }
      this.robots.set(robotConfig.id, {
        id: robotConfig.id,
        label: robotConfig.label ?? robotConfig.id,
        adapterName: robotConfig.adapter,
        kind: adapter.kind,
        physical: Boolean(robotConfig.physical),
        configuration: robotConfig.configuration ?? 'suspended',
        profile: normalizeProfile(robotConfig),
        lidar: robotConfig.lidar ?? null,
        notes: robotConfig.notes ?? null,
        adapter,
        started: false,
        startError: null,
      });
    }
  }

  start() {
    for (const robot of this.robots.values()) {
      try {
        robot.adapter.start();
        robot.started = true;
      } catch (err) {
        robot.startError = String(err?.message ?? err);
        this.startupErrors.push({ robotId: robot.id, error: robot.startError });
      }
    }
  }

  stop() {
    for (const robot of this.robots.values()) {
      try { robot.adapter.stop(); } catch { /* best effort on shutdown */ }
    }
  }

  get(id) {
    const robot = this.robots.get(id);
    if (!robot) throw notFound(`unknown robot "${id}"`, { known: [...this.robots.keys()] });
    return robot;
  }

  has(id) {
    return this.robots.has(id);
  }

  list() {
    return [...this.robots.values()];
  }

  /** Live online flag, read from the adapter rather than stored. */
  status(robot) {
    try {
      return robot.adapter.status();
    } catch (err) {
      return { online: false, health: 'unknown', detail: String(err?.message ?? err) };
    }
  }

  /**
   * The merged capability view for one robot: the contract ceiling intersected
   * with what the adapter admits, plus the modes that are actually reachable.
   */
  capabilityView(robot, capabilityId) {
    const cap = CAPABILITIES[capabilityId];
    if (!cap) return null;
    const adapterCap = robot.adapter.capabilities?.()[capabilityId] ?? null;
    const status = this.status(robot);
    const lock = (robot.profile?.locks ?? []).find((l) => l.capability === cap.id) ?? null;
    const observable = Boolean(cap.observable && adapterCap?.observable && status.online);
    const commandable = Boolean(cap.commandable && adapterCap?.commandable && status.online && !lock);
    // Advertise only modes that are reachable right now: an offline robot has no
    // observable mode, and a locked capability has no command mode.
    const modes = modesFor({ robot, capability: cap, adapterCap, physicalEnabled: this.physicalEnabled })
      .filter((mode) => (mode === 'observe' ? observable : commandable));
    return {
      capability: cap.id,
      group: cap.group,
      label: cap.label,
      summary: cap.summary,
      observable,
      commandable,
      physical: cap.physical,
      readOnly: Boolean(cap.readOnly),
      requires: cap.requires,
      supported: observable || commandable,
      modes,
      locked: Boolean(lock),
      lockReason: lock?.reason ?? null,
      reason: lock?.reason ?? reasonFor({ status, adapterCap, cap, observable, commandable, modes }),
      limits: cap.limits ?? null,
      schema: cap.schema ?? null,
    };
  }

  capabilityList(robot) {
    return Object.keys(CAPABILITIES).map((id) => this.capabilityView(robot, id));
  }

  /** Compact per-robot summary used by GET /robots and the console. */
  describe(robot) {
    const status = this.status(robot);
    const caps = this.capabilityList(robot);
    return {
      robotId: robot.id,
      label: robot.label,
      adapter: robot.adapterName,
      kind: robot.kind,
      physical: robot.physical,
      configuration: robot.configuration,
      online: status.online,
      health: status.health,
      detail: status.detail ?? null,
      notes: robot.notes,
      lidar: robot.lidar,
      profile: {
        name: robot.profile.name,
        label: robot.profile.label,
        suspension: robot.profile.suspension,
        feet: robot.profile.feet,
        rig: robot.profile.rig,
        locomotion: robot.profile.locomotion,
        armControl: robot.profile.armControl,
        motionSchema: robot.profile.motionSchema,
        controller: robot.profile.controller,
        locks: robot.profile.locks.map((l) => l.capability),
      },
      capabilities: {
        total: caps.length,
        observable: caps.filter((c) => c.observable).length,
        commandable: caps.filter((c) => c.commandable).length,
      },
    };
  }
}

function reasonFor({ status, adapterCap, cap, observable, commandable, modes }) {
  if (!status.online) return status.detail ?? 'robot offline';
  if (!adapterCap) return 'adapter does not implement this capability';
  if (!cap.observable && !cap.commandable) return 'not part of the contract';
  if (!cap.commandable) return cap.readOnly ? 'read-only capability' : 'not commandable on this adapter';
  if (adapterCap.commandable) return adapterCap.reason ?? null;
  if (observable) return adapterCap.reason ?? 'observable only';
  if (modes.length === 0) return adapterCap.reason ?? 'no usable mode';
  return adapterCap.reason ?? null;
}

/**
 * Profiles are policy, not hardware. A profile can lock capabilities, and those
 * locks are enforced before the adapter has any say. `locks` accepts strings or
 * objects so a config can be terse without losing the reason in refusals.
 */
function normalizeProfile(robotConfig) {
  const p = robotConfig.profile ?? {};
  const name = p.name ?? 'default';
  const locks = (Array.isArray(p.locks) ? p.locks : [])
    .map((entry) => (typeof entry === 'string'
      ? { capability: entry, reason: `locked by profile "${name}"` }
      : { capability: entry?.capability, reason: entry?.reason ?? `locked by profile "${name}"` }))
    .filter((l) => typeof l.capability === 'string');
  return {
    name,
    label: p.label ?? 'Default profile',
    suspension: p.suspension ?? null,
    feet: p.feet ?? null,
    rig: p.rig ?? null,
    locomotion: p.locomotion ?? null,
    armControl: p.armControl ?? null,
    motionSchema: p.motionSchema ?? null,
    controller: p.controller ?? null,
    notes: p.notes ?? null,
    locks,
  };
}
