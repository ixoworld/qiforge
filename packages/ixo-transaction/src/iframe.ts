import { renderSigningPayload } from './render.js';
import { IframeEventSchema, type IframeEvent } from './schemas.js';

export function renderIframeEvent(input: unknown): IframeEvent {
  return IframeEventSchema.parse({
    protocol: 'ixo.portal.iframe.v1',
    version: '1.0',
    type: 'EVENT',
    payload: renderSigningPayload(input),
  });
}
