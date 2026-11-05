# Desktop Pet

A tiny shadow gremlin for your Windows desktop.

See the [Windows setup guide](SETUP.md) for the desktop app, live notifications, and local package signing.

## Run on Windows

Install Node.js LTS, then open a terminal in the cloned project folder.

```powershell
npm start
```

- Click Anino to open or close its controls. Drag it to move it.
- Stretch the menu using its top or left edge, or drag its upper-left corner to resize both dimensions. Arrow keys on a focused handle adjust the size; hold Shift for larger steps. Double-click a handle or press Home to reset. The menu remembers its size and stays within the display.
- **Feed** fills its belly. **Pet** builds bond. **Sleep** starts a 15-second nap.
- Pet Anino twice to find the shimmering egg. Cracking it gives a 40% chance of a wearable Moonclip and a 60% chance of a brief smoke puff. Nesting it guarantees a Dawn Shard at the next local 6 AM.
- Open **Journal & collection** to see what happened and what you kept.
- Left-click the Anino tray icon to toggle **Quiet Mode**. Right-click it to quit. Windows may tuck the icon under the tray overflow arrow.
- Progress saves locally. Time away counts for at most six hours of stat decay per return.

On first run, `npm start` installs the locked npm dependencies and sets up Ollama and Qwen for Ask Pet. The model download is about 2.5 GB. Later starts reuse the installed model and can run offline. See the [setup guide](SETUP.md#local-ai-with-qwen) for details.

## Ask Pet

Use **Ask** to chat with Qwen, create and find local files, read and review text/code, open files, propose edits, rename files, and move files to the Recycle Bin. It also controls supported desktop apps.

File workflows use a verified target and real file contents. Try `Read notes.txt in Documents`, `Review app.ts for bugs`, `Read notes.txt and summarize it`, or `Open "weekly report.txt" in Downloads`. A single result or a file selected using its result card becomes the target for `Read it`, `What does it do?`, `Change that file ...`, and `Delete it`. Duplicate names require a folder or explicit selection; an unknown filename never falls back to a different selected file. Text and code open in VS Code. Supported documents and media open through Windows. Delete moves one regular file to the Recycle Bin and reports success only after Windows finishes.

Reads and reviews support the same UTF-8 text/source formats as editing, up to 32 KB, and stay on local Qwen. Binary formats such as PDF, Office documents, and images can be opened but are not parsed by this workflow. Named files are resolved from recent results or directly in Desktop, Documents (including Pet Pocket), and Downloads; use Find first for nested files. English, Filipino, and Taglish commands such as `Basahin notes.txt sa Documents` are supported.

Coding edits prefer exact text patches for small changes, preserving unrelated code and line endings. The app validates each patch, previews the complete result, and rejects stale source before applying. `Fix app.ts and run tests` offers a project-folder picker and runs its existing npm test script after applying the reviewed edit. This workflow handles one file at a time; it does not automatically execute generated programs or infer test success from model output.

`Change the extension to .c` or `Rename it to .c` changes a selected file's extension while keeping its contents. To translate the implementation, use `Convert script.py to C`, `Rewrite it in C`, or `Use C instead of Python`. Conversion previews the new `.c` filename and code, saves it alongside the original after Apply, and selects the converted file for later reads or edits. Existing destination files are never overwritten.

Hybrid AI uses the configured cloud provider for standalone questions and file generation. Context-dependent follow-ups (for example, “make it shorter”, “translate that”, or “save the previous answer”) run on Qwen with the recent conversation, including cloud answers. Both engines use the same language, reference-resolution, and action rules. Earlier local messages and pet stats are not automatically uploaded. An instruction such as “use local only” applies while it remains in the retained conversation (up to seven turns), including project-edit requests.

This is application-managed routing and handoff, not a direct conversation between models. Only validated tool proposals reach Windows; ambiguous multiple actions and truncated output are rejected. Invalid cloud output falls back to Qwen. Conversation memory is bounded, so an older reference may need to be supplied again.

Anino puts on headphones when you launch Spotify and dances while the Spotify desktop app reports active playback to Windows. The dance has its own loop. The clock badge and idle behavior use your PC's local time.

## Pick a pet

At first launch, choose a pixel gremlin, cat, dog, chicken, ghost, sprout, robot, bunny, or cloud, then enter a name. Use **Switch or rename pet** in the care panel to adopt another character or rename the current pet. Each pet keeps their own name, care stats, and journal. One pet appears on the desktop at a time.

Characters use native 64 × 64 soft-pixel frames, with rounded silhouettes, warm highlights, and small material details. The animation and accessory rig keeps its original 32-unit coordinates. Regenerate the sheets with `python art/draw_sprites.py`; open `art/character-preview.html` to see the cast and animation samples.

## Windows notification companion

Choose **Set up live alerts** on first launch or from **Alerts** to install the bundled x64 companion. The [setup guide](SETUP.md#live-notifications-from-a-clone) explains the Windows approvals and the maintainer build steps.



