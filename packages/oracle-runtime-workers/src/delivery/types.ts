/**
 * Chat delivery: how a finished turn reaches a chat surface (an IXO Channels
 * provider such as WhatsApp, or a Matrix room) as a few short messages and
 * artefact links instead of the one streamed document the Portal renders.
 *
 * Plain data only. The Matrix gateway script imports these types without the
 * agent core, and IXO Channels reads the same shapes off `/channels/turn`.
 */

/** Size and shape limits the shaper enforces on one chat surface. */
export interface ChatLimits {
  /** Soft size of one message, in characters. */
  bubbleTarget: number;
  /** Hard size of one message before it is split at a sentence boundary. */
  bubbleMax: number;
  /** Fragments shorter than this merge into the message that follows. */
  minBubble: number;
  /** Messages one model step may become before it moves to an artefact. */
  maxBubbles: number;
  /** Parts one run may deliver in total. */
  maxPartsPerRun: number;
  /** A step longer than this moves to an artefact. */
  spillChars: number;
  /** A longer list moves to an artefact, previewed by its first items. */
  maxListItems: number;
  /** List items kept in the message when a list moves to an artefact. */
  previewItems: number;
  /** A longer code block moves to an artefact. */
  maxCodeLines: number;
  /** Whether a Markdown table may stay inside a message. */
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
  /** Viewer link. Its decryption key sits after `#` and never reaches a server. */
  url: string;
  mime: 'text/markdown';
  bytes: number;
  expiresAt: string;
}

/**
 * One delivery unit. `text` carries chat Markdown: bold, italic, strike,
 * inline code, fenced code, `-` and `1.` lists, `>` quotes and links. No
 * headings, tables or raw HTML reach a text part.
 */
export type ReplyPart =
  | { partId: string; kind: 'text'; text: string }
  | { partId: string; kind: 'artifact'; artifact: ArtifactRef };

/** A part before it is numbered: what a plan is assembled from. */
export type ReplyContent =
  | { kind: 'text'; text: string }
  | { kind: 'artifact'; artifact: ArtifactRef };

/** What a chat surface delivers for one finished run, in delivery order. */
export interface ReplyPlan {
  v: 1;
  parts: ReplyPart[];
}
