'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const BYTES_PER_GIB = 1024 ** 3;
const DEFAULT_MIN_FREE_DISK_GB = 12;
const DEFAULT_DISK_PATH = '/var/lib/docker';
const LOCAL_MODEL_NAME_PATTERN =
  /(?:^|-)rag-(embedding|reranker|vision)(?:-|$)/;

function parseArgs(argv) {
  const args = { report: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--report') {
      args.report = true;
      continue;
    }
    if (value === '--json') {
      args.json = true;
      continue;
    }
    if (value === '--min-free-disk-gb' || value === '--disk-path') {
      const nextValue = argv[index + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        throw new Error(`${value} requires a value.`);
      }
      args[value.slice(2).replaceAll('-', '_')] = nextValue;
      index += 1;
      continue;
    }
    if (
      value.startsWith('--min-free-disk-gb=') ||
      value.startsWith('--disk-path=')
    ) {
      const [name, inlineValue] = value.slice(2).split('=', 2);
      args[name.replaceAll('-', '_')] = inlineValue;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function parseFiniteNumber(value, name, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a finite number >= ${minimum}.`);
  }
  return parsed;
}

function parseDfOutput(output) {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    throw new Error('df returned no filesystem row.');
  }

  const fields = lines.at(-1).trim().split(/\s+/);
  if (fields.length < 6) {
    throw new Error(`Could not parse df output: ${lines.at(-1)}`);
  }

  const usagePercent = Number.parseInt(fields[4].replace('%', ''), 10);
  const totalBytes = Number(fields[1]) * 1024;
  const usedBytes = Number(fields[2]) * 1024;
  const freeBytes = Number(fields[3]) * 1024;
  if (
    !Number.isFinite(usagePercent) ||
    ![totalBytes, usedBytes, freeBytes].every(Number.isFinite)
  ) {
    throw new Error(`Could not parse numeric df output: ${lines.at(-1)}`);
  }

  return {
    filesystem: fields[0],
    totalBytes,
    usedBytes,
    freeBytes,
    usagePercent,
    mountpoint: fields.slice(5).join(' '),
  };
}

function parseMeminfo(contents) {
  const values = new Map();
  for (const line of String(contents).split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s+(\d+)(?:\s+(\w+))?$/);
    if (!match) continue;
    const [, name, rawValue, unit] = match;
    const multiplier = unit === 'kB' ? 1024 : 1;
    values.set(name, Number(rawValue) * multiplier);
  }

  const totalBytes = values.get('MemTotal');
  const availableBytes = values.get('MemAvailable');
  if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes)) {
    throw new Error('/proc/meminfo is missing MemTotal or MemAvailable.');
  }

  return {
    totalBytes,
    availableBytes,
    usedBytes: totalBytes - availableBytes,
    swapTotalBytes: values.get('SwapTotal') ?? null,
    swapFreeBytes: values.get('SwapFree') ?? null,
  };
}

function parseRunningModelContainers(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...statusParts] = line.split(/\s+/);
      return { name, status: statusParts.join(' ') };
    })
    .filter(({ name }) => LOCAL_MODEL_NAME_PATTERN.test(name));
}

function parseModelVolumeSizes(output) {
  const result = {};
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(
      /^(\S*rag_(embedding|reranker|vision)_cache\S*)\s+\S+\s+(\S+)$/,
    );
    if (!match) continue;
    result[match[2]] = { name: match[1], size: match[3] };
  }
  return result;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'UNKNOWN';
  if (bytes >= BYTES_PER_GIB)
    return `${(bytes / BYTES_PER_GIB).toFixed(2)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readDiskUsage(diskPath, command = runCommand) {
  return parseDfOutput(command('df', ['-Pk', diskPath]));
}

function readMemoryUsage(fileReader = fs.readFileSync) {
  return parseMeminfo(fileReader('/proc/meminfo', 'utf8'));
}

function readRunningModelContainers(command = runCommand) {
  try {
    return {
      available: true,
      containers: parseRunningModelContainers(
        command('docker', ['ps', '--format', '{{.Names}}\\t{{.Status}}']),
      ),
    };
  } catch (error) {
    return {
      available: false,
      containers: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assessCapacity({ disk, memory, docker, minFreeDiskGb }) {
  const minimumFreeDiskBytes = minFreeDiskGb * BYTES_PER_GIB;
  const diskPass = disk.freeBytes >= minimumFreeDiskBytes;
  const dockerPass = docker.available;
  return {
    diskPass,
    dockerPass,
    allowed: diskPass && dockerPass,
    reasons: [
      ...(diskPass ? [] : [`free disk is below ${minFreeDiskGb} GiB`]),
      ...(dockerPass ? [] : ['Docker status could not be inspected']),
    ],
  };
}

function collectDockerReport(command = runCommand, stat = fs.statSync) {
  const report = {
    systemDf: 'UNAVAILABLE',
    modelVolumes: {},
    containerLogs: { totalBytes: 0, files: [], unavailable: false },
  };

  try {
    report.systemDf = command('docker', ['system', 'df']);
    report.modelVolumes = parseModelVolumeSizes(
      command('docker', ['system', 'df', '-v']),
    );
  } catch {
    report.systemDf = 'UNAVAILABLE';
  }

  try {
    const containerIds = command('docker', ['ps', '-aq'])
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (containerIds.length > 0) {
      const logRows = command('docker', [
        'inspect',
        '--format',
        '{{.Name}}\\t{{.LogPath}}',
        ...containerIds,
      ]);
      for (const row of logRows.split(/\r?\n/).filter(Boolean)) {
        const [rawName, logPath] = row.split(/\t/, 2);
        try {
          const bytes = stat(logPath).size;
          report.containerLogs.totalBytes += bytes;
          report.containerLogs.files.push({
            name: rawName.replace(/^\//, ''),
            bytes,
          });
        } catch {
          report.containerLogs.unavailable = true;
        }
      }
    }
  } catch {
    report.containerLogs.unavailable = true;
  }

  return report;
}

function readConfig(args, env = process.env) {
  const minFreeDiskGb = parseFiniteNumber(
    args.min_free_disk_gb ??
      env.LOCAL_AI_MIN_FREE_DISK_GB ??
      DEFAULT_MIN_FREE_DISK_GB,
    'MIN_FREE_DISK_GB',
  );
  const diskPath =
    args.disk_path ?? env.LOCAL_AI_DISK_PATH ?? DEFAULT_DISK_PATH;
  if (typeof diskPath !== 'string' || !diskPath.trim()) {
    throw new Error('LOCAL_AI_DISK_PATH must be a non-empty path.');
  }
  return { minFreeDiskGb, diskPath };
}

function buildReport({ config, disk, memory, docker, capacity, dockerReport }) {
  return {
    localAiStartAllowed: capacity.allowed ? 'YES' : 'NO',
    capacityReasons: capacity.reasons,
    diskPath: config.diskPath,
    minimumFreeDiskGb: config.minFreeDiskGb,
    disk: {
      totalBytes: disk.totalBytes,
      usedBytes: disk.usedBytes,
      freeBytes: disk.freeBytes,
      usagePercent: disk.usagePercent,
      freeGiB: disk.freeBytes / BYTES_PER_GIB,
    },
    memory: {
      totalBytes: memory.totalBytes,
      usedBytes: memory.usedBytes,
      availableBytes: memory.availableBytes,
      availableGiB: memory.availableBytes / BYTES_PER_GIB,
      swapTotalBytes: memory.swapTotalBytes,
      swapFreeBytes: memory.swapFreeBytes,
    },
    runningLocalModels: docker.containers,
    dockerAvailable: docker.available,
    dockerError: docker.error ?? null,
    dockerReport,
  };
}

function printHumanReport(report) {
  const { disk, memory, dockerReport } = report;
  console.log(`LOCAL_AI_START_ALLOWED=${report.localAiStartAllowed}`);
  console.log(
    `LOCAL_AI_START_REASONS=${report.capacityReasons.join('; ') || 'none'}`,
  );
  console.log(`LOCAL_AI_DISK_PATH=${report.diskPath}`);
  console.log(`MIN_FREE_DISK_GB=${report.minimumFreeDiskGb}`);
  console.log(`DISK_TOTAL=${formatBytes(disk.totalBytes)}`);
  console.log(`DISK_USED=${formatBytes(disk.usedBytes)}`);
  console.log(`DISK_FREE=${formatBytes(disk.freeBytes)}`);
  console.log(`DISK_USAGE_PERCENT=${disk.usagePercent}`);
  console.log(`RAM_TOTAL=${formatBytes(memory.totalBytes)}`);
  console.log(`RAM_USED=${formatBytes(memory.usedBytes)}`);
  console.log(`RAM_AVAILABLE=${formatBytes(memory.availableBytes)}`);
  console.log(`SWAP_TOTAL=${formatBytes(memory.swapTotalBytes)}`);
  console.log(`SWAP_FREE=${formatBytes(memory.swapFreeBytes)}`);
  console.log(
    `RUNNING_LOCAL_MODELS=${report.runningLocalModels.map(({ name }) => name).join(',') || 'none'}`,
  );
  console.log(`DOCKER_AVAILABLE=${report.dockerAvailable ? 'YES' : 'NO'}`);
  console.log('DOCKER_SYSTEM_DF_START');
  console.log(dockerReport.systemDf);
  console.log('DOCKER_SYSTEM_DF_END');
  console.log(
    `MODEL_VOLUME_SIZES=${JSON.stringify(dockerReport.modelVolumes)}`,
  );
  console.log(`CONTAINER_LOG_BYTES=${dockerReport.containerLogs.totalBytes}`);
  console.log(
    `CONTAINER_LOG_REPORT=${dockerReport.containerLogs.unavailable ? 'PARTIAL' : 'COMPLETE'}`,
  );
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const config = readConfig(args, dependencies.env ?? process.env);
  const command = dependencies.command ?? runCommand;
  const disk = readDiskUsage(config.diskPath, command);
  const memory = readMemoryUsage(dependencies.fileReader ?? fs.readFileSync);
  const docker = readRunningModelContainers(command);
  const capacity = assessCapacity({
    disk,
    memory,
    docker,
    minFreeDiskGb: config.minFreeDiskGb,
  });
  const dockerReport = collectDockerReport(
    command,
    dependencies.stat ?? fs.statSync,
  );
  const report = buildReport({
    config,
    disk,
    memory,
    docker,
    capacity,
    dockerReport,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  if (!args.report && !capacity.allowed) process.exitCode = 1;
  return report;
}

module.exports = {
  assessCapacity,
  buildReport,
  collectDockerReport,
  parseArgs,
  parseDfOutput,
  parseMeminfo,
  parseModelVolumeSizes,
  parseRunningModelContainers,
  readConfig,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `Local AI capacity check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
