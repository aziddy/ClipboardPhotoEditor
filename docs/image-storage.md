# Temporary image storage

The unified editor keeps original-resolution pixels in immutable 512 × 512 RGBA tiles. The worker writes tiles to the origin-private file system (OPFS), with IndexedDB as the disk-storage fallback. If both are unavailable, the editor reports that it is using a limited memory store. Images are processed locally; no image-storage server is involved.

Layers contain raster IDs, dimensions, bounds, and transforms. Undo snapshots and duplicated layers share tile references. Brush/eraser edits replace affected tiles; cropping shares interior tiles, removes excluded tiles, and rewrites boundary tiles. Transforming or resizing changes metadata. Full-resolution source pixels remain available when a fitted layer is enlarged later.

## Budgets and tradeoffs

| Resource | Budget / behavior |
| --- | --- |
| Decoded tile cache | 48 MiB, LRU eviction |
| Tile working surfaces | 16 MiB allowance; source sampling patches are bounded |
| Temporary disk data | 2 GiB per editor session, subject to the browser's available quota |
| Memory-only storage fallback | 256 MiB; a separate limit from the decoded tile cache |
| Undo | Up to 30 snapshots, sharing unchanged tiles |
| Waiting pixel operations | One active operation and at most one queued operation |
| Main canvas | Visible viewport dimensions × device pixel ratio |

The 64 MiB tile-work budget is **not a cap on browser RAM**. Initial image decoding, a full-resolution export surface and its encoder, viewport surfaces, OCR, browser allocators, GPU resources, and filesystem caching require additional memory. Very large imports/exports can still create substantial peaks. Browsers decide when freed allocations are returned to the OS.

Raw tiles trade disk space for fast reads and exact pixels. Smaller preview levels reduce preview rendering cost. The worker serializes raster work; the display coalesces intermediate redraws. A cold image or a large export may take longer than it did with every original canvas already in RAM.

**Calculate sizes** explicitly encodes PNG and JPEG, sequentially. Editing does not continually encode both formats. Changing quality invalidates the JPEG size; changing the composition invalidates both. Download/copy also computes the requested format's size. Only in-flight encodes are shared; encoded exports are not retained as an extra cache. PNG clipboard writes receive a promised Blob during the user click to preserve Safari's user activation.

OCR is composed directly at its processing resolution, avoiding an extra full-document intermediate. Its preparation surface and Tesseract worker are released afterward.

## Failure and cleanup behavior

New pixels are persisted before a document edit is committed. On quota pressure, the worker first discards inactive preview levels, then removes older undo snapshots with a notice. The current document remains protected. If space still cannot be freed, the edit fails and the previous document remains usable.

Reset invalidates pending work, releases the viewport, and disposes the session's worker, cache, and storage. Component unmount also disposes its worker. A closed/crashed tab can leave temporary files; a later session removes abandoned directories/database records using Web Locks. Active sessions are protected by lifetime locks. When locks are unavailable, other sessions are left alone rather than deleted based on their age.

This is temporary working storage, not project recovery. Reloading starts a new document. Export before closing/reloading; browser storage may also be evicted or limited in private browsing.

## Browser validation

Validation used native Chrome 152 and Safari 27 on macOS, not a mocked Canvas renderer. The browser harnesses live in `scripts/browser/` and are excluded from the production bundle.

Final results: **34 Jest tests passed**, production build and ESLint passed, and **12 storage/pixel checks plus 14 editor interaction checks passed in each browser**. Native-resolution PNG output matched the original fixture exactly. Both browsers successfully copied PNG through a real click and recognized both lines of the OCR fixture. Rotated output passed the interior alpha seam check; Safari's alpha differed by 2/255 at one antialiased outer-edge pixel. [Detailed check results](image-storage-validation.json) are recorded alongside the measurements.

Run `npm run build`, then `npm run test:browser`. The server prints URLs and a temporary directory for JSON results:

- `/engine-check.html`: native pixels, repeated scaling, brush/eraser tile boundaries, crop, alpha/rotation, SVG fallback, simultaneous sessions, forced IndexedDB/memory fallbacks, and disposal.
- `/?uicheck=all`: upload/paste/drop, move, drawing, undo/redo, duplicate independence, visibility/opacity, crop/resize, explicit sizes, PNG/JPEG/quality, reset during import/stroke, and simulated touch input. Generated fixtures and intercepted downloads keep the check self-contained.
- `/?uicheck=ocr`: generates a clean text fixture. Click **Run OCR** and inspect the text/overlay. Clipboard copying must also be tested through a real user click; synthetic clicks cannot establish clipboard permission.
- `/ram-check.html?mode=baseline` and `?mode=tiled`: matching 12-megapixel/30-stroke workloads. Use a fresh tab for each. The baseline comes from commit `194c6a4ea01af99e2ad3eacec5a4242c8ae68970`; `RASTER_BASELINE_REVISION` can override it.

The macOS RSS sampler is `python3 scripts/browser/memory-monitor.py /tmp/browser-memory.jsonl`. It samples once per second. Match the test renderer's PID and timestamps to the workload JSON. Do not sum unrelated tabs into a test result.

### Measured memory and latency

The workload imports a 4000 × 3000 image fitted to a 600 × 480 document, applies 30 identical short strokes, retains 30 undo states, waits for a steady reading, exports a 4000 × 3000 PNG, and resets. The preview stays visible. Baseline and tiled variants ran in fresh tabs; Safari reused its existing content/graphics processes. The benchmark exercises the raster pipeline, not the entire React UI or automatic size calculations.

| Native process RSS at steady state | Original canvases | Disk-backed tiles |
| --- | ---: | ---: |
| Chrome renderer | 1,920 MiB | 384 MiB |
| Safari content process | 192 MiB | 245 MiB |
| Safari active graphics process | 1,475 MiB | 236 MiB |
| Safari content + graphics, summed | 1,666 MiB | 481 MiB |

Chrome's sampled renderer peak was 2,112 MiB before and 423 MiB afterward. Safari keeps much of the original Canvas allocation in its graphics process, so its content-process reading alone is misleading. The approximately 80% Chrome renderer reduction and 71% Safari summed reduction are observations from this workload, not general browser-RAM guarantees.

| Operation | Chrome original / tiled | Safari original / tiled |
| --- | ---: | ---: |
| Median stroke, including persistence and preview | 133 / 80 ms | 39 / 74 ms |
| Full-resolution PNG export | 75 / 161 ms | 129 / 496 ms |

Both tiled runs retained about 183 MiB on disk for 30 snapshots. Their decoded caches were about 44 MiB at steady state and stayed below 48 MiB at peak. After reset, the worker reported zero tile files, stored bytes, raster versions, and cached bytes. Process RSS remained above its initial value because browser/native allocations are not immediately returned to the OS.

These are one-second RSS samples from one local run per variant. They include native allocations within the measured processes, but exclude compressed/swapped memory, Chrome's graphics process, and OS filesystem cache. Safari's shared graphics process can include other tabs, and summing processes can double-count shared pages. This is evidence of reduced live canvas allocation, not a complete per-tab physical-memory accounting. [Recorded measurements and workload timestamps](image-memory-measurements.json) make the comparison inspectable.
