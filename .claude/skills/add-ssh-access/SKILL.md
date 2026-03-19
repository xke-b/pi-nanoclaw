---
name: add-ssh-access
description: Add allowlisted SSH access for container agents, including ProxyJump support and persistent ssh-agent handling on nohup setups.
---

# Add SSH Access (Allowlisted)

This skill adds an SSH forwarding framework so agents can access specific servers via SSH while denying all other hosts.

## What this skill installs

- SSH allowlist parsing from `.env` and per-group config
- Host alias resolution from `~/.ssh/config` (`HostName`, `User`, `Port`, `ProxyJump`)
- Automatic inclusion of jump-host dependencies for allowed hosts
- Deny-by-default policy for non-allowlisted targets
- SSH agent socket forwarding into containers
- Nohup startup wrapper support for persistent ssh-agent reuse
- OpenSSH client in the container image

## Security model

- Agents can only SSH to explicitly allowlisted aliases
- Non-allowlisted hosts are blocked by generated SSH config policy
- Keys stay on host SSH agent; private keys are not copied into containers

## Apply

```bash
npx tsx scripts/apply-skill.ts .pi/skills/add-ssh-access
```

## Configure

Add to `.env`:

```bash
# Allow aliases only; supports alias mapping alias=host
SSH_ALLOWED_HOSTS=deepflame-1

# Optional overrides
SSH_CONFIG_PATH=/home/$USER/.ssh/config
SSH_KNOWN_HOSTS_PATH=/home/$USER/.ssh/known_hosts
SSH_DEFAULT_USER=
SSH_DEFAULT_PORT=
```

Then restart NanoClaw.

## Verify

1. Ensure NanoClaw process has `SSH_AUTH_SOCK`
2. Ensure keys are loaded into that agent (`ssh-add -l` on NanoClaw sock)
3. Trigger a command without `-F /dev/null`, for example:

```bash
ssh deepflame-1 'hostname'
```

## Troubleshooting

- `SSH_AUTH_SOCK is unavailable`: start/reuse ssh-agent and restart NanoClaw
- `Permission denied (publickey)`: add required jump/target keys into the forwarded agent
- `Host key verification failed`: populate `known_hosts` for jump/target hosts
