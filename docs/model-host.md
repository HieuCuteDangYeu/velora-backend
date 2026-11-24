# Model host: Ollama on the developer laptop

The homelab ai-service does not run its own model. It calls Ollama (`gemma4:e2b-it-qat`, used for both the router and the
answers) on the developer laptop through a reverse SSH tunnel. This keeps inference free, at the price of a single machine
that production depends on.

```
homelab ai-service -> host.docker.internal:11435 -> (reverse SSH tunnel) -> laptop 127.0.0.1:11434 -> container velora-gemma4
```

## Laptop side

| Piece | What / where |
|---|---|
| Model server | Docker container `velora-gemma4` (GPU, volume `velora-gemma4-models`, port `127.0.0.1:11434`). Recreate it with `scripts/deploy/model-host-ollama`; it is idempotent, reuses the current image and rolls back if the new container does not answer. |
| Keep-alive | `OLLAMA_KEEP_ALIVE=-1`: the model stays loaded. With the default 5 minutes, the first request after a quiet spell waited about 12 s for a reload. |
| One model only | `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`. **Never load another model on this server** (for example to experiment): it evicts the production model and slows live users. Use a second container on another port. |
| Tunnel | User service `velora-gemma-ssh-tunnel` (`Restart=always`). Its `ExecStartPre` runs `scripts/deploy/model-host-tunnel-clean-stale`, installed as `~/.local/bin/velora-model-host-tunnel-clean-stale`. |
| Stays up | `loginctl enable-linger $USER` so the tunnel runs without a login session; logind lid policy `HandleLidSwitch=ignore` and `HandleLidSwitchExternalPower=ignore` (`/etc/systemd/logind.conf.d/`) so closing the lid does not suspend the host. Keep it plugged in and cool. |

### Why the stale-session cleanup exists
If the laptop's ssh dies uncleanly (network change, suspend/resume), the homelab's sshd keeps the dead session and its listener
on port 11435 for a long time. Every reconnect then fails with "remote port forwarding failed" (`ExitOnForwardFailure`) and AI is
down until someone clears it by hand. The cleanup step terminates any `sshd-session` still listening on that port before each
connect. Measured: an unclean kill of the tunnel now recovers in about 18 s by itself.

## Homelab side: monitoring
`scripts/deploy/model-host-probe` runs every 30 s from the LaunchAgent `com.velora.model-host-probe`
(`scripts/deploy/com.velora.model-host-probe.plist`) and writes metrics for Prometheus; the `velora-model-host` alert group
(`infra/monitoring/prometheus/rules/velora-monitoring.yml`) raises:

- `VeloraModelHostDown` (critical, 2 min): the model server is unreachable; every AI answer is failing.
- `VeloraModelHostProbeStale` (warning): the probe stopped reporting, so an outage would go unnoticed.
- `VeloraModelHostModelNotResident` (warning, 10 min): the production model is not loaded; the next request cold-starts.
- `VeloraModelHostSlow` (warning, 5 min): health probes take over 2 s (overload, thermal throttling or swapping).

They appear in the monitoring-service system alerts.

## Capacity and `AI_BUSY`
The model server handles one request at a time. A warm chat turn takes about 3-4 s (measured), so very roughly 15 chat turns a
minute across all users; reel questions make more model calls and cost more. The per-user limits do not bound the total, so the
ai-service admits a limited number of turns (`AI_MAX_CONCURRENT_TURNS`, `AI_MAX_QUEUED_TURNS`, `AI_TURN_QUEUE_WAIT_MS`; see
`.env.example`) and answers the overflow at once with `AI_BUSY` and a `retryAfterSeconds` hint, instead of letting it queue until
a model timeout. The client shows "Velora AI is busy right now"; see `docs/rate-limiting-and-guardrails.md`.

## Keeping the laptop cool (measured 2026-11-11)
The laptop (MSI Thin GF63 12UC: i7-12650H, RTX 3050 with 4 GB VRAM) sat at 94 °C under inference, hit 100 °C, and throttled about
7,000 times a minute. Inference is GPU-bound (the GPU averaged about 31 W of its 35 W limit at 66 °C), so the heat was mostly the CPU
boosting for ordinary desktop work in a small cooler.

**Fix: disable Intel turbo** (`/sys/devices/system/cpu/intel_pstate/no_turbo` = 1):

| 150 s of sustained inference | Turbo on | Turbo off |
|---|---|---|
| CPU package, mean / peak | 94 / 100 °C | 72 / 87 °C |
| Thermal throttle events per minute | ~7,000 | 0 |
| Answer speed | 80-83 tok/s, 1.25-1.29 s per turn | 81 tok/s, 1.28 s per turn |
| CPU at idle | 84-91 °C | 54 °C |

The only cost is single-core speed for dev work (about 2.3 GHz instead of ~4.7). To keep it across reboots, enable a oneshot
systemd unit that writes 1 to that file (`velora-no-turbo.service`); switch it to 0 temporarily for heavy builds.

Measured and **not** useful: the `balanced` power profile, capping the container to 4 CPUs, and fewer Ollama threads (`num_thread`
1 or 2 cut Ollama's CPU from about 360% to 100-150% with no change in temperature). A 2-CPU container cap lowered the temperature by
only 2.5 °C and cost 30% of the speed. The GPU power limit cannot be changed on this laptop GPU (`nvidia-smi -pl` is unsupported).

Gotcha: `docker update --cpus 0` does **not** remove a CPU cap; set it back to the CPU count (`--cpus 16`) instead.

Other levers: only one fan reports RPM (about 5,100 near max at 90+ °C), which suggests dust or dried thermal paste, so cleaning the
fans and heatsink and replacing the paste is the next real fix. The local Langfuse stack (ClickHouse and others) is the largest CPU
consumer after the browser and also uses about 1.9 GB of RAM; production traces go to it, so it cannot simply be stopped.
Memory is 16 GB (reportedly 2 x 8 GB DDR4-3200 SO-DIMM, 2 slots, 64 GB maximum). More RAM stops swapping but does not speed up the
model, which lives in the 4 GB of VRAM.

## Troubleshooting
- AI answers failing everywhere: check `VeloraModelHostDown`; on the laptop, `systemctl --user status velora-gemma-ssh-tunnel`,
  `docker ps --filter name=velora-gemma4`, and that the machine is awake and on AC power.
- Tunnel flapping with "remote port forwarding failed": the cleanup step should clear it within seconds; if not, find the holder
  on the homelab with `lsof -nP -iTCP:11435 -sTCP:LISTEN` and terminate that `sshd-session`.
- First answer after a restart is slow: `scripts/deploy/model-host-ollama` warms the model; otherwise send one short request.
