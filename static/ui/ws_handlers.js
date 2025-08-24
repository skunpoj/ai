// WebSocket message handling extracted from main.js
// Provides a factory to create the onmessage handler with injected context
import { parseWSMessage } from '/static/ui/ws.js';

/**
 * Create a WebSocket onmessage handler bound to the provided context
 * @param {object} ctx - callbacks and state accessors used by the handler
 * Required callbacks:
 *  - onReady()
 *  - onSegmentSaved(data)
 *  - onTranscript(kind, data)
 *  - onSaved(data)
 *  - onPong(data)
 *  - onAuth(data)
 *  - onAck(data)
 */
export function createWsMessageHandler(ctx) {
  return async function(event) {
    try { if (event && typeof event.data !== 'undefined') console.log('[WS][raw]', event.data); } catch(_) {}
    const data = parseWSMessage(event);
    if (!data) return;
    // Branch on message type
    if (data.type === 'ready') {
      if (ctx && ctx.onReady) ctx.onReady();
      return;
    }
    if (data.type === 'segment_saved') {
      if (ctx && ctx.onSegmentSaved) ctx.onSegmentSaved(data);
      return;
    }
    if (data.type === 'segment_transcript' || data.type === 'segment_transcript_google') {
      if (ctx && ctx.onTranscript) ctx.onTranscript('google', data);
      return;
    }
    if (data.type === 'segment_transcript_vertex') {
      if (ctx && ctx.onTranscript) ctx.onTranscript('vertex', data);
      return;
    }
    if (data.type === 'segment_transcript_gemini') {
      if (ctx && ctx.onTranscript) ctx.onTranscript('gemini', data);
      return;
    }
    if (data.type === 'segment_transcript_aws') {
      if (ctx && ctx.onTranscript) ctx.onTranscript('aws', data);
      return;
    }
    if (data.type === 'saved') {
      if (ctx && ctx.onSaved) ctx.onSaved(data);
      return;
    }
    if (data.type === 'pong') {
      if (ctx && ctx.onPong) ctx.onPong(data);
      return;
    }
    if (data.type === 'auth') {
      if (ctx && ctx.onAuth) ctx.onAuth(data);
      return;
    }
    if (data.type === 'ack') {
      if (ctx && ctx.onAck) ctx.onAck(data);
      return;
    }
    // ignore unknowns
  };
}


