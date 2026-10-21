# Signing and notarizing the Mac app

For later. None of this is needed to use the app on the Mac that builds it.

## Where things stand

The app is built with an ad-hoc signature (`bundle.macOS.signingIdentity` is `"-"` in `src-tauri/tauri.conf.json`): the whole bundle is sealed and runs with the hardened runtime, but no Apple Developer ID vouches for it. On the Mac that builds it, `Plain Sight.app` opens with a double-click, because macOS only checks apps that arrived from somewhere else (they carry a quarantine mark).

A copy that arrives by download, AirDrop, email or a USB stick is refused the first time it is opened. On macOS 15 and later the way past that is: try to open the app once, click Done, then open System Settings, Privacy and Security, scroll to the message about "Plain Sight", click Open Anyway and confirm with your password or Touch ID. (Right-click and Open no longer does this on macOS 15 and later.)

To give the app to other people without that step, it needs a Developer ID signature and Apple's notarization. That needs a paid Apple Developer Program membership, which is Pranav's decision.

## Steps, once there is an Apple Developer account

1. Join the Apple Developer Program (developer.apple.com, Account, Enroll; the fee is set by Apple, currently 99 US dollars a year).
2. Create a Developer ID Application certificate: in Xcode, Settings, Accounts, select the Apple account, Manage Certificates, click +, choose "Developer ID Application". It goes into the login keychain.
3. Check that it is there: `security find-identity -v -p codesigning` lists `Developer ID Application: <name> (<team id>)`.
4. Create an app-specific password for notarization: account.apple.com, Sign-In and Security, App-Specific Passwords, +, name it "Plain Sight notarization", and copy the password (it is shown once). Never put it in the repository, a chat or an email.
5. Build, sign and notarize in one go. Tauri reads these variables (Tauri's guide: https://v2.tauri.app/distribute/sign/macos/):

   ```
   export APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)"
   export APPLE_ID="<the Apple account email>"
   export APPLE_PASSWORD="<the app-specific password>"
   export APPLE_TEAM_ID="<team id>"
   npm run app:build
   ```

   The variable takes precedence over the ad-hoc `"-"` in `tauri.conf.json` (tauri-cli 2.12.3, `src/interface/rust.rs` lines 1446 to 1453). Tauri signs with the hardened runtime, sends the app to Apple's notary service, waits for the result and staples the ticket to the app. Notarization uploads the app to Apple; it is the only step that needs the network, and it happens on the building Mac, not in the app. An App Store Connect API key works instead of the Apple ID: `APPLE_API_ISSUER`, `APPLE_API_KEY` and `APPLE_API_KEY_PATH`.
6. Check the result: `spctl -a -vvv "src-tauri/target/release/bundle/macos/Plain Sight.app"` should say `accepted` and `source=Notarized Developer ID`, and `codesign -dv --verbose=4` should show the Developer ID and the runtime flag.
7. To hand the app out as a single file, add `"dmg"` to `bundle.targets` in `tauri.conf.json`, then check the disk image before sharing it: `spctl -a -t open --context context:primary-signature -v <the .dmg>`.

The Mac App Store is out of scope (DR-07): it would also need the App Sandbox, a different certificate and Apple's review.
