# deherm-policy-site

Generated branch. **Do not author anything here by hand.**

GitHub Pages serves this branch directly (Settings → Pages → Deploy from a
branch → `deherm-policy-site` → `/`). The nightly policy job appends new
content-addressed objects and pushes; the push is the deploy.

Everything here is re-derivable from the sources pinned in `upstream.lock` on
`main`, so this branch can be deleted and rebuilt rather than repaired.

`.nojekyll` is required: without it Pages runs Jekyll over the store, which
excludes files by name and processes thousands of objects for nothing.
