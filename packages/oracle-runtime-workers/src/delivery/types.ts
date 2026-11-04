import type { ActionReference } from '@ixo/ixo-transaction/action-proposals';
import type { ActionReferenceV1 } from '@ixo/action-protocol';
/**
 * Chat delivery: how a finished turn reaches a chat surface (an IXO Channels
 * provider such as WhatsApp, or a Matrix room) as a few short messages and
 * artefact links instead of the one streamed document the Portal renders.
 *
 * Plain data only. The Matrix gateway script imports these types without the
 * agent core, and IXO Channels reads the same shapes off `/channels/turn`.
 */

/**
 * Size and shape limits of one chat surface. An ordinary answer stays in
 * chat, as few messages as fit and none longer than `bubbleMax`; only a
 * document-length step (`spillChars`, `maxListItems`, `maxCodeLines`)
 * moves to an artefact.
 */
export interface ChatLimits {
  /** Soft size of one message, in characters; the prompt asks for it. */
  bubbleTarget: number;
  /** Hard size of one message before it is split at a sentence boundary. */
  bubbleMax: number;
  /** Fragments shorter than this merge into the message that follows. */
  minBubble: number;
  /**
   * Preferred messages per answer: the prompt asks for it, and a step with
   * more messages is filled left to right into messages of `bubbleTarget`,
   * then of `bubbleMax` if needed (a code block of at least `minBubble`
   * characters keeps its own message). A
   * preference only: a step that cannot fit stays at more messages, and
   * nothing is spilled or dropped to meet it.
   */
  maxBubbles: number;
  /**
   * Parts one run delivers at most, met by merging text within `bubbleMax`
   * and dropping spill framing. Text found nowhere else is never dropped.
   */
  maxPartsPerRun: number;
  /** A step whose rendered text is longer than this moves to an artefact. */
  spillChars: number;
  /**
   * A list with more items, or a table with more rows, moves to an
   * artefact, previewed by its first items.
   */
  maxListItems: number;
  /** Items or rows kept in the message when a list or table moves to an artefact. */
  previewItems: number;
  /** A code block with more lines moves to an artefact. */
  maxCodeLines: number;
  /**
   * Whether a Markdown table may stay inside a message as a table. Otherwise
   * it is rewritten as one line per row. Only its row count can move it to
   * an artefact (`maxListItems`).
   */
  tables: boolean;
}

/**
 * How one turn's reply is delivered. `stream` is the Portal: SSE frames,
 * nothing reshaped. `chat` builds a Reply Plan under `limits`.
 */
export type DeliveryProfile =
  | { kind: 'stream' }
  | {
      kind: 'chat';
      /** `whatsapp`, `telegram`, `slack`, `matrix` or `generic`. */
      surface: string;
      /** How the prompt names the surface: "WhatsApp", "a Matrix chat room". */
      label: string;
      limits: ChatLimits;
    };

/** A browser-openable document delivered as a link. */
export interface ArtifactRef {
  artifactId: string;
  title: string;
  /**
   * Viewer link. Its decryption key sits after `#`, so R2 and the viewer host
   * never receive it; the oracle stores it with the user's data.
   */
  url: string;
  mime: 'text/markdown';
  bytes: number;
  expiresAt: string;
}

/**
 * A file an oracle made, delivered as an attachment by a gateway (or as a link
 * line where attachments do not exist). `url` is a signed, bearer download
 * link: it never reaches the model, and never a log, metric or error string.
 */
export interface ReplyFile {
  url: string;
  /** Sanitised, from the artefact path, with its extension. */
  filename: string;
  /** From the extension's allow-list: `send_file` refuses any other type. */
  mimetype: string;
  /** Size, when the store reported it. */
  bytes?: number;
  /** Shown with the file, at most 1,024 characters. */
  caption?: string;
  /** When `url` stops working, ISO 8601. */
  expiresAt?: string;
}

/**
 * One delivery unit. `text` carries chat Markdown: bold, italic, strike,
 * inline code, fenced code, `-` and `1.` lists, `>` quotes and links. No
 * headings, tables or raw HTML reach a text part.
 */
export type ReplyPart =
  | { partId: string; kind: 'text'; text: string }
  | { partId: string; kind: 'artifact'; artifact: ArtifactRef }
  | { partId: string; kind: 'file'; file: ReplyFile }
  | { partId: string; kind: 'action'; action: ActionReference }
  | {
      partId: string;
      kind: 'hub-action';
      actionReference: ActionReferenceV1;
      summary: string;
    };

/** A part before it is numbered: what a plan is assembled from. */
export type ReplyContent =
  | { kind: 'text'; text: string }
  | { kind: 'artifact'; artifact: ArtifactRef }
  | { kind: 'file'; file: ReplyFile }
  | { kind: 'action'; action: ActionReference }
  | { kind: 'hub-action'; actionReference: ActionReferenceV1; summary: string };

/** What a chat surface delivers for one finished run, in delivery order. */
export interface ReplyPlan {
  v: 1;
  parts: ReplyPart[];
}
