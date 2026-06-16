# macOS Quarantine Release Test

The release workflow must prove the notarized app can launch its bundled sidecar
after a fresh download. The test runs after the app bundle is signed, notarized,
and stapled, before the DMG is created.

The workflow simulates a fresh download by recursively applying
`com.apple.quarantine` to `build/Relayscribe.app`, including
`Contents/MacOS/sidecar-node`. It then launches the app with `open` and requires
`http://127.0.0.1:3700/health` to return a JSON response containing
`relayscribe-sidecar`.

The sidecar Node executable is packaged as `Contents/MacOS/sidecar-node`, not
under `Contents/Resources`, so Gatekeeper assesses it as nested executable code
inside the notarized app bundle.
