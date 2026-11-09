# Pentomino Daily

Five daily jigsaws at different levels. A start page lets you pick one; each is a picture of the day cut into **pentomino or tetromino pieces**. Drag, rotate and flip the pieces to rebuild it. Everyone gets the same five puzzles each day, and there is a Wordle-style share button.

It is a static site (plain HTML/JS/CSS, no build step, no dependencies), so it hosts for free on GitHub Pages.

## How it works

- **Five puzzles a day, for your local day.** Each has its own picture and its own saved result:
  - **Easy, Tetromino puzzle**: 4-cell pieces on a 4x6 board (6 pieces). A public-domain artwork from the Art Institute of Chicago.
  - **Medium, NASA picture**: pentominoes on a 5x6 board. NASA's Astronomy Picture of the Day, or a picture from the NASA Image and Video Library when that isn't available.
  - **Medium, Wikipedia picture**: pentominoes on a 5x6 board, using Wikipedia's Picture of the day.
  - **Challenge, Fixed pieces**: 8 pentominoes on a 5x8 board that can't be rotated or flipped. They start upright, so the work is finding where each belongs. A second Art Institute artwork.
  - **Challenge, Fixed photo**: the same no-turning rules, with a photograph. A Wikimedia Commons featured picture chosen by the date; the photographer and licence (often CC BY-SA) are shown in the result.

  (Landscape pictures swap the board's width and height.)
- **Local days and earlier puzzles.** The deploy publishes a week of puzzle days, not just one, plus a `manifest.json` listing them. The browser uses the player's local date to choose "today", so the puzzles change at local midnight and everyone in a time zone gets the same ones. The start page has arrows to open any earlier day (days in the player's future are hidden). Earlier days are saved and shareable but don't count toward the streak or best time.
  - The artwork puzzles are picked by date from the Art Institute's public-domain (CC0) works, so any day can be generated, including tomorrow in UTC (needed for time zones ahead of UTC).
  - The two picture-of-the-day puzzles show the *previous* day's picture. Today's picture isn't published yet in every time zone at local midnight, but yesterday's always is.
  - Results are stored per puzzle and day. The start page shows the time of any you have solved and "Not available" for one whose picture couldn't be fetched.
  - APOD sometimes publishes the NASA logo (titled "NASA Science") instead of a picture. That is ignored, as is any picture that is byte-for-byte identical to another day's, and a NASA library picture is used instead.
  - If a source is down, stand-in pictures keep the puzzle available (NASA library for APOD; older Wikipedia pictures for the Art Institute), and are swapped for the real one when the source returns. The deploy also remembers everything it fetched between runs.
- **Same puzzle for everyone.** The puzzle source and date seed a random generator that tiles the grid with pentominoes. Pieces use distinct shapes where possible, and a solution always exists because the pieces are cut from a complete tiling.
- **The picture is the hint.** Each piece shows its slice of the image, and it only counts when it sits in the right spot facing the right way. Pieces start scrambled in the tray, turned and flipped. Pictures with big flat areas (black space, a plain sky) look the same in more than one arrangement, so the game compares what is on the board with the real picture: a piece also counts if the slices it shows look like the picture in those cells. If every piece is placed but some are still wrong, the game says so, highlights one of the wrong pieces (it glows) and asks whether you want a hint for it ("Show hint", which costs 100 points, or "Not now"). It doesn't ask again until you change the board.
- **Mirrored solves count.** If you rebuild the whole picture as a mirror image (every piece flipped and in its mirrored spot, left-to-right or top-to-bottom), the puzzle is solved. Your time gets a note ("🪞 mirrored horizontally") in the result, on the start page and in the shared text, and the dialog shows the picture the right way round. Mirrored solves still count for the streak. Every piece must be mirrored the same way; mixing doesn't count. (Not available in the two fixed puzzles, where pieces can't be flipped.)
- **Phone browsers.** iPhone Safari draws its address/tab bar over the bottom of the page and swallows taps near it, which can cover the buttons. On iPhone browsers (not an installed home-screen app) the page reserves extra space under the buttons, shrinking the playfield rather than hiding the controls, and sizes itself from the browser's visible height (`site/viewport.js`).
- **Assist.** A switch under the board. When it is on, a piece that is in the right spot and orientation gets a green border: it pops (thick and glowing) when the piece lands and settles to a steady line. Only pieces on their true cells count (a look-alike arrangement on a flat picture doesn't), and the border is not shown once the puzzle is solved. It is a per-browser preference (also the A key). A run counts as assisted if assist was on at the start or switched on at any point, and the result says so: "🟢 assist on" in the result dialog and in the shared text, so friends comparing scores can see it. It doesn't change the score.
- **Controls.** Drag a piece to move it. Tap a piece to select it, tap again to rotate. Clockwise, counter-clockwise and Flip buttons act on the selected piece (keyboard: R turns clockwise, Shift+R counter-clockwise, F flips, H for hint, A for assist, Esc to deselect).
- **Scoring.** Your time is the real time it took; hints never add seconds. Instead each solve gets a **score out of 1000** you can compare with friends who played the same puzzle. It starts at 1000 and loses points for:
  - **Time**: free for 10 seconds per piece, then 1.5 points per second (at most 450 lost). More pieces get more free time, so scores stay on a similar scale across puzzles.
  - **Hints**: 100 points each (at most 400).
  - **Wasted moves**: 10 points per placement beyond one per piece, and 5 per rotate/flip press beyond the fewest the pieces needed from the way they started (at most 250).

  A quick, tidy run with no hints scores 1000, and a score never goes below 0. The result dialog shows the score with what cost points, the shared text starts with it (`🏆 874 · ⏱ 3:42 · …`), and the start page shows each solved puzzle's score and the day's total. Results saved before scores existed show their time only. Restart starts the puzzle over; once you have solved it, Restart starts a practice run that is scored but doesn't change your saved result.
- **Sharing and streaks.** Results are copied or shared as text, ending with a link that opens exactly that puzzle (for example `…/#2026-11-08/nasa`). The link names the day, so a friend in another time zone gets the same pieces and picture. A link to a day still ahead of the friend's own date opens it, but the day arrows on the start page only go up to their today, and a link to a day that has dropped out of the week's window says it isn't available any more. Solving any of today's puzzles counts for the day's streak. Streaks and best time live in the browser's local storage; there are no accounts or backend.

## Project layout

```
site/                  the website (this folder is what gets deployed)
  index.html style.css
  core.js              pure game logic: pieces (pentomino and tetromino sets), tiling, snapping, tray layout, stats (no DOM)
  game.js              canvas rendering, input, timer, dialogs
  data/manifest.json   (generated) the published days and puzzles
  data/<day>/<key>.json (generated) one puzzle: title, caption, credit, picture path
  data/sample.json     placeholder puzzle offered on the start page until real pictures have been fetched
  images/sample.svg
scripts/
  fetch-daily.mjs      downloads the five puzzle pictures + captions into site/
  serve.mjs            tiny local web server
tests/                 node:test suites (logic, fetch parsing, and a fake-DOM play-through)
.github/workflows/deploy.yml   runs tests, fetches a week of puzzle pictures, deploys to GitHub Pages (hourly)
```

## Run it locally

Needs Node 20 or newer. No `npm install` is required.

```bash
npm run dev     # http://localhost:8080  (shows the sample puzzle)
npm test        # runs all tests
npm run fetch   # pulls a week of real pictures into site/ (needs internet)
```

Handy URL parameters while developing: `#nasa` (also `#tetromino`, `#wikipedia`, `#fixed`) opens today's puzzle, `#2026-11-07/nasa` a specific day's, `#2026-11-07` that day's list (no hash shows today's list), `?seed=anything` plays a different puzzle (and doesn't record results), `?reset` clears today's "solved" record, `?debug` exposes `window.__pento` for poking at state.

## Deploy to GitHub Pages

1. Create a GitHub repo and push this project to the `main` branch.
2. In the repo go to **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Optional but recommended: get a free key at <https://api.nasa.gov> and add it as a repository secret named `NASA_API_KEY` (Settings > Secrets and variables > Actions). Without it the script uses NASA's rate-limited `DEMO_KEY`, and falls back to Wikipedia if that is throttled.
4. Run the workflow once from the **Actions** tab (or just push). The site appears at `https://<your-username>.github.io/<repo-name>/`.

The workflow runs on every push and hourly (GitHub's scheduler is best-effort, so one daily run can be hours late). Each run executes the tests, restores the previously fetched pictures from the Actions cache, fetches whatever is new for the week's window, and deploys. Pictures already fetched are not downloaded again. The pictures are **not committed**, so the repo stays small. If nothing at all is available, the job fails and the previous deployment stays live.

## Configuration (environment variables for `fetch-daily.mjs`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `NASA_API_KEY` | `DEMO_KEY` | Your free NASA API key |
| `IMAGE_SOURCE` | `auto` | `auto` (all), `apod` (NASA only), `wikimedia` (Wikipedia only), `artic` (Art Institute only) or `commons` (Commons featured photos only) |
| `ALLOW_COPYRIGHTED` | off | Set to `true` to include APOD pictures that carry a photographer's copyright |

## A note on image rights

The fetch script copies the day's image onto your site, because the browser can only slice pictures into pieces if they are served from the same origin. NASA's APOD marks many pictures with a photographer's copyright, and republishing those is not covered by NASA's usual public-domain terms. So by default the script **skips copyrighted APOD pictures** and falls back to Wikipedia's Picture of the day, whose images are freely licensed. Credit and license are shown when a puzzle is solved. If you turn on `ALLOW_COPYRIGHTED`, check the photographer's reuse terms first.

## Known limits and ideas

- The live APOD and Wikipedia endpoints are untested from the build environment (no outside network there). The response parsing is covered by tests using sample payloads, so run `npm run fetch` once on your own machine to confirm.
- Touch play has been simulated in tests but should get a real try on a phone. Loose pieces are drawn small on narrow screens so the whole tray fits without scrolling.
- Ideas: difficulty levels (4 or 8 pieces), alternate APOD and Wikipedia by weekday, a "ghost" outline toggle, piece-snap sound/haptics, an archive of past days, per-day leaderboards (needs a backend).
