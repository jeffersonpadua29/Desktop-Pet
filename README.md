# Desktop Pet

A tiny shadow gremlin for your Windows desktop.

See the [Windows setup guide](SETUP.md) for the desktop app, live notifications, and local package signing.

## Run on Windows

Install Node.js LTS, then open a terminal in the cloned project folder.

```powershell
npm start
```

- Click Anino to open or close its controls. Drag it to move it.
- **Feed** fills its belly. **Pet** builds bond. **Sleep** starts a 15-second nap.
- Pet Anino twice to find the shimmering egg. Cracking it gives a 40% chance of a wearable Moonclip and a 60% chance of a brief smoke puff. Nesting it guarantees a Dawn Shard at the next local 6 AM.
- Open **Journal & collection** to see what happened and what you kept.
- Left-click the Anino tray icon to toggle **Quiet Mode**. Right-click it to quit. Windows may tuck the icon under the tray overflow arrow.
- Progress saves locally. Time away counts for at most six hours of stat decay per return.

On first run, `npm start` installs the locked npm dependencies and sets up Ollama and Qwen for Ask Pet. The model download is about 2.5 GB. Later starts reuse the installed model and can run offline. See the [setup guide](SETUP.md#local-ai-with-qwen) for details.

## Ask Pet

Use **Ask** to chat with Qwen, create or find local files, open files in VS Code, and control supported desktop apps.

Anino puts on headphones when you launch Spotify and dances while the Spotify desktop app reports active playback to Windows. The dance has its own loop. The clock badge and idle behavior use your PC's local time.

## Pick a pet

At first launch, choose a pixel gremlin, cat, dog, chicken, ghost, sprout, robot, bunny, or cloud, then enter a name. Use **Switch or rename pet** in the care panel to adopt another character or rename the current pet. Each pet keeps their own name, care stats, and journal. One pet appears on the desktop at a time.

## Windows notification companion

Choose **Set up live alerts** on first launch or from **Alerts** to install the bundled x64 companion. The [setup guide](SETUP.md#live-notifications-from-a-clone) explains the Windows approvals and the maintainer build steps.



