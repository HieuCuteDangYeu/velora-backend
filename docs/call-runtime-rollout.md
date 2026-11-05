# Call runtime topology

## Signaling replicas and media nodes

Compose runs call-service with `CALL_MEDIA_MODE=remote`:

- `call-service` (2 replicas behind nginx) is stateless signaling. Socket.IO
  uses the Redis adapter. Per-participant locks, camera/mic revisions, the
  `call_ended` replay and sweep claims live in Redis (`CallCoordinator`), so a
  replica can restart or be added without ending calls.
- `call-media-1` (UDP 40000) runs mediasoup from the same image
  (`dist/apps/call-service/apps/call-service/src/media-node/main.js`).
  Each media node heartbeats `call:media-node:<id>` with a per-start
  incarnation and serves `ICallMediaEngine` over an internal TCP RPC (port
  4100, never published).
- A new call is placed on the live node with the fewest rooms
  (`call:<callId>:media-node`). Every later media command goes to that node.
  When a node stops heartbeating, restarts, or loses a worker, signaling ends
  only that node's calls with `media_unavailable`.

The phone needs no change: the node's public IP and UDP port arrive in the
ICE candidates of `transport_created`. Every node must use the same codec
configuration.

### Router and capacity (current limitation)

Each media node needs its own public UDP port: mediasoup announces the port
it listens on, so the host port must equal the container port. The homelab
router forwards a single UDP port (40000), so production runs **one** media
node. Multi-node placement, failover and cross-replica signaling are covered
by `apps/call-service/test/e2e/call-hyperscale.e2e.spec.ts`.

To add a node where more ports (or another public IP) are available: copy the
`call-media-1` block as `call-media-2` with UDP 40001, forward that port, add
it to `CALL_MEDIA_SERVICES` in `scripts/deploy/velora-deploy-core`, and add
its target to the `call-media` Prometheus job. A TURN server (coturn) on the
single forwarded port, relaying to media nodes on the internal network, is
the alternative when only one port can be opened.

### Deploys

A call-service image change still recreates the media nodes (same image), so
active calls end during that deploy, as before. Restarting or scaling only
the signaling replicas keeps calls alive.

### Rollback to the single-instance runtime

Set `CALL_MEDIA_MODE: embedded` and `replicas: 1` on call-service, publish
`40000:40000/udp` from it again, and remove the `call-media-*` services. The
embedded profile restores the runtime lease and the startup recovery.

## Metrics

Prometheus discovers every signaling replica through DNS (`job="call-service"`)
and scrapes media nodes as `job="call-media"` (`service="call-media"`). Worker
CPU/rooms and public-IP metrics now come from the media nodes.
`VeloraCallMediaNodeDown` fires when a node cannot be scraped for a minute.

## TURN fallback rollout

The media nodes (or call-service in the embedded profile) read `TURN_URLS`,
`TURN_USERNAME`, and `TURN_CREDENTIAL` from their environment. It includes `iceServers` in the existing authenticated
`transport_created` response for both send and receive. Mobile forwards it to
mediasoup-client with `iceTransportPolicy: 'all'`, allowing direct SFU candidates
and TURN relay candidates. ICE selects a working path; TURN is not forced.
Media rebuilds use the same transport creation path and obtain the same config.

## Metered configuration

Copy the username/password from the credential in the Metered `velora` workspace
into the backend environment. Do not commit secrets or place them in
`EXPO_PUBLIC_*` variables.

```dotenv
TURN_URLS=turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:80?transport=tcp,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443?transport=tcp
TURN_USERNAME=<provider-username>
TURN_CREDENTIAL=<provider-password>
```

These are the Metered Global endpoints for UDP/80, TCP/80, UDP/443 and TLS/443.
Use the provider's current ICE snippet if the region or plan changes.
[Metered quickstart](https://www.metered.ca/docs/turn-server-service/quickstart/).

## Deploy and verify

1. Build and release the updated Call Service and mobile JS bundle.
2. Set the three variables in the deployed backend `.env` or secret manager.
   Docker Compose already uses `env_file: .env`; no new service/ports are needed.
   Recreate call-service and the call-media nodes to load new environment values. Schedule this because
   replacing the mediasoup process interrupts active calls.
3. Verify voice/video calls, group voice, and network recovery on real devices.
   Use a controlled test with direct UDP blocked (while permitting TURN TCP/TLS),
   or temporarily use `iceTransportPolicy: 'relay'` in a test build. Confirm
   `candidateType: relay` on the selected local ICE candidate and media bytes
   increasing. Restore `'all'` for release. Never log credentials/full payloads.
4. Check Metered usage and the trial quota before production rollout.

The advertised SFU public IP and UDP/40000 must remain reachable from the TURN
servers. TURN over TCP/TLS to the client does not require enabling mediasoup TCP.
TURN improves connectivity; it does not add Simulcast or adaptive video quality.

## Rollback and credential rotation

Clear all three TURN settings and recreate Call Service for direct-only ICE.
Partial/malformed TURN settings fail startup with an error that omits secrets.
Older clients ignore the optional field; newer clients work with old backend
payloads. Credentials are sent only in transport signaling and are not stored
in Redis. The static credential can still be read by an authenticated client:
keep the Metered account secret key server-only, monitor quota, and replace the
TURN credential in the backend environment when rotating. New/rebuilt transports
use the replacement after restart; existing transports may still use the old one.
