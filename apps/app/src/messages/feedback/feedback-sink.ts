import type { AnonymousMessageFeedbackContextDto } from '../dto/message-feedback.dto';

export const FEEDBACK_SINK = Symbol('FEEDBACK_SINK');

export interface AnonymousFeedbackIssue {
  submissionId: string;
  feedback: string;
  submittedAt: string;
  userPseudonym: string;
  sessionFingerprint: string;
  messageFingerprint: string;
  agent: {
    did: string;
    name: string;
    model: string;
    provider: string;
    runtimeBuildVersion: string;
  };
  context: AnonymousMessageFeedbackContextDto;
}

export interface FeedbackSink {
  isConfigured(): boolean;
  submit(issue: AnonymousFeedbackIssue): Promise<void>;
}
