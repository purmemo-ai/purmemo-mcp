/**
 * Connection Monitor — tracks active connections, rates, alerts
 * Port of Python connection_monitor.py
 */

import type { ConnectionInfo, ConnectionEvent, ConnectionRate, ConnectionMetrics, ConnectionSummary } from '../types.js';

interface AuthFailureEntry {
  timestamp: number;
  [key: string]: unknown;
}

export class ConnectionMonitor {
  private activeConnections: Map<string, ConnectionInfo>;
  private connectionEvents: ConnectionEvent[];
  private authFailures: AuthFailureEntry[];
  private toolUsage: Map<string, Record<string, number>>;
  public totalConnections: number;
  public successfulConnections: number;
  public failedConnections: number;
  public totalAuthFailures: number;
  private alertThreshold: number;
  private alertsSent: Set<string>;
  private _monitorInterval: ReturnType<typeof setInterval> | null;

  constructor(alertThreshold: number = 100) {
    this.activeConnections = new Map();
    this.connectionEvents = [];
    this.authFailures = [];
    this.toolUsage = new Map();
    this.totalConnections = 0;
    this.successfulConnections = 0;
    this.failedConnections = 0;
    this.totalAuthFailures = 0;
    this.alertThreshold = alertThreshold;
    this.alertsSent = new Set();
    this._monitorInterval = null;
  }

  start(): void {
    this._monitorInterval = setInterval(() => this._checkAlerts(), 30000);
    this._monitorInterval.unref?.();
  }

  stop(): void {
    if (this._monitorInterval) clearInterval(this._monitorInterval);
  }

  trackConnection(connId: string, info: Record<string, unknown> = {}): void {
    this.totalConnections++;
    this.successfulConnections++;
    this.activeConnections.set(connId, {
      ...info,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      toolCalls: {},
      errors: 0
    });
    this._addEvent({ type: 'connect', connId, success: true, timestamp: Date.now() });
    this.toolUsage.set(connId, {});
  }

  trackDisconnection(connId: string): void {
    const conn = this.activeConnections.get(connId);
    if (!conn) return;
    this._addEvent({ type: 'disconnect', connId, duration: Date.now() - conn.connectedAt, timestamp: Date.now() });
    this.activeConnections.delete(connId);
    this.toolUsage.delete(connId);
  }

  trackAuthFailure(info: Record<string, unknown> = {}): void {
    this.totalAuthFailures++;
    this.failedConnections++;
    this.authFailures.push({ ...info, timestamp: Date.now() });
    if (this.authFailures.length > 100) this.authFailures.shift();
    this._addEvent({ type: 'connect', success: false, reason: 'auth_failure', timestamp: Date.now() });
  }

  trackToolCall(connId: string, toolName: string, success: boolean = true): void {
    const conn = this.activeConnections.get(connId);
    if (conn) {
      conn.lastActivity = Date.now();
      conn.toolCalls[toolName] = (conn.toolCalls[toolName] || 0) + 1;
      if (!success) conn.errors++;
    }
    const usage = this.toolUsage.get(connId) || {};
    usage[toolName] = (usage[toolName] || 0) + 1;
    this.toolUsage.set(connId, usage);
  }

  private _addEvent(event: ConnectionEvent): void {
    this.connectionEvents.push(event);
    if (this.connectionEvents.length > 300) this.connectionEvents.shift();
  }

  getConnectionRate(windowSec: number = 300): ConnectionRate {
    const cutoff = Date.now() - windowSec * 1000;
    const events = this.connectionEvents.filter(e => e.timestamp > cutoff);
    const connects = events.filter(e => e.type === 'connect' && e.success).length;
    const failures = events.filter(e => e.type === 'connect' && !e.success).length;
    const disconnects = events.filter(e => e.type === 'disconnect').length;
    const total = connects + failures;
    return {
      window_seconds: windowSec,
      connects,
      failures,
      disconnects,
      success_rate: total > 0 ? Math.round(connects / total * 100) : 100,
      connections_per_minute: Math.round(connects / (windowSec / 60) * 10) / 10
    };
  }

  getMetrics(): ConnectionMetrics {
    const last5min = this.getConnectionRate(300);
    const last1min = this.getConnectionRate(60);
    const recentAuthFailures = this.authFailures.filter(f => f.timestamp > Date.now() - 300000).length;

    return {
      active_connections: this.activeConnections.size,
      total_connections: this.totalConnections,
      successful_connections: this.successfulConnections,
      failed_connections: this.failedConnections,
      connection_rates: { last_1min: last1min, last_5min: last5min },
      auth_failures: {
        total: this.totalAuthFailures,
        last_5min: recentAuthFailures
      },
      alerts: {
        connection_surge: this.activeConnections.size > this.alertThreshold,
        high_failure_rate: last5min.success_rate < 80,
        auth_failure_surge: recentAuthFailures > 10
      }
    };
  }

  getSummary(): ConnectionSummary {
    const rate = this.getConnectionRate(300);
    const conns = Array.from(this.activeConnections.entries()).slice(0, 10).map(([id, c]) => ({
      id: id.substring(0, 8),
      duration_seconds: Math.floor((Date.now() - c.connectedAt) / 1000),
      tool_calls: Object.values(c.toolCalls).reduce<number>((a, b) => a + b, 0),
      errors: c.errors
    }));
    return {
      active: this.activeConnections.size,
      total: this.totalConnections,
      success_rate: rate.success_rate,
      connections: conns
    };
  }

  private _checkAlerts(): void {
    const metrics = this.getMetrics();
    const now = new Date();
    const dayKey = `${now.getFullYear()}${now.getMonth()}${now.getDate()}`;
    const hourKey = `${dayKey}${now.getHours()}`;

    if (metrics.alerts.connection_surge) {
      const key = `surge_${dayKey}`;
      if (!this.alertsSent.has(key)) {
        this.alertsSent.add(key);
        this._log('warning', `Connection surge: ${this.activeConnections.size} active`);
      }
    }
    if (metrics.alerts.high_failure_rate) {
      const key = `failure_${hourKey}`;
      if (!this.alertsSent.has(key)) {
        this.alertsSent.add(key);
        this._log('critical', `High failure rate: ${metrics.connection_rates.last_5min.success_rate}%`);
      }
    }
    if (metrics.alerts.auth_failure_surge) {
      const key = `auth_${hourKey}`;
      if (!this.alertsSent.has(key)) {
        this.alertsSent.add(key);
        this._log('critical', `Auth failure surge: ${metrics.auth_failures.last_5min} in 5min`);
      }
    }
  }

  private _log(severity: 'warning' | 'critical', message: string): void {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: severity === 'critical' ? 'ERROR' : 'WARN',
      message: `[ConnectionMonitor] ${message}`,
      severity,
      metrics: this.getSummary()
    }));
  }
}
