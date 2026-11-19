import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadavg } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const [mode, ...args] = process.argv.slice(2);
if (mode === 'serve') {
  const { createApp } = await import('/bot/app.ts');
  const { Store } = await import('/bot/src/storage/store.ts');
  const eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
  const store = new Store(), server = createApp({ store, token: 'benchmark-token' });
  await new Promise(resolve => server.listen(0, resolve));
  console.log(JSON.stringify({ port: server.address().port }));
  process.on('SIGTERM', () => {
    eventLoop.disable();
    const metrics = { cpu: process.cpuUsage(), resources: process.resourceUsage(), event_loop_ms: { p50: eventLoop.percentile(50) / 1e6, p95: eventLoop.percentile(95) / 1e6, p99: eventLoop.percentile(99) / 1e6, max: eventLoop.max / 1e6 } };
    console.log(JSON.stringify({ ...metrics, state: createHash('sha256').update(store.export()).digest('hex') }));
    server.close(); server.closeAllConnections(); process.exit(0);
  });
} else if (mode === 'client') {
  const { runBenchmark } = await import('/suite/bench.ts');
  const result = await runBenchmark({ baseUrl: args[0], token: 'benchmark-token', rounds: 10 });
  console.log(JSON.stringify(result));
} else {
  assert.equal(mode, 'compare', 'Usage: node benchmarks/compare.mjs compare KIT BASELINE CANDIDATE OUTPUT.json');
  assert.equal(args.length, 4);
  const [kit, baseline, candidate, output] = args.map(p => resolve(p));
  const script = fileURLToPath(import.meta.url);
  const image = 'node@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d';
  const network = `fieldforge-bench-${process.pid}`;
  const docker = (...argv) => execFileSync('docker', argv, { encoding: 'utf8', timeout: 180_000 }).trim();
  const limits = ['--cpus', '2', '--memory', '1g', '--memory-swap', '1g', '--pids-limit', '256', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-u', '65534:65534'];
  const clientLimits = ['--cpus', '2', '--memory', '256m', '--memory-swap', '256m', '--pids-limit', '64', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-u', '65534:65534'];
  const runner = ['-v', `${script}:/runner/compare.mjs:ro`];
  const runs = [], host = { started: new Date().toISOString(), load_start: loadavg() };
  const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*p)-1)];
  docker('network', 'create', '--internal', network);
  try {
    // ABBA puts each snapshot before and after the other, with fresh stores for every block.
    for (const [index, label] of ['baseline', 'candidate', 'candidate', 'baseline'].entries()) {
      const hostLoad = loadavg();
      const name = `${network}-${index}`, repo = label === 'baseline' ? baseline : candidate;
      docker('run', '-d', '--name', name, '--network', network, ...limits, ...runner, '-v', `${repo}:/bot:ro`, image, 'node', '/runner/compare.mjs', 'serve');
      try {
        let port;
        for (let n = 0; n < 100; n++) {
          const first = docker('logs', name).split('\n')[0];
          if (first) { port = JSON.parse(first).port; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert(port, 'entry did not bind within startup budget');
        const perf = JSON.parse(docker('run', '--rm', '--network', network, ...clientLimits, ...runner, '-v', `${kit}/program/env/src:/suite:ro`, image, 'node', '/runner/compare.mjs', 'client', `http://${name}:${port}`));
        docker('stop', '-t', '5', name);
        const metrics = JSON.parse(docker('logs', name).split('\n').at(-1));
        for (const w of perf.workloads) { assert.equal(w.error, undefined); assert.equal(w.rounds.length, 10); }
        runs.push({ label, host_load: hostLoad, perf, metrics });
        console.log(label, Object.fromEntries(perf.workloads.map(w => [w.name, w.p50_ms])));
      } finally { docker('rm', '-f', name); }
    }
    assert.equal(new Set(runs.map(r => r.metrics.state)).size, 1, 'baseline/candidate store exports differ');
    const summary = {};
    for (const label of ['baseline', 'candidate']) {
      const blocks = runs.filter(r => r.label === label);
      summary[label] = Object.fromEntries(blocks[0].perf.workloads.map(w => {
        const rounds = blocks.flatMap(r => r.perf.workloads.find(v => v.name === w.name).rounds);
        const median = percentile(rounds, 0.5);
        return [w.name, { median_ms: median, p95_ms: percentile(rounds, 0.95), ops_per_sec: w.ops * 1000 / median, rounds: rounds.length, errors: 0 }];
      }));
    }
    writeFileSync(output, JSON.stringify({ host: { ...host, finished: new Date().toISOString(), load_end: loadavg() }, image, limits, client_limits: clientLimits, order: 'ABBA', runs, summary }, null, 2));
  } finally { docker('network', 'rm', network); }
}
