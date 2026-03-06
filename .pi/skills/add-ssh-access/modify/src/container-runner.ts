/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const PI_PROVIDER_SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'GEMINI_API_KEY',
  // Back-compat alias used by this fork's previous setup docs.
  'GOOGLE_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZAI_API_KEY',
  'OPENCODE_API_KEY',
  'HF_TOKEN',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
  'AWS_BEDROCK_SKIP_AUTH',
  'AWS_BEDROCK_FORCE_HTTP1',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
] as const;

function seedPiAuthFiles(groupPiAgentDir: string): void {
  const hostPiDir = path.join(os.homedir(), '.pi', 'agent');
  const files = ['auth.json', 'models.json'];

  for (const file of files) {
    const src = path.join(hostPiDir, file);
    if (!fs.existsSync(src)) continue;

    const dst = path.join(groupPiAgentDir, file);
    try {
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        continue;
      }

      const srcMtime = fs.statSync(src).mtimeMs;
      const dstMtime = fs.statSync(dst).mtimeMs;
      if (srcMtime > dstMtime + 1000) {
        fs.copyFileSync(src, dst);
      }
    } catch (err) {
      logger.warn({ src, dst, err }, 'Failed to seed Pi auth/models file');
    }
  }
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

interface MountBuildResult {
  mounts: VolumeMount[];
  extraEnv: Record<string, string>;
}

interface AllowedSshHost {
  alias: string;
  explicitHostName?: string;
}

interface ParsedSshHost {
  hostName?: string;
  user?: string;
  port?: string;
  proxyJump?: string;
}

function readSshEnvConfig(): Record<string, string> {
  return readEnvFile([
    'SSH_ALLOWED_HOSTS',
    'SSH_DEFAULT_USER',
    'SSH_DEFAULT_PORT',
    'SSH_KNOWN_HOSTS_PATH',
    'SSH_CONFIG_PATH',
  ]);
}

function parseAllowedSshHosts(group: RegisteredGroup): AllowedSshHost[] {
  const configured = group.containerConfig?.sshAllowedHosts;
  const fromGroup = Array.isArray(configured) && configured.length > 0;
  const envConfig = readSshEnvConfig();
  const rawList = fromGroup
    ? configured
    : (process.env.SSH_ALLOWED_HOSTS || envConfig.SSH_ALLOWED_HOSTS || '')
        .split(',');

  const parsed: AllowedSshHost[] = [];
  for (const raw of rawList) {
    const token = raw.trim();
    if (!token) continue;

    const [aliasRaw, hostNameRaw] = token.includes('=')
      ? token.split('=', 2)
      : [token, ''];

    const alias = aliasRaw.trim();
    const explicitHostName = hostNameRaw.trim() || undefined;

    if (!alias) continue;
    if (alias.includes('*') || alias.includes('?')) {
      continue;
    }
    if (
      explicitHostName &&
      (explicitHostName.includes('*') || explicitHostName.includes('?'))
    ) {
      continue;
    }

    parsed.push({ alias, explicitHostName });
  }

  return parsed;
}

function parseSshConfigAliasFromJumpTarget(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '';

  // ProxyJump accepts [user@]host[:port]
  let hostPart = trimmed;
  const atIdx = hostPart.lastIndexOf('@');
  if (atIdx !== -1) hostPart = hostPart.slice(atIdx + 1);

  if (hostPart.startsWith('[')) {
    const closing = hostPart.indexOf(']');
    return closing !== -1 ? hostPart.slice(1, closing).trim() : '';
  }

  const colonIdx = hostPart.lastIndexOf(':');
  if (colonIdx !== -1) {
    return hostPart.slice(0, colonIdx).trim();
  }

  return hostPart.trim();
}

function parseHostSshConfig(sshConfigPath: string): Map<string, ParsedSshHost> {
  const hostMap = new Map<string, ParsedSshHost>();
  if (!fs.existsSync(sshConfigPath)) {
    return hostMap;
  }

  const content = fs.readFileSync(sshConfigPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  let currentHosts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const noInlineComment = trimmed.split('#')[0]?.trim() || '';
    if (!noInlineComment) continue;

    const [keywordRaw, ...rest] = noInlineComment.split(/\s+/);
    const keyword = keywordRaw.toLowerCase();
    const value = rest.join(' ').trim();
    if (!value) continue;

    if (keyword === 'host') {
      currentHosts = value
        .split(/\s+/)
        .map((h) => h.trim())
        .filter(Boolean)
        .filter((h) => !h.includes('*') && !h.includes('?'));
      for (const host of currentHosts) {
        if (!hostMap.has(host)) hostMap.set(host, {});
      }
      continue;
    }

    if (currentHosts.length === 0) continue;
    if (!['hostname', 'user', 'port', 'proxyjump'].includes(keyword)) continue;

    for (const host of currentHosts) {
      const existing = hostMap.get(host) || {};
      if (keyword === 'hostname' && !existing.hostName) {
        existing.hostName = value;
      } else if (keyword === 'user' && !existing.user) {
        existing.user = value;
      } else if (keyword === 'port' && !existing.port) {
        existing.port = value;
      } else if (keyword === 'proxyjump' && !existing.proxyJump) {
        existing.proxyJump = value;
      }
      hostMap.set(host, existing);
    }
  }

  return hostMap;
}

function configureSshAccess(
  group: RegisteredGroup,
): { mounts: VolumeMount[]; extraEnv: Record<string, string> } {
  const mounts: VolumeMount[] = [];
  const extraEnv: Record<string, string> = {};

  const allowedHosts = parseAllowedSshHosts(group);
  if (allowedHosts.length === 0) {
    return { mounts, extraEnv };
  }

  const hostAuthSock = process.env.SSH_AUTH_SOCK;
  if (!hostAuthSock || !fs.existsSync(hostAuthSock)) {
    logger.warn(
      { group: group.name, sshAuthSock: hostAuthSock },
      'SSH allowlist configured but SSH_AUTH_SOCK is unavailable; skipping SSH forwarding',
    );
    return { mounts, extraEnv };
  }

  // Store generated SSH config on native Linux temp filesystem.
  // On /mnt/* (DrvFS), chmod can degrade to 777 and OpenSSH rejects it.
  const sshDir = path.join(os.tmpdir(), 'nanoclaw-ssh', group.folder);
  fs.mkdirSync(sshDir, { recursive: true });
  fs.chmodSync(sshDir, 0o700);

  const sshEnvConfig = readSshEnvConfig();
  const defaultUser =
    group.containerConfig?.sshDefaultUser ||
    process.env.SSH_DEFAULT_USER ||
    sshEnvConfig.SSH_DEFAULT_USER;
  const defaultPort =
    process.env.SSH_DEFAULT_PORT || sshEnvConfig.SSH_DEFAULT_PORT;
  const knownHostsPath =
    process.env.SSH_KNOWN_HOSTS_PATH ||
    sshEnvConfig.SSH_KNOWN_HOSTS_PATH ||
    path.join(os.homedir(), '.ssh/known_hosts');
  const hostSshConfigPath =
    process.env.SSH_CONFIG_PATH ||
    sshEnvConfig.SSH_CONFIG_PATH ||
    path.join(os.homedir(), '.ssh/config');
  const hostSshConfig = parseHostSshConfig(hostSshConfigPath);

  // Collect explicitly allowed aliases and ProxyJump dependencies.
  const hostPolicies = new Map<string, ParsedSshHost>();
  const queue: AllowedSshHost[] = [...allowedHosts];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (visited.has(next.alias)) continue;
    visited.add(next.alias);

    const fromHostConfig = hostSshConfig.get(next.alias);
    const policy: ParsedSshHost = {
      hostName: next.explicitHostName || fromHostConfig?.hostName || next.alias,
      user: fromHostConfig?.user,
      port: fromHostConfig?.port,
      proxyJump: fromHostConfig?.proxyJump,
    };
    hostPolicies.set(next.alias, policy);

    if (!policy.proxyJump) continue;
    const jumpAliases = policy.proxyJump
      .split(',')
      .map((token) => parseSshConfigAliasFromJumpTarget(token))
      .filter(Boolean);

    for (const jumpAlias of jumpAliases) {
      if (!visited.has(jumpAlias)) {
        queue.push({ alias: jumpAlias });
      }
    }
  }

  const configLines: string[] = ['# Auto-generated by NanoClaw'];

  for (const [alias, policy] of hostPolicies.entries()) {
    configLines.push(`Host ${alias}`);
    configLines.push(`  HostName ${policy.hostName || alias}`);
    configLines.push(`  User ${policy.user || defaultUser || 'node'}`);
    configLines.push(`  Port ${policy.port || defaultPort || '22'}`);
    if (policy.proxyJump) configLines.push(`  ProxyJump ${policy.proxyJump}`);
    configLines.push('  ProxyCommand none');
    configLines.push('  IdentityAgent /home/node/.ssh/agent.sock');
    configLines.push('  StrictHostKeyChecking yes');
    configLines.push('  BatchMode yes');
    if (fs.existsSync(knownHostsPath)) {
      configLines.push('  UserKnownHostsFile /home/node/.ssh/known_hosts');
    }
    configLines.push('');
  }

  configLines.push('Host *');
  configLines.push(
    "  ProxyCommand /bin/sh -c 'echo \"NanoClaw SSH policy denied host: %h\" >&2; exit 1'",
  );
  configLines.push('  BatchMode yes');

  const generatedConfigPath = path.join(sshDir, 'config');
  fs.writeFileSync(generatedConfigPath, configLines.join('\n') + '\n', {
    mode: 0o600,
  });

  mounts.push({
    hostPath: generatedConfigPath,
    containerPath: '/home/node/.ssh/config',
    readonly: true,
  });

  if (fs.existsSync(knownHostsPath)) {
    mounts.push({
      hostPath: knownHostsPath,
      containerPath: '/home/node/.ssh/known_hosts',
      readonly: true,
    });
  } else {
    logger.warn(
      { group: group.name, knownHostsPath },
      'SSH known_hosts file not found; strict host verification may fail',
    );
  }

  mounts.push({
    hostPath: hostAuthSock,
    containerPath: '/home/node/.ssh/agent.sock',
    readonly: false,
  });
  extraEnv.SSH_AUTH_SOCK = '/home/node/.ssh/agent.sock';

  logger.info(
    {
      group: group.name,
      allowedHosts: allowedHosts.map((h) => h.alias),
      effectiveHosts: Array.from(hostPolicies.keys()),
      hostSshConfigPath,
    },
    'SSH access enabled for allowlisted hosts',
  );

  return { mounts, extraEnv };
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): MountBuildResult {
  const mounts: VolumeMount[] = [];
  const extraEnv: Record<string, string> = {};
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Secrets are passed via stdin instead (see readSecrets()).
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Pi state directory (isolated from other groups)
  // Each group gets its own pi agent home to prevent cross-group session access.
  const groupPiAgentDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.pi-agent',
  );
  fs.mkdirSync(groupPiAgentDir, { recursive: true });
  // Seed auth/model registry from host pi config so `/login` in host pi is usable here.
  seedPiAuthFiles(groupPiAgentDir);

  // Sync skills from container/skills/ into each group's Pi skills directory.
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupPiAgentDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  mounts.push({
    hostPath: groupPiAgentDir,
    containerPath: '/home/node/.pi/agent',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  const sshConfig = configureSshAccess(group);
  mounts.push(...sshConfig.mounts);
  Object.assign(extraEnv, sshConfig.extraEnv);

  return { mounts, extraEnv };
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile([...PI_PROVIDER_SECRET_KEYS]);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  extraEnv: Record<string, string>,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  for (const [key, value] of Object.entries(extraEnv)) {
    args.push('-e', `${key}=${value}`);
  }

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const { mounts, extraEnv } = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, extraEnv);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
