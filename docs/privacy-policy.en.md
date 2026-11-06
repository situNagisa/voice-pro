# Voice Pro Privacy Policy

**Effective date: November 6, 2026**
**Version: 1.0**

This policy applies to “音准镜” (Voice Pro) on Android, iOS, desktop (Windows / macOS / Linux) and the web (PWA).

Developer: [DEVELOPER NAME]
Email: [CONTACT EMAIL]
Address: [ADDRESS]

## Summary

Voice Pro is an on-device singing practice tool. **We do not collect, upload or share any personal information or audio.** Microphone audio is analyzed only on your device; practice recordings and pitch data stay on your device.

## 1. Information we collect

We collect **no personal information**:

- No account, name, phone number, email or government ID;
- No device identifiers (IMEI, Android ID, advertising ID), location, contacts, photos or clipboard;
- No analytics, advertising, push or third-party tracking SDKs;
- No audio, recordings, pitch data or practice history is uploaded to any server.

## 2. Microphone and audio processing

- **Purpose:** the microphone is used to detect your pitch in real time during practice and tuning.
- **Processing:** audio is processed locally with Web Audio, WebAssembly and an on-device ONNX model. Pitch detection, vocal separation and scoring all run on your device.
- **Upload:** none. The app has no audio-upload feature and no server that receives audio.
- **Storage:** when you start a practice session, the app stores that session's recording (for replay) and its pitch track locally. You can delete any record in “Records”.
- **Voiceprints:** we do not perform speaker recognition, build voiceprint templates, or use recordings to identify anyone.
- **Permission:** microphone access is controlled by your operating system and can be revoked at any time. Without it you can still browse the app and view history, but cannot practice in real time.

## 3. Data stored on your device

| Storage | Content | Purpose |
| --- | --- | --- |
| IndexedDB | Practice recordings, pitch tracks, per-phrase scores, song names and timestamps | Review and replay in “Records” |
| localStorage | Tolerance, volume, UI settings, recent song names | Remember preferences |

- Imported songs are read into memory for analysis only. The original audio is **not** persisted or uploaded; you must select the file again after restarting the app.
- There is no cloud sync. The Android build disables system auto backup (`allowBackup=false`), so recordings are not included in cloud backups or device migration.
- Deletion: delete individual records in the app, clear app/site data in system settings, or uninstall the app to remove all local data.

## 4. Network and third parties

- Core features work offline. Pitch detection, the vocal-separation model and demo songs ship with the app and require no online service.
- The web version loads static pages over HTTPS. The hosting provider may keep standard access logs (IP address, browser type, time) for security and operations, as any website does; the app does not read or analyze these logs and embeds no analytics or ads.
- Open-source components (e.g. ONNX Runtime Web, pitchy) run locally and contain no telemetry.

## 5. Accounts, ads and tracking

- No accounts, login or cloud profiles.
- No ads, personalized recommendations, behavioral or cross-app tracking.
- We never sell, rent or share personal information.

## 6. Permissions

| Platform | Permission | Purpose |
| --- | --- | --- |
| Android | `RECORD_AUDIO` | Capture pitch during practice |
| Android | `MODIFY_AUDIO_SETTINGS` | Audio playback/capture routing and volume |
| Android | `INTERNET` | Load locally packaged WebView assets only |
| iOS / macOS | Microphone | Capture pitch; the system shows a permission prompt |
| Windows | Microphone | Managed by Windows privacy settings and WebView2 |

The app does not request camera, location, contacts, SMS, call logs or storage permissions unrelated to its features.

## 7. Children's privacy

The app is not directed to children and is not offered to children under 13. Because it collects no personal information and has no accounts or uploads, no data about a child is transmitted to us. Guardians with questions about practice records stored on a device may contact us, or delete the data in the app or system settings.

## 8. Your rights

Because data stays on your device, you can directly:

- **Access** practice records in “Records”;
- **Delete** individual records or clear app/site data;
- **Withdraw consent** by disabling microphone permission in system settings;
- **Export/migrate** — no cloud export is currently offered.

For questions, complaints or assistance, contact us below. We respond within 15 business days.

## 9. Security

- Audio and practice records are stored in the app's private storage and protected by the OS sandbox.
- The app does not transmit audio over a network, reducing exposure.
- Any device can be accessed physically. Use a screen lock and delete practice records on shared devices.

## 10. Changes

If future versions add cloud sync, accounts, analytics or other changes to data handling, we will update this policy before launch and notify you prominently in the app. Continued use means you accept the updated policy; if you disagree, stop using the app and delete local data.

## 11. Contact

- Developer: [DEVELOPER NAME]
- Email: [CONTACT EMAIL]
- Address: [ADDRESS]
