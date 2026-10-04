# TURN fallback rollout

Call Service reads `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL` from its
environment. It includes `iceServers` in the existing authenticated
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
   Recreate Call Service to load new environment values. Schedule this because
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
