# Pentomino Daily

Four daily jigsaws at different levels. A start page lets you pick one; each is a picture of the day cut into **pentomino or tetromino pieces**. Drag, rotate and flip the pieces to rebuild it. Everyone gets the same four puzzles each day, and there is a Wordle-style share button.

It is a static site (plain HTML/JS/CSS, no build step, no dependencies), so it hosts for free on GitHub Pages.

## How it works

- **Four puzzles a day.** Each has its own picture, and its own saved result:
  - **Easy, Tetromino puzzle**: 4-cell pieces on a 4x6 board (6 pieces). A public-domain artwork from the Art Institute of Chicago.
  - **Medium, NASA picture**: pentominoes on a 5x6 board. NASA's Astronomy Picture of the Day, or a picture from the NASA Image and Video Library when NASA's APOD API is down.
  - **Medium, Wikipedia picture**: pentominoes on a 5x6 board, using today's Wikipedia Picture of the day.
  - **Challenge, Fixed pieces**: 8 pentominoes on a 5x8 board that can't be rotated or flipped. They start upright, so the work is finding where each belongs. A second Art Institute artwork.

  (Landscape pictures swap the board's width and height.) The start page shows the time of any you have already solved, and says "Not available today" for a puzzle whose picture couldn't be fetched. The artworks are picked from the Art Institute's public-domain (CC0) works by the date, so everyone gets the same ones; if the Art Institute can't be reached the two puzzles use Wikipedia pictures from earlier days instead. APOD falls back to the latest usable one from the last week (one request per day), since some days are videos or copyrighted. The deploy also remembers the last pictures it fetched, so an outage on NASA's side keeps the previous picture instead of removing the puzzle.
- **Same puzzle for everyone.** The puzzle source and date seed a random generator that tiles the grid with pentominoes. Pieces use distinct shapes where possible, and a solution always exists because the pieces are cut from a complete tiling.
- **The picture is the hint.** Each piece shows its slice of the image, and it only counts when it sits in the right spot facing the right way. Pieces start scrambled in the tray, turned and flipped.
- **Controls.** Drag a piece to move it. Tap a piece to select it, tap again to rotate. Rotate/Flip buttons act on the selected piece (keyboard: R, F, H for hint, Esc to deselect).
- **Scoring.** Time plus moves. A hint shows where one piece belongs and adds 15 seconds. Restart starts the puzzle over; once you have solved it, Restart starts a practice run that doesn't change your saved result.
- **Sharing and streaks.** Results are copied or shared as text. Solving either puzzle counts for the day's streak. Streaks and best time live in the browser's local storage; there are no accounts or backend.

## Project layout

```
site/                  the website (this folder is what gets deployed)
  index.html style.css
  core.js              pure game logic: pieces (pentomino and tetromino sets), tiling, snapping, tray layout, stats (no DOM)
  game.js              canvas rendering, input, timer, dialogs
  data/sample.json     placeholder puzzle offered on the start page until real pictures have been fetched
  images/sample.svg
scripts/
  fetch-daily.mjs      downloads the four puzzle pictures + captions into site/
  serve.mjs            tiny local web server
tests/                 node:test suites (logic, fetch parsing, and a fake-DOM play-through)
.github/workflows/deploy.yml   runs tests, fetches today's picture, deploys to GitHub Pages
```

## Run it locally

Needs Node 20 or newer. No `npm install` is required.

```bash
npm run dev     # http://localhost:8080  (shows the sample puzzle)
npm test        # runs all tests
npm run fetch   # pulls today's real pictures into site/ (needs internet)
```

Handy URL parameters while developing: `#tetromino` / `#nasa` / `#wikipedia` / `#fixed` open a puzzle directly (no hash shows the start page), `?seed=anything` plays a different puzzle (and doesn't record results), `?reset` clears today's "solved" record, `?debug` exposes `window.__pento` for poking at state.

## Deploy to GitHub Pages

1. Create a GitHub repo and push this project to the `main` branch.
2. In the repo go to **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Optional but recommended: get a free key at <https://api.nasa.gov> and add it as a repository secret named `NASA_API_KEY` (Settings > Secrets and variables > Actions). Without it the script uses NASA's rate-limited `DEMO_KEY`, and falls back to Wikipedia if that is throttled.
4. Run the workflow once from the **Actions** tab (or just push). The site appears at `https://<your-username>.github.io/<repo-name>/`.

The workflow runs on every push and twice a day. Each run executes the tests, fetches the current pictures, and deploys. The pictures are **not committed**, so the repo stays small. If both sources fail, the job fails and the previous day's puzzles stay live.

## Configuration (environment variables for `fetch-daily.mjs`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `NASA_API_KEY` | `DEMO_KEY` | Your free NASA API key |
| `IMAGE_SOURCE` | `auto` | `auto` (all), `apod` (NASA only), `wikimedia` (Wikipedia only) or `artic` (Art Institute only) |
| `ALLOW_COPYRIGHTED` | off | Set to `true` to include APOD pictures that carry a photographer's copyright |

## A note on image rights

The fetch script copies the day's image onto your site, because the browser can only slice pictures into pieces if they are served from the same origin. NASA's APOD marks many pictures with a photographer's copyright, and republishing those is not covered by NASA's usual public-domain terms. So by default the script **skips copyrighted APOD pictures** and falls back to Wikipedia's Picture of the day, whose images are freely licensed. Credit and license are shown when a puzzle is solved. If you turn on `ALLOW_COPYRIGHTED`, check the photographer's reuse terms first.

## Known limits and ideas

- The live APOD and Wikipedia endpoints are untested from the build environment (no outside network there). The response parsing is covered by tests using sample payloads, so run `npm run fetch` once on your own machine to confirm.
- Touch play has been simulated in tests but should get a real try on a phone. Loose pieces are drawn small on narrow screens so the whole tray fits without scrolling.
- Ideas: difficulty levels (4 or 8 pieces), alternate APOD and Wikipedia by weekday, a "ghost" outline toggle, piece-snap sound/haptics, an archive of past days, per-day leaderboards (needs a backend).
