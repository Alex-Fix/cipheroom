# Camera switching — design
Status: approved · Date: 2026-10-06

## Problem
On phones you're stuck with the front camera; on desktops with several webcams you get the browser default.

## Goals / Non-goals
- **Goals:** flip front ⇄ rear on phones/tablets; pick a specific camera on desktop; correct mirroring.
- **Non-goals:** remembering the choice across calls, microphone/speaker pickers, pre-join preview.

## Constraints check
| Constraint | This feature |
|---|---|
| E2EE invariant | No impact; the published track is replaced in place (same LiveKit publication). |
| $0 / no public IP / open source | Client-only; LiveKit + browser APIs. |
| Untrusted server | Device ids/labels stay in the browser — never in SignalR, LiveKit metadata, logs. |
| Browser support | `facingMode` restart works on iOS Safari and Android Chrome; `enumerateDevices` labels need camera permission (we only list after the camera is on). |
| Two signaling channels | Media only (LiveKit); no SignalR change. |

## Chosen approach
LiveKit APIs: `LocalVideoTrack.restartTrack({ facingMode })` for flip, `Room.switchActiveDevice('videoinput', id)`
for the picker. *Why not our own getUserMedia + replaceTrack:* LiveKit already handles republishing, simulcast and
(later) E2EE transforms on the swapped track.

## Design
- **`LiveKitService`**: `cameras` (`{ id, label }[]`), `activeCameraId`, `cameraFacing` (`user | environment |
  undefined`), `canFlip` (some camera label looks rear-facing); `flipCamera()`, `selectCamera(id)`. Camera list
  refreshes on connect, after the camera turns on (labels need permission) and on `MediaDevicesChanged`.
- Pure helpers in `core/livekit/cameras.ts`: facing detection (track settings first, then labels like
  "Back Camera" / "camera2 0, facing back"), rear-camera detection.
- **`CallControls`**: flip button (↻) when `canFlip` and the camera is on; "Camera" section in the ⋯ menu when there
  is more than one camera, with a check on the active one.
- **`Room`**: wires intents; failures become constant-string toasts via `deviceErrorMessage('camera', e)`.
- **Mirroring**: `Tile.mirror` — local camera tile, unless facing `environment`.

## Security notes
Device labels/ids are rendered by interpolation and never leave the client. No new network calls.

## Testing
Unit: facing/rear detection, controls (flip visibility, picker items, events), tile `mirror`, room error toast.
Manual: real phone (flip both ways, preview mirroring, remote sees rear camera), Mac with two webcams (picker,
hot-plug a USB webcam).

## Implementation steps
1. Camera helpers + `LiveKitService` state/methods + `Tile.mirror`.
2. Controls (flip button, picker) + Room wiring + tests.
3. Docs/skill note, screenshots, stack rebuild.
