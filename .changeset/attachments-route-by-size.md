---
'@ixo/oracle-runtime-workers': minor
---

Attachments now reach the model by size, the same for Portal, Matrix and channel files. A document (PDF, Office) is sent as a native file block only when the model reads files and its downloaded length is at most 81,920 bytes (`NATIVE_DOCUMENT_MAX_BYTES`); a declared size over the limit skips the native download, and a wrong or missing declared size cannot slip a large file through. A larger document goes through the extract lane: helper-model text, a sandbox copy, and a 500-character excerpt with the sandbox path. Before, any document went natively to a file-reading model, so a 600 KB PDF became ~200k tokens on every model call and could reset the user's Durable Object. `view_attachment` follows the same rule.

Images still go natively to a vision model. With the new optional Cloudflare Images binding (`"images": { "binding": "IMAGES" }`), an image with either side over 1568 px is downscaled to fit 1568 × 1568 px (long edge 1568 px) as a JPEG at quality 82 before the model sees it (`resizeForModel`); the sandbox keeps the original. Without the binding, or on a binding error, images are sent unchanged. Cloudflare bills $0.50 per 1,000 unique transformations after 5,000 free a month.
