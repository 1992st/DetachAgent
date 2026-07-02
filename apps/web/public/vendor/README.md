# Third-party viewer assets

This directory is intentionally committed with placeholders only. Production builds should populate:

- `pdfjs/` with the PDF.js generic viewer (`web/viewer.html`).
- `drawio/` with the diagrams.net/draw.io web application (`index.html`).

Run `node scripts/fetch-library-vendors.mjs` from the repository root when network access is available.

License notes:

- PDF.js is distributed by Mozilla under the Apache License 2.0.
- diagrams.net/draw.io is distributed by JGraph under the Apache License 2.0.

Keep upstream `LICENSE` and `NOTICE` files in the copied vendor folders.
