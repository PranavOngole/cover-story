# Putting Plain Sight on the Mac App Store

The Mac App Store is the goal for the desktop app (ledger D-37). This page lists the steps from here to a published app. Everything the app itself needs for the sandbox is in the repository. Still to write, though they need no account: the privacy policy text inside the app (decision 3), the export compliance key in `src-tauri/Info.plist` (step 7) and the App Store configuration files (step 6); the config check must then allow `src-tauri/Info.plist`. The rest needs Pranav's Apple Developer Program membership.

## What is already in place

- **App Sandbox.** The app is signed with exactly four entitlements (`src-tauri/Entitlements.plist`): the sandbox itself, read and write access to files the user picks in a panel, read and write access to the Downloads folder, and app-scoped bookmarks. There is no network entitlement. The Mac App Store accepts only sandboxed apps (App Review Guidelines 2.4.5(i)).
- **The remembered folder** is kept as a security-scoped bookmark (`src-tauri/src/bookmark.rs`, `src-tauri/src/folder.rs`), which is how a sandboxed app gets back into a folder after a quit.
- **The move into the container.** `src-tauri/container-migration.plist` tells macOS to move the vault and the app's data folder into the app's container on the first sandboxed launch.
- **The category** is Productivity (`LSApplicationCategoryType` is `public.app-category.productivity`).

Not yet seen in a running app: whether the page shows at all without a network entitlement, whether the vault arrives in the container, and the folder in the sandbox. The Product Owner checks these in a launched sandboxed build before anything below is done.

## Decisions Pranav makes first

1. **Export compliance.** The app encrypts the user's own text on the Mac with the system's WebCrypto (AES-256-GCM, PBKDF2) and sends nothing. Apple says encryption built into the operating system is typically exempt from the documentation upload, while proprietary encryption is not, and that the developer is responsible for the answer ([Complying with Encryption Export Regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations), [Overview of export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)). The answer becomes the `ITSAppUsesNonExemptEncryption` key in `src-tauri/Info.plist`. Apple's "Overview of export compliance" page also notes that France controls "Secure Storage" apps separately, which may matter for the vault.
2. **A network entitlement**, only if the Product Owner's launch shows the page needs one.
3. **A privacy policy.** Apple requires a link to it in App Store Connect and inside the app, in an easily accessible place (Guideline 5.1.1(i)). The app cannot open links, so the policy text itself would go into the app, for example in the intro.
4. **Which Macs.** The build is Apple Silicon only. Tauri's App Store guide says such a build must declare macOS 12.0 as its minimum, or be built as a universal app for Intel Macs too ([Tauri, App Store](https://v2.tauri.app/distribute/app-store/)).

## Steps

1. **Join the Apple Developer Program** at developer.apple.com (SIGNING.md, step 1). Note the team id: it is shown under Membership details.
2. **Register the App ID.** In Certificates, Identifiers and Profiles, choose Identifiers, click +, choose App IDs, then App. Enter the description "Plain Sight" and the explicit Bundle ID `com.pranavongole.plainsight`, which must match `identifier` in `src-tauri/tauri.conf.json`. No extra capabilities are needed.
3. **Create the two certificates.** In Xcode, open Settings, Accounts, select the Apple account, click Manage Certificates, click + and add "Apple Distribution" (it signs the app), then click + again and add "Mac Installer Distribution" (it signs the installer package). Run `security find-identity -v` and note both identity names exactly as listed.
4. **Create the provisioning profile.** In Certificates, Identifiers and Profiles, choose Profiles, click +, and under Distribution choose "Mac App Store Connect". Select the App ID from step 2 and the Apple Distribution certificate from step 3, name the profile "Plain Sight App Store", then download it. Keep it outside the repository.
5. **Create the app record.** In App Store Connect, open Apps, click +, choose New App, then macOS. Enter the name (at most 30 characters, Guideline 2.3.7), the primary language, the Bundle ID from step 2 and a SKU such as `plainsight-mac`.
6. **Add an App Store configuration** next to the everyday one, so that everyday builds stay ad-hoc signed. Do not name it `tauri.macos.conf.json`: Tauri merges a file of that name into every macOS build. Create `src-tauri/tauri.appstore.conf.json`:

   ```json
   {
     "bundle": {
       "macOS": {
         "signingIdentity": "Apple Distribution: <name> (<team id>)",
         "minimumSystemVersion": "12.0",
         "entitlements": "./Entitlements.appstore.plist",
         "files": {
           "embedded.provisionprofile": "<path to the profile from step 4>"
         }
       }
     }
   }
   ```

   Tauri copies each `files` entry into the app's `Contents` folder, so the profile lands at `Contents/embedded.provisionprofile`, where macOS looks for it. Tauri merges this file over `tauri.conf.json`, so the container migration manifest stays bundled. `Entitlements.appstore.plist` holds the four entitlements of `Entitlements.plist` plus the two that tie the app to the profile: `com.apple.application-identifier` set to `<team id>.com.pranavongole.plainsight`, and `com.apple.developer.team-identifier` set to `<team id>` (Tauri's App Store guide, Entitlements). App Store Connect identifies each upload by its build number (Upload builds), so give every upload a new one: set `bundle.macOS.bundleVersion` (for example "1", then "2") when the version stays the same. The checks in `tests/config.mjs` and `tests/bundle.mjs` refuse anything beyond today's entitlements and files, so they get an App Store case at the same time.
7. **Add the export compliance answer** from decision 1: create `src-tauri/Info.plist` holding only `ITSAppUsesNonExemptEncryption`, set to the agreed value. Tauri merges it into the app's Info.plist.
8. **Build the app.** From `desktop/`, run `npx tauri build --bundles app --config src-tauri/tauri.appstore.conf.json`. Leave `APPLE_ID`, `APPLE_PASSWORD` and the API key variables unset: those make Tauri notarize, which is for Developer ID copies and not for the App Store. For a universal build add `--target universal-apple-darwin` after `rustup target add x86_64-apple-darwin`; the app is then in `src-tauri/target/universal-apple-darwin/release/bundle/macos/`.
9. **Check the signed app** before packaging: `codesign -dv --verbose=4 "<app>"` names the Apple Distribution certificate and the team id; `codesign -d --entitlements - --xml "<app>"` shows exactly the six entitlements; `Contents/embedded.provisionprofile` exists; `codesign --verify --deep --strict "<app>"` reports nothing.
10. **Make the signed installer package.** Tauri 2.12 has no installer package format of its own (its macOS formats are `app` and `dmg`), so use Apple's `productbuild`, as Tauri's guide does: `xcrun productbuild --sign "<Mac Installer Distribution identity from step 3>" --component "<app>" /Applications "Plain Sight.pkg"`.
11. **Upload the package.** Apple lists Xcode, Transporter, `altool` and the App Store Connect API as the ways to upload a build ([Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)). The simplest is Transporter from the Mac App Store: sign in, drag `Plain Sight.pkg` in, click Deliver. From Terminal: create an App Store Connect API key. Apple's "Creating API Keys for App Store Connect API" page makes a Team Key under Users and Access, Integrations, Team Keys, with the access Developer; Tauri's App Store guide says Integrations, Individual Keys. Follow whichever your screen shows, and check `xcrun altool --help` for `--api-key-subject` if an upload with an individual key is refused. Save the key file as `~/.appstoreconnect/private_keys/AuthKey_<key id>.p8`, then run `xcrun altool --upload-app --type macos --file "Plain Sight.pkg" --apiKey <key id> --apiIssuer <issuer id>`. `notarytool` is not used: it notarizes Developer ID copies.
12. **Test the store build with TestFlight** once App Store Connect has processed it (an email says so). Install it from TestFlight on this Mac and use it for a day.
13. **Fill in the listing** in App Store Connect:
    - Category: Productivity, matching the app.
    - Privacy policy URL, and the same policy inside the app (decision 3).
    - App Privacy: choose "Data Not Collected". Apple defines collecting as transmitting data off the device ([App privacy details](https://developer.apple.com/app-store/app-privacy-details/)); the app sends nothing.
    - Export compliance: the answer from decision 1.
    - Age rating: answer the questionnaire honestly (Guideline 2.3.6). The app has no objectionable content, no web access and no user-generated content shared with others.
    - Screenshots: at least one, 16:10, at 1280 x 800, 1440 x 900, 2560 x 1600 or 2880 x 1800 pixels ([Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)), plus the description, keywords, support URL and price.
14. **Submit for review** with the notes below, then release.

## On this Mac, after the switch

macOS ties the app's container to the app's signature. A build with a different signature, such as the store build after ad-hoc builds, makes macOS ask "would like to access data from other apps" on its first launch; if that is refused at launch, the app does not start ([Accessing files from the macOS App Sandbox](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)). Each new ad-hoc build gets a new signature, so it can ask again. Allow it once for the store build; the store builds that follow share one signature and do not ask.

## What App Review may ask, and what to write in the review notes

The app's purpose is to show a plausible document while the real text stays hidden. The review notes should say so plainly, because:

1. **Nothing may be hidden from the reviewer** (Guideline 2.5.19: no hidden, dormant or undocumented features). List every key chord and what it does, how to see the real text, how the vault opens and what Esc does, in the notes and in the app's own intro.
2. **New features need a specific description** in the Notes for Review (Guideline 2.3.1(a)). Give a short walkthrough: type, peek at the real text, save into a folder, quit, reopen the vault.
3. **It must be more than a repackaged website** (Guideline 4.2). Name what the app adds: Save into a chosen folder on every Mac, as `.txt`, `.md` or `.docx` (the web page can do this only in Chromium browsers), a vault kept in the app's own data, quitting and closing that wipe the screen first, and a menu bar of its own.
4. **It must work on launch** (Guideline 2.1(a)). An app that opens a blank window is rejected as incomplete; the Product Owner's sandboxed launch settles this before submission.
5. **Explain each entitlement in the review notes**: the folder panel and the Open panel, Save into Downloads without a folder, and the remembered folder. Guideline 2.4.5(i) itself asks that the app be appropriately sandboxed.
6. **Data handling** (Guideline 5.1.1): no account, no server, no analytics, nothing sent; the vault is encrypted on the Mac with the phrase only the user knows.
7. **The reviewer may ask why text is hidden at all.** The answer to give: privacy from people who can see the screen, such as in an office, on a train or while sharing a screen. The text never leaves the Mac and the user can always see it.
