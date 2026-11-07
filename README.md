# Pentomino Daily

A daily jigsaw. The picture is NASA's Astronomy Picture of the Day (or Wikipedia's Picture of the day), cut into **pentomino-shaped pieces**. Drag, rotate and flip the pieces to rebuild it. Everyone gets the same puzzle each day, and there is a Wordle-style share button.

It is a static site (plain HTML/JS/CSS, no build step, no dependencies), so it hosts for free on GitHub Pages.

## How it works

- **Same puzzle for everyone.** The puzzle date seeds a random generator that tiles the grid with pentominoes (5x6 for portrait pictures, 6x5 for landscape). Pieces use distinct shapes where possible, and a solution always exists because the pieces are cut from a complete tiling.
- **The picture is the hint.** Each piece shows its slice of the image, and it only counts when it sits in the right spot facing the right way. Pieces start scrambled in the tray, turned and flipped.
- **Controls.** Drag a piece to move it. Tap a piece to select it, tap again to rotate. Rotate/Flip buttons act on the selected piece (keyboard: R, F, H for hint, Esc to deselect).
- **Scoring.** Time plus moves. A hint shows where one piece belongs and adds 15 seconds.
- **Sharing and streaks.** Results are copied or shared as text. Streaks and best time live in the browser's local storage; there are no accounts or backend.

## Project layout

```
site/                  the website (this folder is what gets deployed)
  index.html style.css
  core.js              pure game logic: pieces, tiling, snapping, tray layout, stats (no DOM)
  game.js              canvas rendering, input, timer, dialogs
  data/sample.json     placeholder puzzle used until a daily picture has been fetched
  images/sample.svg
scripts/
  fetch-daily.mjs      downloads today's picture + caption into site/ (APOD, then Wikipedia)
  serve.mjs            tiny local web server
tests/                 node:test suites (logic, fetch parsing, and a fake-DOM play-through)
.github/workflows/deploy.yml   runs tests, fetches today's picture, deploys to GitHub Pages
```

## Run it locally

Needs Node 20 or newer. No `npm install` is required.

```bash
npm run dev     # http://localhost:8080  (shows the sample puzzle)
npm test        # runs all tests
npm run fetch   # pulls today's real picture into site/ (needs internet)
```

Handy URL parameters while developing: `?seed=anything` plays a different puzzle (and doesn't record results), `?reset` clears today's "solved" record, `?debug` exposes `window.__pento` for poking at state.

## Deploy to GitHub Pages

1. Create a GitHub repo and push this project to the `main` branch.
2. In the repo go to **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Optional but recommended: get a free key at <https://api.nasa.gov> and add it as a repository secret named `NASA_API_KEY` (Settings > Secrets and variables > Actions). Without it the script uses NASA's rate-limited `DEMO_KEY`, and falls back to Wikipedia if that is throttled.
4. Run the workflow once from the **Actions** tab (or just push). The site appears at `https://<your-username>.github.io/<repo-name>/`.

The workflow runs on every push and twice a day. Each run executes the tests, fetches the current picture, and deploys. The picture is **not committed**, so the repo stays small. If every source fails, the job fails and the previous day's puzzle stays live.

## Configuration (environment variables for `fetch-daily.mjs`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `NASA_API_KEY` | `DEMO_KEY` | Your free NASA API key |
| `IMAGE_SOURCE` | `auto` | `auto` (APOD, then Wikipedia), `apod`, or `wikimedia` |
| `ALLOW_COPYRIGHTED` | off | Set to `true` to include APOD pictures that carry a photographer's copyright |

## A note on image rights

The fetch script copies the day's image onto your site, because the browser can only slice pictures into pieces if they are served from the same origin. NASA's APOD marks many pictures with a photographer's copyright, and republishing those is not covered by NASA's usual public-domain terms. So by default the script **skips copyrighted APOD pictures** and falls back to Wikipedia's Picture of the day, whose images are freely licensed. Credit and license are shown when a puzzle is solved. If you turn on `ALLOW_COPYRIGHTED`, check the photographer's reuse terms first.

## Known limits and ideas

- The live APOD and Wikipedia endpoints are untested from the build environment (no outside network there). The response parsing is covered by tests using sample payloads, so run `npm run fetch` once on your own machine to confirm.
- Touch play has been simulated in tests but should get a real try on a phone. Loose pieces are drawn small on narrow screens so the whole tray fits without scrolling.
- Ideas: difficulty levels (4 or 8 pieces), alternate APOD and Wikipedia by weekday, a "ghost" outline toggle, piece-snap sound/haptics, an archive of past days, per-day leaderboards (needs a backend).
