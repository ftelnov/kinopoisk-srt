# Kinopoisk Subtitle Overlay

Chrome extension that loads custom SRT subtitles on top of the Kinopoisk HD video player.

Substital and similar tools don't work with Kinopoisk's custom player. This extension does.

## Install

### From release

1. Download the `.zip` from [Releases](../../releases)
2. Unzip to any folder
3. Open `chrome://extensions/`, enable **Developer mode**
4. Click **Load unpacked**, select the extracted folder

### From source

```
git clone <repo-url>
cd kinopoisk-subtitles-overlay
make install
```

## Usage

1. Open any film or series on [hd.kinopoisk.ru](https://hd.kinopoisk.ru)
2. Click the extension icon in the toolbar
3. Drop an `.srt` file or click to browse
4. Subtitles appear over the video, synced to playback

### Controls (in popup)

- **Sync offset**: ±0.5s / ±1s to adjust timing
- **Font size**: Small / Medium / Large / Extra Large
- **Toggle background**: show/hide semi-transparent backdrop
- **Clear**: remove loaded subtitles
- **Encoding**: UTF-8, Windows-1251, KOI8-R, ISO-8859-5, UTF-16 LE

Subtitles are vertically draggable (grab handle appears on hover).

## Features

- Parses standard SRT files
- Binary search for O(log n) cue lookup
- Handles seeking, scrubbing, and fullscreen
- Persists subtitles across page loads via `chrome.storage`
- Follows Kinopoisk SPA navigation (video element replacement)
- No DRM bypass — just a visual overlay on top of the player

## Development

```
npm install          # install test dependencies
make test            # run Puppeteer integration tests
make package         # build .zip for distribution
make release         # create GitHub release (requires gh CLI)
make clean           # remove build artifacts
```

## How it works

The content script polls for `<video>` elements on `hd.kinopoisk.ru` and `www.kinopoisk.ru`. When found, it attaches a positioned `<div>` overlay to the player container and syncs subtitle display with `video.timeupdate` / `video.seeked` events. SRT parsing and cue lookup use a binary search for efficiency.

## License

MIT
