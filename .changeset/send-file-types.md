---
'@ixo/oracle-runtime-workers': patch
---

`send_file` sends only the types the channel gateway delivers: PDF, Word (`.docx`), Excel (`.xlsx`), PowerPoint (`.pptx`), text, CSV, Markdown, PNG and JPEG.

- Any other extension, the legacy `.doc`, `.xls` and `.ppt` included, fails the call before the file is signed, with an error that names the types and tells the model to convert the file or describe its contents.
- The tool description and the chat surface bullet for `send_file` name the same types, and tell the model to build the file in the sandbox rather than send a file downloaded from the internet, unless the user asked for that exact file. The Portal and non-chat surfaces are unchanged.
