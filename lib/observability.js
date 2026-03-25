import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { getNodeMode, getObservabilityConfig, isSelfHosted } from '@/lib/runtime-config';
import { getPublicNodeState } from '@/lib/self-hosted-node';

const counters = globalThis.__streamchainMetricsCounters || new Map();
globalThis.__streamchainMetricsCounters = counters;

export function incrementCounter(name, labels = {}, value = 1) {
  const key = `${name}:${JSON.stringify(labels)}`;
  const entry = counters.get(key) || { name, labels, value: 0 };
  entry.value += value;
  counters.set(key, entry);
}


export function getRequestId(request, { createIfMissing = true } = {}) {
  const forwardedRequestId = request?.headers?.get?.('x-request-id')
    || request?.headers?.get?.('x-correlation-id')
    || request?.headers?.get?.('x-streamchain-request-id')
    || '';
  const normalized = String(forwardedRequestId || '').trim();
  if (normalized) {
    return normalized;
  }

  return createIfMissing ? randomUUID() : null;
}

export function getRequestLogContext(request, fields = {}) {
  return {
    requestId: getRequestId(request),
    route: request?.nextUrl?.pathname || (request?.url ? new URL(request.url).pathname : null),
    ...fields,
  };
}

export function logEvent(level, event, fields = {}) {
  const config = getObservabilityConfig();
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    service: config.serviceName,
    mode: getNodeMode(),
    ...fields,
  };

  if (config.structuredLogs) {
    const method = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
    method(JSON.stringify(payload));
    return;
  }

  console.log(`[streamchain:${level}] ${event}`, fields);
}

function renderMetric(name, help, type, samples) {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const sample of samples) {
    const labelEntries = Object.entries(sample.labels || {});
    const suffix = labelEntries.length > 0
      ? `{${labelEntries.map(([key, value]) => `${key}="${String(value).replace(/"/g, '\\"')}"`).join(',')}}`
      : '';
    lines.push(`${name}${suffix} ${sample.value}`);
  }
  return lines.join('\n');
}

export async function renderPrometheusMetrics() {
  const config = getObservabilityConfig();
  const samples = [];

  for (const entry of counters.values()) {
    samples.push(renderMetric(entry.name, `${entry.name} counter`, 'counter', [{ labels: entry.labels, value: entry.value }]));
  }

  samples.push(renderMetric('streamchain_process_uptime_seconds', 'Node.js process uptime', 'gauge', [{ value: Math.floor(process.uptime()) }]));
  samples.push(renderMetric('streamchain_process_resident_memory_bytes', 'Resident memory bytes', 'gauge', [{ value: process.memoryUsage().rss }]));
  samples.push(renderMetric('streamchain_host_loadavg', 'Host load average', 'gauge', os.loadavg().map((value, index) => ({ labels: { window: String(index + 1) }, value }))));

  if (config.metricsEnabled && isSelfHosted()) {
    const state = await getPublicNodeState();
    samples.push(renderMetric('streamchain_chain_height', 'Current chain height', 'gauge', [{ value: state.chain?.length || 0 }]));
    samples.push(renderMetric('streamchain_wallet_count', 'Wallet count', 'gauge', [{ value: state.wallets?.length || 0 }]));
    samples.push(renderMetric('streamchain_peer_registry_count', 'Peer registry count', 'gauge', [{ value: state.peerRegistry?.length || 0 }]));
    samples.push(renderMetric('streamchain_pending_video_count', 'Pending moderation count', 'gauge', [{ value: state.pendingVideos?.length || 0 }]));
    samples.push(renderMetric('streamchain_featured_video_count', 'Approved media count', 'gauge', [{ value: state.featuredVideos?.length || 0 }]));
  }

  return `${samples.join('\n')}\n`;
}
