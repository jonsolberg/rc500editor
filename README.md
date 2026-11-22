# RC-500 Editor (web + Android)

An editor for the **BOSS RC-500 Loop Station** that talks to the pedal through its own USB port.
Use it in the browser or as a standalone Android app.

> Works best in **Chrome or Edge** on a computer. Back up the pedal's data (System › Pedal data) before the first
> save. Not affiliated with BOSS/Roland.

**[Open the web version](https://jonsolberg.github.io/rc500editor/)** ·
**[Download the Android APK](https://github.com/jonsolberg/rc500editor/releases/latest/download/RC500Editor.apk)** ·
[all releases](https://github.com/jonsolberg/rc500editor/releases)

To install the APK, allow your browser or file manager to *install unknown apps* when Android asks.

<p align="center">
  <img src="docs/direct.webp" width="760" alt="Direct mode: the RC-500 panel on screen">
</p>
<p align="center">
  <img src="docs/start.webp" width="380" alt="Start page: connect, load, edit and save">
  <img src="docs/memory.webp" width="380" alt="Editing a memory, including ASSIGN 1–8">
  <img src="docs/system.webp" width="380" alt="System settings">
  <img src="docs/loops.webp" width="380" alt="Loops: play, export and import">
  <img src="docs/remote.webp" width="380" alt="MIDI page">
</p>
<p align="center">
  <img src="docs/phone-start.webp" width="220" alt="Start page on a phone">
  <img src="docs/phone-direct.webp" width="220" alt="Direct mode on a phone">
  <img src="docs/phone-memory.webp" width="220" alt="Editing on a phone">
</p>

## Features

- **Start page** that guides you through connecting, loading, editing and saving
- **All 99 memories**: tracks, recording, playback, loop FX, rhythm, pedal/CTL/EXP functions and ASSIGN 1–8, with
  plain-language explanations (ⓘ) for most settings
- **System settings**, plus a read-only view of every stored value for troubleshooting
- Copy, paste, swap and initialize memories; save and load presets (`.rc500.json`); undo/redo
- **Loops**: play, export, import (any audio file, converted to the RC-500 format) and delete the recorded loops,
  one at a time or all at once
- **Direct mode**: play the pedal live from an on-screen copy of its panel, with keyboard shortcuts on a computer
- **MIDI page**: switch memories, start/stop, send the memory's CC controls, MIDI monitor
- Backup of `ROLAND/DATA` as a ZIP; light/dark theme; works on a phone

## Getting started

1. Power the RC-500 (adapter or batteries, with a cable in OUTPUT A/MONO – that jack is its power switch) and
   connect its USB port with a cable that carries data.
2. Open the [web version](https://jonsolberg.github.io/rc500editor/) or the Android app. It connects over USB MIDI
   by itself; the first time, allow MIDI/SysEx in the browser.
3. **⤓ Load from pedal**. The editor puts the pedal in storage mode and reads its memories. The first time, pick the
   `BOSS RC-500` drive. The pedal must be stopped.
4. Edit, then **⤒ Save to pedal**. The editor writes and checks the files, and the pedal leaves storage mode and
   reloads its memories.

If storage mode doesn't start by itself, use MENU › STORAGE › CONNECTING on the pedal.

### Browsers

| | Load | Save | USB MIDI (Direct, MIDI page) |
|---|---|---|---|
| **Chrome, Edge, Opera** (computer) | ✅ | ✅ straight to the pedal | ✅ |
| **Firefox** (computer) | ✅ pick the drive each time | ⚠️ downloads the files; copy them into `ROLAND/DATA` yourself | ✅ |
| **Android app** | ✅ see [Android](#android) | ✅ | ✅ |
| Safari, iPhone/iPad | ❌ | ❌ | ❌ |

Use the editor from its web address, [jonsolberg.github.io/rc500editor](https://jonsolberg.github.io/rc500editor/).
Browsers only allow USB MIDI and writing to a drive on secure (https) pages. If you download the files and open
`index.html` from your own computer, connecting to the pedal and saving to it may not work.

**Why not Safari, iPhone or iPad?** Safari has no Web MIDI, so it can't connect to the pedal, switch storage mode or
play it in Direct mode. It also can't write to a folder or drive from a web page, so it can't save to the pedal. On
iPhone and iPad every browser (Chrome and Firefox too) is built on Safari's engine and has the same limits. A
native iOS app could do it, but it's currently out-of-scope for this project (you are more than welcome to 
contact me if you are interrested in developing one).

### Android

Android's handling of the pedal's USB drive is unreliable: it only mounts the drive if the pedal is already in
storage mode when the cable goes in, and it doesn't notice the drive going away. Editing and Direct mode work fine,
but the app doesn't switch storage mode for you:

1. Unplug the cable from the phone.
2. On the pedal: MENU › STORAGE › CONNECTING (it shows PREPARING…).
3. Plug the cable back in. The pedal shows CONNECTING… and the app opens the drive.
4. When you're done, eject the drive in My Files (⏏ next to USB storage) before leaving storage mode or unplugging.

It can take a second try. If My Files reports errors on the drive, let a computer scan and repair it.

## How it works

The pedal's USB port carries both USB MIDI and, in storage mode, a drive with the memories in `ROLAND/DATA` and the
loops in `ROLAND/WAVE/<memory>_<track>/`. Storage mode is switched with a SysEx message. The pedal keeps two copies of
each data file and loads the one with the higher save counter. The editor saves to the other copy, so the previous
version stays on the pedal as a fallback, and unchanged files are written back byte for byte.

## Direct mode

The RC-500 can't be played over USB directly, but every memory has eight **ASSIGN** slots that react to MIDI CC
messages. **Set up memories…** (Start or Direct page) fills free ASSIGNs with the controls below; save the memories
to the pedal, and Direct mode can play them. The table is also useful if you want to control the pedal from another
MIDI device the same way.

| CC# | ASSIGN target | On screen |
|---|---|---|
| 80 | CUR REC/PLY | REC/PLAY |
| 81 | CUR PLY/STP | STOP |
| 82 | TRK SELECT (0 = track 1, 127 = track 2) | TRACK SELECT |
| 83 / 84 | T1 / T2 LEVEL1 | TRACK 1 / 2 sliders |
| 85 | RHYTHM P/S | Rhythm ON/OFF |
| 86 | CUR CLEAR | hold STOP |
| 87 | UNDO/REDO | hold REC/PLAY |
| 89 | LOOP FX (optional) | LOOP FX |

Messages go out on the pedal's RX CTL channel. Tempo is sent as MIDI clock and needs no ASSIGN (SYSTEM › MIDI ›
Sync clock AUTO or USB). The on-screen sliders set the track levels but can't follow the pedal's own sliders, which
the RC-500 doesn't report over USB.

## Tested

On a real RC-500 in Chrome on Windows: USB MIDI, switching storage mode, loading, saving, backup, Direct mode and
the Loops tab. Other browsers and the Android app have had less testing; please report problems as
[issues](https://github.com/jonsolberg/rc500editor/issues).

## Building

- **Web**: plain HTML/CSS/JS in [`web/`](web), no build step. Open `web/index.html` or serve the folder.
  The `pages` workflow publishes it to GitHub Pages.
- **Android**: the app bundles `web/` as its assets and adds a native bridge (`MainActivity.java`) for USB MIDI
  (`android.media.midi`) and the USB drive (Storage Access Framework). Push to GitHub — the `build` workflow
  builds a signed APK and publishes it as a release. Or open the folder in Android Studio.

## Credits

The RC-500 file format, the value encoding and the storage-mode SysEx were worked out by D. Fleury in
[boss-rc500-editor](https://github.com/dfleury2/boss-rc500-editor) (MIT licence, © 2022 D. Fleury), which this
project started from. Parameter descriptions follow the BOSS RC-500 Parameter Guide.

## Support

The editor is free, open source and has no ads. If you find it useful, you can
[support me on Ko-fi](https://ko-fi.com/jonsolberg) ❤️

[![Support me on Ko-fi](https://img.shields.io/badge/Ko--fi-support%20me-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/jonsolberg)

## License

Copyright © 2026 Jon Solberg

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
[GNU General Public License](LICENSE) for more details.
