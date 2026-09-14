# Temporary image storage

The unified editor keeps original-resolution pixels in immutable 512 × 512 RGBA tiles. The worker writes tiles to the origin-private file system (OPFS), with IndexedDB as the disk-storage fallback. If both are unavailable, the editor reports that it is using a limited memory store. Images are processed locally; no image-storage server is involved.

Layers contain raster IDs, dimensions, bounds, and transforms. Undo snapshots and duplicated layers share tile references. Brush/eraser edits replace affected tiles; cropping shares interior tiles, removes excluded tiles, and rewrites boundary tiles. Transforming or resizing changes metadata. Full-resolution source pixels remain available when a fitted layer is enlarged later.

## Budgets and tradeoffs

| Resource | Budget / behavior |
| --- | --- |
| Clean/dirty native tiles and retained preview surfaces together | 80 MiB, clean LRU cache shrinks as dirty tiles or preview surfaces grow |
| Unpersisted stroke tiles | 32 MiB maximum, included in the 80 MiB pool; pressure spills to disk |
| Retained source preview surfaces | At most 16 MiB, included in the same 80 MiB pool |
| Tile working surfaces | 16 MiB allowance; source sampling patches are bounded |
| Live drawing planes | At most 24 MiB including installation; retained planes use at most 18 MiB |
| Accepted drawing coordinates | 4 MiB including one 64 KiB transferable batch; at most 2,048 stroke headers |
| Temporary disk data | 2 GiB per editor session, subject to the browser's available quota |
| Memory-only storage fallback | 256 MiB; a separate limit from the decoded tile cache |
| Undo | Up to 30 snapshots, sharing unchanged tiles |
| Waiting pixel operations | One active operation and at most one queued operation |
| Main canvas | Visible viewport dimensions × device pixel ratio |

The 96 MiB tile-work budget is **not a cap on browser RAM**. The live drawing planes and coordinate journal have separate limits. Initial image decoding, a full-resolution export surface and its encoder, the main viewport canvas, OCR, browser allocators, GPU resources, and filesystem caching require additional memory. Very large imports/exports can still create substantial peaks. Browsers decide when freed allocations are returned to the OS.

### Reusable source previews

Viewport rendering can retain a committed source level as a Canvas 2D surface when its dimensions are at most 4,096 pixels per side and its RGBA allocation fits the 16 MiB preview allowance. Moving, rotating, changing opacity, and panning reuse it instead of reconstructing overlapping patches from raw tile arrays. The renderer still copies bounded sampling patches before transforming them: directly scaling a retained full source changed Safari's filtering in browser comparisons.

Preview allocation reserves room in the existing 80 MiB pool before reading source tiles. Once assembled, the surface replaces that level's clean pixel-cache entries; original tiles remain in temporary storage. Sources already used in a frame are protected from eviction for the rest of that frame, so documents larger than the preview allowance use the original patch path for the remaining layers instead of continually rebuilding every cached layer.

Writes, transparent-tile deletion, history collection, context loss/restoration, and reset invalidate or release the relevant surfaces. Active stroke versions bypass this cache. Full-resolution exports retain their original rendering and encoding path. Crop shading and handles use a noninteractive SVG overlay, so dragging them does not request new image frames or retain another bitmap.

Idle layer opacity, visibility, and name changes preserve in-flight drawing preparation, allowing the drawing controller to coalesce intermediate metadata into the latest requested view. They no longer cancel and requeue preparation or briefly block subsequent slider changes. Accepted strokes still finish before metadata changes are applied.

This uses the existing Canvas 2D renderer; the browser chooses its graphics backing. It does not introduce WebGPU or request a high-performance GPU. The opt-in `/preview-check.html` harness compares the cache disabled/enabled, reports cold and repeated render timings for shared and independent 12-megapixel sources, and verifies pixel output, cache reuse, the combined memory allowance, and reset cleanup. Keep the browser foregrounded. Each submission waits for an animation frame before starting its clock, and hidden or stalled runs are invalid for timing. Timings cover worker rendering, bitmap delivery, and canvas presentation calls; they do not measure GPU completion, physical display latency, energy use, or whole-browser RAM. Reduced preview comparisons allow at most one channel unit and mean difference 0.001; native and PNG comparisons remain exact.

On September 14, 2026, Chrome 152 and Safari 27 each passed all 16 preview checks on this Mac. The following measurements use 30 paced frames per case, after warmup; the values are cache disabled → enabled, in milliseconds. [Recorded runs](preview-performance-validation.json) include cold timings, individual frames, pixel differences, and memory counters.

| Browser / workload | Median render work | p95 render work |
| --- | --- | --- |
| Chrome, three layers sharing a source, 1000 × 750 | 2.6 → 1.0 | 8.4 → 3.7 |
| Chrome, three independent sources, 800 × 600 | 2.9 → 1.4 | 14.9 → 3.5 |
| Chrome, three independent sources, 1600 × 1200 | 18.6 → 20.1 | 62.0 → 41.9 |
| Safari, three layers sharing a source, 1000 × 750 | 27 → 18 | 34 → 21 |
| Safari, three independent sources, 800 × 600 | 26 → 18 | 29 → 20 |
| Safari, three independent sources, 1600 × 1200 | 81 → 72 | 87 → 80 |

The largest Chrome case had a slightly higher median despite an improved p95; these are workload observations, not universal speedup claims. Neither pressure case rebuilt admitted source surfaces during its measured frames, and combined resident allocations stayed within 80 MiB. The harness uses memory-backed storage to exclude disk variability, so its counters do not demonstrate reduced physical RAM: that storage still owns the original arrays. Battery use was not measured.

The production build, ESLint, and all 85 Jest tests pass. Chrome and Safari each also pass 12 native engine checks, 14 editor interaction checks, and the pending-drawing barrier check with 250 ms artificial worker delays. Crop drags at fit and zoom/pan issue zero worker render requests, opacity changes reach the final value, and PNG export/undo checks preserve source pixels. [Editor validation summary](preview-editor-validation.json) records these results.

Raw tiles trade disk space for fast reads and exact pixels. Smaller preview levels reduce preview rendering cost. A cold image or a large export may take longer than it did with every original canvas already in RAM.

Brush and eraser feedback uses three bounded viewport planes: layers below the active layer, the editable active layer at full opacity, and layers above it. Animation frames apply accepted coordinates directly to the active plane and composite its opacity once. Erasing reveals the lower layers. Source and document clipping remain in effect, including transformed layers. The planes are prepared when the view or active layer changes; input arriving during preparation is buffered.

The worker processes the same strokes in order using original-resolution tiles. Ordinary pointer batches reuse private dirty tiles without disk writes, mip rebuilding, or collection. Finishing a stroke flushes those tiles, rebuilds affected preview levels, and commits the authoritative bounds. The optimistic display stays visible until all accepted strokes are painted and acknowledged. Each stroke gets its own undo step, and new strokes can begin while earlier strokes save. Thumbnails wait until drawing is idle.

Undo/redo, exports, OCR preparation, and changes to the layers, document, tools, or view drain accepted drawing first. Reset cancels immediately. If exceptional storage delay exhausts the coordinate/header budget, the editor shows **Saving strokes—drawing paused** and preserves the accepted prefix. Drawing resumes only after pointer release and after the queue falls below half its limit. Failed persistence reverts the failed stroke and dependent pending strokes, reports their count, and restores the last acknowledged document.

**Calculate sizes** explicitly encodes PNG and JPEG, sequentially. Editing does not continually encode both formats. Changing quality invalidates the JPEG size; changing the composition invalidates both. Download/copy also computes the requested format's size. Only in-flight encodes are shared; encoded exports are not retained as an extra cache. PNG clipboard writes receive a promised Blob during the user click to preserve Safari's user activation.

OCR is composed directly at its processing resolution, avoiding an extra full-document intermediate. Its preparation surface and Tesseract worker are released afterward.

## Failure and cleanup behavior

New pixels are persisted before a document edit is committed. On quota pressure, the worker first discards inactive preview levels, then removes older undo snapshots with a notice. The current document remains protected. If space still cannot be freed, the edit fails and the previous document remains usable.

Reset invalidates pending work, releases the viewport, and disposes the session's worker, cache, and storage. Component unmount also disposes its worker. A closed/crashed tab can leave temporary files; a later session removes abandoned directories/database records using Web Locks. Active sessions are protected by lifetime locks. When locks are unavailable, other sessions are left alone rather than deleted based on their age.

This is temporary working storage, not project recovery. Reloading starts a new document. Export before closing/reloading; browser storage may also be evicted or limited in private browsing.

## Browser validation

Validation used native Chrome 152 and Safari 27 on macOS, not a mocked Canvas renderer. The browser harnesses live in `scripts/browser/` and are excluded from the production bundle.

The live drawing revision passes **65 Jest tests**, production build and ESLint. Native Chrome and Safari each pass **12 storage/pixel checks, 14 editor interaction checks, and seven drawing checks with 250 ms of artificial delay on each stroke mutation request**. The drawing checks cover continuous input, 20 rapid independently undoable strokes, new-layer bounds and pointer endpoints, layered erasing, reset during saving, pending-operation barriers, and transformed-layer clipping. Native-resolution PNG output matches the original fixture exactly, including after editing a duplicate. Viewport comparisons permit a one-unit channel rounding difference with a mean difference no greater than 0.001; native PNG comparisons remain exact.

Both browsers also passed native pointer drags before and after OCR, recognized both fixture lines, selected an OCR word, and copied PNG through a native click. Selecting Brush clears the OCR selection overlay and permits drawing again. The earlier storage rollout's [validation results](image-storage-validation.json), including rotation checks, remain available separately; they predate the live drawing revision.

Run `npm run build`, then `npm run test:browser`. The server prints URLs and a temporary directory for JSON results:

- `/engine-check.html`: native pixels, repeated scaling, brush/eraser tile boundaries, crop, alpha/rotation, SVG fallback, simultaneous sessions, forced IndexedDB/memory fallbacks, and disposal.
- `/?uicheck=all`: upload/paste/drop, move, drawing, undo/redo, duplicate independence, visibility/opacity, crop/resize, explicit sizes, PNG/JPEG/quality, reset during import/stroke, and simulated touch input. Generated fixtures and intercepted downloads keep the check self-contained.
- `/?uicheck=ocr`: generates a clean text fixture. Click **Run OCR** and inspect the text/overlay. Clipboard copying must also be tested through a real user click; synthetic clicks cannot establish clipboard permission.
- `/?latencycheck=normal&delayms=250`: click **Ready—click to run tests**, then keep the tab visible and focused until all seven checks finish. Use `&case=continuous` for the five-second 120 Hz stream, or `latencycheck=stress&case=continuous` for the 12-megapixel source and 80-pixel brush. `&autostart=1` skips the start button after foreground checks. `&dpr=1` or `&dpr=2` overrides the app's canvas allocation branch only; reports retain the physical display's native DPR.
- `/ram-check.html?mode=baseline` and `?mode=tiled`: matching 12-megapixel/30-stroke workloads. Use a fresh tab for each. The baseline comes from commit `194c6a4ea01af99e2ad3eacec5a4242c8ae68970`; `RASTER_BASELINE_REVISION` can override it.

The macOS RSS sampler is `python3 scripts/browser/memory-monitor.py /tmp/browser-memory.jsonl`. It samples once per second. Match the test renderer's PID and timestamps to the workload JSON. Do not sum unrelated tabs into a test result.

### Live drawing measurements

These are input-dispatch-to-observed-canvas-pixel timings from a five-second stream of 600 points, after view preparation. They measure live feedback separately from worker completion. The stress fixture fits a 4000 × 3000 source into a 600 × 480 document. The delayed runs add 250 ms to each ordered begin/points/finish worker request while using real native Canvas and OPFS storage.

| Workload | Chrome p95 / maximum | Safari p95 / maximum |
| --- | ---: | ---: |
| Normal, delayed persistence, native DPR 2 | 19 / 24 ms | 38 / 57 ms |
| 12-megapixel source, delayed persistence, native DPR 2 | 20.5 / 28.8 ms | 37 / 42 ms |
| Normal, no artificial delay, app DPR 1 on a DPR 2 display | 22.9 / 29.5 ms | 39 / 64 ms |

All listed streams observed every point. In the stress runs, final persistence still took about 1.1 seconds after pointer release; visible ink continued during that work, and following actions waited for the committed pixels. Combined clean/dirty tile residency stayed at or below 80 MiB, with dirty tiles below 32 MiB.

The harness probes the display through a private 608 × 1 canvas once per animation frame; it does no readback in the input timer. Results record observer CPU time, dispatch drift, frame gaps, focus/visibility changes, and pending work. These are instrumented canvas observations, not physical display scanout or hardware-input timestamps. Background runs or streams stretched by over one second are invalid. Earlier tests that read pixels per input substantially distorted Chrome timing and are excluded. Even the sparse observer overloaded the pre-fix Chrome build, so no Chrome before/after ratio is reported. A valid Safari pre-fix run using the same sparse observer measured a 5,464 ms p95; it demonstrates the old continuous-input starvation rather than a universal speedup ratio.

To compare another build with the same harness, run a second server with `BROWSER_TEST_PORT=4177 BROWSER_TEST_BUILD=/tmp/editor-before-build node scripts/browser/server.cjs`. [Drawing validation results](drawing-latency-validation.json) record the valid runs and baseline limitations.

The repeated 12-megapixel/30-history-state memory workload measured Chrome renderer RSS at about **404 MiB steady and 479 MiB sampled peak**, including export in the peak. Safari reused processes that were still reclaiming allocations from earlier checks, so its current RSS cannot support a clean historical comparison. Both workers stayed below the 80 MiB tile limit and released all owned tile files, stored bytes, versions, and cache bytes on reset. [Current memory measurements](drawing-memory-measurements.json) include process attribution, phase samples, and the Safari warm-process limitation. These native worker workloads exclude the React live drawing planes, whose separate allocation budgets are specified above and covered by controller tests.

### Historical memory and completed-stroke measurements

These measurements predate the live drawing fix. The workload imports a 4000 × 3000 image fitted to a 600 × 480 document, applies 30 identical short strokes, retains 30 undo states, waits for a steady reading, exports a 4000 × 3000 PNG, and resets. The preview stays visible. Baseline and tiled variants ran in fresh tabs; Safari reused its existing content/graphics processes. The benchmark exercises the raster pipeline, not the entire React UI or automatic size calculations. Its completed-stroke times do **not** measure pointer-to-visible latency; waiting for every stroke concealed the continuous-input regression.

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
