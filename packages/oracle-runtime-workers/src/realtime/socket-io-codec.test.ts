import { describe, expect, it } from 'vitest';
import {
  decodeClientFrame,
  encodeAck,
  encodeConnectAck,
  encodeConnectError,
  encodeDisconnect,
  encodeEvent,
  encodeOpen,
} from './socket-io-codec';

describe('socket.io codec', () => {
  it('encodes the engine.io OPEN handshake the way socket.io-client expects', () => {
    const frame = encodeOpen({
      sid: 'abc',
      pingIntervalMs: 25_000,
      pingTimeoutMs: 20_000,
      maxPayloadBytes: 1_000_000,
    });
    expect(frame).toBe(
      '0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}',
    );
  });

  it('encodes CONNECT ack, CONNECT_ERROR, EVENT, ACK and DISCONNECT packets', () => {
    expect(encodeConnectAck('s1')).toBe('40{"sid":"s1"}');
    expect(encodeConnectError('Unauthorized')).toBe(
      '44{"message":"Unauthorized"}',
    );
    expect(encodeConnectError('nope', { code: 1 })).toBe(
      '44{"message":"nope","data":{"code":1}}',
    );
    expect(encodeEvent('connected', { sessionId: 'x' })).toBe(
      '42["connected",{"sessionId":"x"}]',
    );
    expect(encodeEvent('bare')).toBe('42["bare"]');
    expect(encodeAck(12)).toBe('4312[]');
    expect(encodeAck(3, [{ ok: true }])).toBe('433[{"ok":true}]');
    expect(encodeDisconnect()).toBe('41');
  });

  it('decodes the client frames socket.io-client actually sends', () => {
    expect(decodeClientFrame('3')).toEqual({ kind: 'pong' });
    expect(decodeClientFrame('2')).toEqual({ kind: 'ping' });
    expect(decodeClientFrame('1')).toEqual({ kind: 'close' });
    expect(decodeClientFrame('40')).toEqual({
      kind: 'connect',
      auth: undefined,
    });
    expect(
      decodeClientFrame('40{"invocation":"tok","ucanDelegation":"d"}'),
    ).toEqual({
      kind: 'connect',
      auth: { invocation: 'tok', ucanDelegation: 'd' },
    });
    expect(decodeClientFrame('41')).toEqual({ kind: 'disconnect' });
    expect(
      decodeClientFrame(
        '42["tool_result",{"toolCallId":"tc-1","result":{"ok":true}}]',
      ),
    ).toEqual({
      kind: 'event',
      name: 'tool_result',
      args: [{ toolCallId: 'tc-1', result: { ok: true } }],
    });
    expect(decodeClientFrame('4212["ev",{"a":1}]')).toEqual({
      kind: 'event',
      name: 'ev',
      args: [{ a: 1 }],
      ackId: 12,
    });
    expect(decodeClientFrame('437["done"]')).toEqual({
      kind: 'ack',
      id: 7,
      args: ['done'],
    });
    // Explicit default namespace is accepted.
    expect(decodeClientFrame('42/,["ping"]')).toEqual({
      kind: 'event',
      name: 'ping',
      args: [],
    });
  });

  it('never throws on frames outside the supported subset', () => {
    for (const raw of [
      '',
      '9',
      '4',
      '47',
      '42/admin,["x"]',
      '451-["bin",{"_placeholder":true,"num":0}]',
      '42{"not":"an array"}',
      '42[1]',
      '42["ev",{broken',
      '43[]',
      '44{"message":"server only"}',
    ]) {
      const frame = decodeClientFrame(raw);
      expect({ raw, kind: frame.kind }).toEqual({ raw, kind: 'unsupported' });
    }
  });
});
