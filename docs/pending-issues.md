# Pending Issues

Last updated: 2026-06-05

This file is the backend/infrastructure source of truth for open issues that still need coordinated work.

How to use it:

- Update this file in every PR that changes the status, root-cause understanding, or proposed solution for one of these items.
- Prefer concrete dates, exact runtime symptoms, and links to the relevant GitHub issue/PR once those exist.
- If an issue also requires Flutter/client changes, call that out explicitly instead of treating it as backend-only.

## 1. LiveKit deployment still lacks TURN/TLS fallback

- Severity: P1
- Status: Open
- Repos: `talkflix-api`, `talkflix`
- Current behavior:
  - LiveKit is deployed and audio rooms use the SFU path.
  - Current deployment relies on the existing LiveKit host/port setup and does not yet include TURN/TLS fallback.
  - For v1 launch, this is explicitly accepted as a media reliability risk because direct-call real-device QA was user-reported as passing.
- Current understanding:
  - This leaves a real reliability gap for restrictive Wi-Fi, symmetric NAT, and other networks where direct UDP paths are not enough.
  - App-side moderation/state fixes do not remove this infrastructure risk.
- Proposed solution:
  - Add TURN/TLS support and verify firewall/port exposure for the full media path.
  - Keep cross-network validation explicit: LTE, home Wi-Fi, and restrictive-network scenarios.
- GitHub issue: TBD

## 2. iPhone stage-unmute failure still needs end-to-end diagnosis

- Severity: P1
- Status: Open
- Repos: `talkflix-api`, `talkflix`
- Current behavior:
  - The current stage flow is: host approves -> user joins stage muted -> user manually unmutes.
  - In current iPhone testing, the first unmute can still fail with `AUIOClient_StartIO failed (-66637)`.
- Current understanding:
  - The current evidence points to the failure happening at local microphone start on the device.
  - No backend-side failure has been isolated as the cause yet.
- Proposed solution:
  - Reproduce with synchronized client logs, Xcode device logs, and backend/LiveKit logs for the same attempt.
  - Only change backend behavior if the correlated evidence shows a room/token/permission mismatch rather than a device-side publish start failure.
- GitHub issue: TBD

## 3. Upload storage is still local disk on the droplet

- Severity: P2
- Status: Open
- Repos: `talkflix-api`
- Current behavior:
  - Uploaded files are written to the local `uploads/` directory and served directly from the app server.
- Current understanding:
  - This is simple, but it is not the right long-term storage path for durability, scaling, or multi-instance deployment.
- Proposed solution:
  - Move uploads to object storage such as DigitalOcean Spaces.
  - Store durable object URLs/keys in MySQL instead of relying on droplet-local files.
- GitHub issue: TBD

## 4. Production process still runs as `root`

- Severity: P2
- Status: Open
- Repos: `talkflix-api`
- Current behavior:
  - The deployed PM2 app currently runs as `root`.
- Current understanding:
  - This is operationally convenient but not the right steady-state deployment posture.
- Proposed solution:
  - Move the deployed backend to a dedicated Linux user with least-privilege ownership of `/opt/talkflix-api`.
  - Keep nginx and system services configured explicitly around that deployment user.
- GitHub issue: TBD

## 5. Backup and restore workflow is not yet formalized

- Severity: P2
- Status: Partially mitigated
- Repos: `talkflix-api`
- Current behavior:
  - Production backup retention and manual cleanup are documented in `/Users/talkflix/talkflix_flutter/docs/production-backup-retention.md`.
  - Old live-folder backup files were moved to a root-only archive on 2026-06-05 after creating a protected current snapshot.
  - Automated MySQL dumps and a full restore drill are still not implemented.
- Current understanding:
  - MySQL data, uploads, and droplet recovery need an explicit repeatable plan before launch-grade operations can be claimed.
- Proposed solution:
  - Add automated MySQL dumps and a documented restore procedure.
  - Define whether uploads remain droplet-local or move to object storage first.
  - Document the expected DigitalOcean snapshot/backups policy.
- GitHub issue: TBD

## 6. Secret rotation and secret ownership need to be formalized

- Severity: P2
- Status: Open
- Repos: `talkflix-api`
- Current behavior:
  - Runtime secrets are correctly excluded from Git, but team-facing ownership and rotation procedure are not yet documented in this repo.
- Current understanding:
  - This is manageable in a small team, but it is too informal for stable production operations.
- Proposed solution:
  - Document which secrets exist, who owns them, where they are stored, and when they should be rotated.
  - Rotate any value that was shared outside the normal secret-management path.
- GitHub issue: TBD
