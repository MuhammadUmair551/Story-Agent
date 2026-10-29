import { metrics, type ObservableResult } from "@opentelemetry/api";
import { performance } from "node:perf_hooks";

const meter = metrics.getMeter("story-agent-api.runtime");
let previousCpu = process.cpuUsage();
let previousTime = performance.now();
let previousEventLoop = performance.eventLoopUtilization();

meter.createObservableGauge("nodejs.memory.heap.used", { unit: "By", description: "Node.js heap used." })
  .addCallback((result: ObservableResult) => { result.observe(process.memoryUsage().heapUsed); });
meter.createObservableGauge("nodejs.memory.rss", { unit: "By", description: "Node.js resident set size." })
  .addCallback((result: ObservableResult) => { result.observe(process.memoryUsage().rss); });
meter.createObservableGauge("nodejs.event_loop.utilization", { unit: "1", description: "Event loop utilization since previous collection." })
  .addCallback((result: ObservableResult) => {
    const current = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(current, previousEventLoop);
    previousEventLoop = current;
    result.observe(delta.utilization);
  });
meter.createObservableGauge("nodejs.process.cpu.utilization", { unit: "1", description: "Process CPU utilization since previous collection." })
  .addCallback((result: ObservableResult) => {
    const current = process.cpuUsage();
    const elapsedMicros = (performance.now() - previousTime) * 1_000;
    const cpuMicros = current.user + current.system - previousCpu.user - previousCpu.system;
    previousCpu = current;
    previousTime = performance.now();
    result.observe(elapsedMicros > 0 ? Math.min(cpuMicros / elapsedMicros, 1) : 0);
  });
