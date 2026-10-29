# Custom Tools

A phone-first web app (PWA) with one tool per tab. Currently: **Timer** (first tab) and **Stopwatch**.
No build step and no dependencies — it's plain HTML/CSS/JS.

## Run locally

```powershell
powershell -ExecutionPolicy Bypass -File dev-server.ps1
```

Then open http://localhost:5173.

## Put it on your phone

"Install" and offline support need **HTTPS**, so host the folder somewhere free, e.g.
Netlify Drop (drag the folder onto app.netlify.com/drop), GitHub Pages, or Cloudflare Pages.
Then open the URL in Chrome on Android → menu (⋮) → **Install app** / **Add to Home screen**
(or tap the **Install app** button in the app's header).

## Add another tool

1. Create `js/tools/<name>.js` exporting `{ id, title, icon, mount(root) }`
   (see `stopwatch.js` for a small example; `icon` is a key in `js/util.js` → `icons`).
2. Import it in `js/app.js` and add it to the `tools` array — order = tab order.
3. Add its file to `SHELL` in `sw.js` and bump `CACHE` so phones pick it up.
