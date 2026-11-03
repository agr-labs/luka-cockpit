// Append-only audit log, in memory.
//
// Every accepted command, every refusal, every lease and every stop lands here
// before the HTTP response is written. If it is not in the log, it did not
// happen. Ring-buffered at AUDIT_LIMIT entries so a long-running gateway cannot
// exhaust memory; the console shows the tail and `GET /api/v1/audit` serves it.

import { randomUUID } from 'node:crypto';

export const AUDIT_LIMIT = 2000;

export class AuditLog {
  constructor({ limit = AUDIT_LIMIT, now = Date.now, id = randomUUID() } = {}) {
    this.limit = limit;
    this.now = now;
    this.runId = id;
    this.seq = 0;
    this.entries = [];
  }

  record({ actor = 'anonymous', robotId = null, kind, capability = null, outcome, code = null, message = null, commandId = null, detail = null }) {
    const entry = {
      seq: ++this.seq,
      at: new Date(this.now()).toISOString(),
      actor,
      robotId,
      kind,        // 'command' | 'lease' | 'stop' | 'rearm' | 'auth' | 'system'
      capability,
      outcome,     // 'accepted' | 'rejected' | 'applied' | 'failed'
      code,
      message,
      commandId,
      ...(detail ? { detail } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    return entry;
  }

  tail({ limit = 100, robotId = null, kind = null } = {}) {
    let rows = this.entries;
    if (robotId) rows = rows.filter((e) => e.robotId === robotId);
    if (kind) rows = rows.filter((e) => e.kind === kind);
    return rows.slice(-Math.min(Math.max(limit, 1), this.limit)).reverse();
  }
}
