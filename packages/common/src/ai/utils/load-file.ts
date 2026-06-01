import { Logger } from '@ixo/logger';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { HtmlToTextTransformer } from '@langchain/community/document_transformers/html_to_text';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import fs from 'node:fs/promises';
// `@langchain/community`'s `PDFLoader` / `WebPDFLoader` both import
// `pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js` — a subpath that pdf-parse 2.x
// no longer exposes in its `exports` field, throwing `ERR_PACKAGE_PATH_NOT_EXPORTED`
// at runtime. We use pdfjs-dist (the same engine LangChain wraps) directly
// and keep one Document per page so callers can preserve page boundaries.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

type SupportedFileType = 'pdf' | 'markdown' | 'html' | 'text' | 'doc';
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 200,
});

const determineFileType = (
  path: string,
  contentType?: string,
): SupportedFileType | null => {
  const extension = path.split('.').pop()?.toLowerCase();

  // Determine based on file extension
  if (extension) {
    if (['pdf'].includes(extension)) return 'pdf';
    if (['md', 'markdown'].includes(extension)) return 'markdown';
    if (['html', 'htm'].includes(extension)) return 'html';
    if (['txt'].includes(extension)) return 'text';
    if (['doc', 'docx'].includes(extension)) return 'doc';
  }

  // Determine based on MIME type
  if (contentType) {
    if (contentType.includes('application/pdf')) return 'pdf';
    if (contentType.includes('text/markdown')) return 'markdown';
    if (contentType.includes('text/html')) return 'html';
    if (contentType.includes('text/plain')) return 'text';
    if (
      contentType.includes('application/msword') ||
      contentType.includes(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
    ) {
      return 'doc';
    }
  }

  return null;
};

/**
 * Loads a file (PDF, Markdown, HTML, Text, DOC) from a given path or URL and returns processed content.
 *
 * @param path - The file path or URL of the document to load.
 * @param fetchOptions - Optional fetch options (e.g., headers for authorization).
 * @returns A promise that resolves to an array of Document objects.
 * @throws If the file type is unsupported or the file cannot be processed.
 */
export const loadFile = async (
  path: string,
  fetchOptions?: RequestInit,
): Promise<Document[]> => {
  const isUrl = path.startsWith('http');

  if (isUrl) {
    try {
      const response = await fetch(path, fetchOptions);

      if (!response.ok) {
        const error = await getErrorFromResponse(response);
        // eslint-disable-next-line no-console -- debug
        console.error(`Error fetching file from URL: ${path}`, error);
        throw new Error(`Failed to fetch file from URL: ${path}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const fileType = determineFileType(path, contentType);

      if (!fileType) {
        throw new Error(`Unsupported file type. Content-Type: ${contentType}`);
      }

      const data = await response.arrayBuffer();
      const blob = new Blob([data], {
        type: contentType || 'application/octet-stream',
      });

      return processFile(blob, fileType);
    } catch (error) {
      Logger.error(`Failed to load file from URL: ${path}`, error);
      throw error;
    }
  }

  try {
    const buffer = await fs.readFile(path);
    const blob = new Blob([buffer]);

    const fileType = determineFileType(path);

    if (!fileType) {
      throw new Error(`Unsupported file type for file: ${path}`);
    }

    return processFile(blob, fileType);
  } catch (error) {
    Logger.error(`Failed to load local file from path: ${path}`, error);
    throw error;
  }
};

/**
 * Loads a file from a buffer and returns processed content.
 * Useful when you already have the file data (e.g., downloaded from Matrix).
 */
export const loadFileFromBuffer = async (
  buffer: Buffer,
  mimetype: string,
  filename?: string,
): Promise<Document[]> => {
  const fileType = determineFileType(filename ?? '', mimetype);
  if (!fileType) {
    throw new Error(`Unsupported file type: ${mimetype}`);
  }
  const blob = new Blob([buffer], { type: mimetype });
  return processFile(blob, fileType);
};

const processFile = async (
  blob: Blob,
  fileType: SupportedFileType,
): Promise<Document[]> => {
  switch (fileType) {
    case 'pdf': {
      return loadPdf(blob);
    }

    case 'markdown': {
      return loadMarkdown(blob);
    }

    case 'html': {
      const html = await blobToString(blob);
      const htmlSplitter = RecursiveCharacterTextSplitter.fromLanguage('html');
      const transformer = new HtmlToTextTransformer();
      const sequence = htmlSplitter.pipe(transformer);
      const docs = await sequence.invoke([
        new Document({
          pageContent: html,
        }),
      ]);
      return docs;
    }

    case 'text':
      return splitter.createDocuments([await blobToString(blob)]);

    case 'doc': {
      const docxLoader = new DocxLoader(blob);
      return docxLoader.load();
    }

    default:
      throw new Error(`Unsupported file type: ${fileType as string}`);
  }
};

const loadMarkdown = async (blob: Blob): Promise<Document[]> => {
  const markdown = await blobToString(blob);
  return splitter.createDocuments([markdown]);
};

const loadPdf = async (blob: Blob): Promise<Document[]> => {
  const data = new Uint8Array(await blob.arrayBuffer());
  // Mirror the parser options LangChain's WebPDFLoader used — disable worker
  // fetch / eval so this runs cleanly in a Node server context.
  const pdf = await getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const documents: Document[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    if (content.items.length === 0) continue;
    let lastY: number | undefined;
    const parts: string[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      // Insert a newline when the y-coordinate changes — preserves visual
      // line breaks instead of running text together.
      if (lastY !== undefined && lastY !== item.transform[5]) {
        parts.push('\n');
      }
      parts.push(item.str);
      lastY = item.transform[5];
    }
    documents.push(
      new Document({
        pageContent: parts.join(''),
        metadata: {
          pdf: {
            version: (pdf as unknown as { _pdfInfo?: { fingerprint?: string } })
              ._pdfInfo?.fingerprint,
            info: meta?.info,
            totalPages: pdf.numPages,
          },
          loc: { pageNumber: i },
        },
      }),
    );
  }
  return documents;
};

const blobToString = async (blob: Blob): Promise<string> => {
  const buffer = await blob.arrayBuffer(); // Convert Blob to ArrayBuffer
  return Buffer.from(buffer).toString('utf-8'); // Convert ArrayBuffer to string
};

const getErrorFromResponse = async (response: Response): Promise<unknown> => {
  try {
    const json = await response.json();

    return json;
  } catch (_error) {
    if (response.bodyUsed) return 'Unknown error';
    const errorMessage = await response.text();
    return errorMessage;
  }
};
