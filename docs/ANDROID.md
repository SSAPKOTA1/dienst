# Android app and NFC tags

The Android app (`apps/android`) is a small native shell around the Dienstplan web app. It remembers the server address, shows the web app in a WebView and opens the **punch screen** when the phone touches an **NFC tag** at the hotel. It adds no second login and no second set of rules: the server decides (login, tag, does the person work at the hotel) and every punch goes to review like a web punch.

## How a tap works

1. An administrator adds a tag for a hotel (_Admin → Tablets → NFC tags_). The server stores only a hash of a random token and shows the address once: `https://<WEB_ORIGIN>/nfc?t=<token>`.
2. The address is written to an NFC sticker as a **URL record** (any NFC writer app, for example "NFC Tools"; an NTAG213/215/216 sticker is enough).
3. An employee holds the phone to the tag. Android opens the app (the app claims `https://*/nfc…` links; on a phone without the app the browser opens the same page).
4. The web page `/me/nfc` asks the server `POST /me/punch/nfc` which hotel the tag belongs to and what the employee's state is, and offers **Clock in** or **Clock out** (with break choice). The punch endpoints `/me/punch/in|break|out` accept the tag token instead of the hotel-network check.

Rules on the server (`apps/api/src/routes/webPunch.ts`, `nfcTags.ts`): the tag must be active and its hotel switched on; the employee must work at that hotel; punches are `source = 'web'` and always go to review; the audit log has `punch_via_nfc` with the tag id; revoking a tag (`DELETE /nfc-tags/:id`) stops it at once.

## Limits you should know

- A tag is a **shared secret on a sticker**. Anyone who reads it with their own phone can copy the address. They still need a login of a person who works at that hotel, and the time goes to review, but it does not prove presence like a rolling-code tag would. Stick the tag where only staff pass, and block it (and write a new one) if it leaks. Rolling-code tags (NTAG 424 DNA) are a possible later hardening.
- The app does **no** GPS and no biometrics.
- The app allows plain `http` because small hotels run the server inside their own network. Use `https` whenever the server is reachable from the internet; production requires it (`COOKIE_SECURE=true`).
- The app only loads pages of the server it is connected to. A tag of another server is refused; on a freshly installed app the first tag asks once "Connect to this server?".

## Building the app

CI builds it on every pull request (job **Android app**), runs the JVM unit tests of the link handling (`TagLinkTest`) and attaches `app-debug.apk` as an artifact (`dienstplan-debug-apk`).

Locally you need JDK 17 and the Android SDK (Android Studio brings both):

```
cd apps/android
./gradlew testDebugUnitTest assembleDebug     # APK: app/build/outputs/apk/debug/app-debug.apk
```

Install on a phone: enable "install unknown apps" for your file manager, copy the APK over (or `adb install -r app-debug.apk`), open the app, enter the server address.

The debug APK is signed with a debug key, which is fine for installing it yourself on your staff's phones. For the Play Store you need a release build signed with **your own** key: create a keystore (keep it out of the repository), add a `signingConfig` to `app/build.gradle.kts` reading the keystore from environment variables, and run `./gradlew bundleRelease`. Not done here because the key is yours.

## What is not tested

CI proves that the app compiles and the link handling is right. Nobody has yet held a real phone to a real tag in this repository. Before rolling it out, try it with one phone and one sticker: write the tag, tap, sign in, clock in, clock out, then block the tag and tap again.
