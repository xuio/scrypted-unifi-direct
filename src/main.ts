// Plugin entry point. The implementation lives in:
//   provider.ts    — DeviceProvider/DeviceCreator, controller emulator lifecycle,
//                    per-camera push-port allocation
//   camera.ts      — the camera device (streams, settings, zones, pairing)
//   snapshots.ts   — snapshot capture/cache/resize
//   detections.ts  — smart-detect event engine + derived motion state
import { UnifiDirectProvider } from './provider';

export default UnifiDirectProvider;
