/* eslint-disable no-console */
import {
  DeviceUnsupportedError,
  ExternalE2EEKeyProvider,
  Room,
  RoomEvent,
} from 'livekit-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useMutation } from '@tanstack/react-query';
import { type IOpenIDToken } from 'matrix-js-sdk';
import { useOraclesConfig } from '../../../hooks/use-oracles-config.js';
import { useOraclesContext } from '../../../providers/oracles-provider/oracles-context.js';
import useConnectionDetails from './use-connection-details.js';

export type ToastFn = ({
  title,
  description,
}: {
  title: string;
  description: string;
}) => void;
const fakeToast: ToastFn = ({ title, description }) => {
  console.log(title, description);
};

export function useLiveKitAgent(
  idToken: IOpenIDToken,
  oracleDid: string,
  toastAlert: ToastFn = fakeToast,
  overrides?: {
    baseUrl?: string;
  },
) {
  const [sessionStarted, setSessionStarted] = useState(false);
  const [sessionViewVisible, setSessionViewVisible] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const { authedRequest } = useOraclesContext();
  const { config, isReady: isConfigReady } = useOraclesConfig(oracleDid, {
    baseUrl: overrides?.baseUrl,
  });
  // Use ref to store current call info without causing re-renders
  const currentCallRef = useRef<{
    callId: string;
    encryptionKey: string;
  } | null>(null);

  // Lazy initialization - only create these when actually needed
  const keyProvider = useMemo(() => new ExternalE2EEKeyProvider(), []);

  // The worker and the room are disposed on unmount. A component that is
  // mounted again with the same hook state (StrictMode runs effects twice)
  // gets a new pair through this generation.
  const [generation, setGeneration] = useState(0);

  const worker: Worker | undefined = useMemo(() => {
    // Only create worker in browser environment
    if (typeof window === 'undefined') {
      return undefined;
    }
    return new Worker(new URL('livekit-client/e2ee-worker', import.meta.url));
  }, [generation]);

  const roomOptions = useMemo(() => {
    return {
      e2ee: worker ? { keyProvider, worker } : undefined,
      adaptiveStream: true,
      dynacast: true,
    };
  }, [keyProvider, worker]);

  // Room is created lazily but still on mount - this is acceptable since
  // this hook should only be called when user wants voice/video capability
  const room = useMemo(() => new Room(roomOptions), [roomOptions]);

  const { refreshConnectionDetails, existingOrRefreshConnectionDetails } =
    useConnectionDetails();

  // Setup event listeners - useEffect is needed for proper cleanup on unmount
  useEffect(() => {
    const onDisconnected = () => {
      setSessionStarted(false);
      setSessionViewVisible(false);
      setIsConnecting(false);
      // Use the ref to get current call info
      if (currentCallRef.current?.callId) {
        void refreshConnectionDetails(currentCallRef.current.callId, idToken);
      }
    };

    const onMediaDevicesError = (error: Error) => {
      toastAlert({
        title: 'Encountered an error with your media devices',
        description: `${error.name}: ${error.message}`,
      });
    };

    const onEncryptionError = (error: Error) => {
      console.error('Encryption error:', error);
      toastAlert({
        title: 'Encryption error',
        description: `${error.name}: ${error.message}`,
      });
    };

    const onConnected = () => {
      setSessionViewVisible(true);
      setIsConnecting(false);
    };

    // Set up event listeners
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.EncryptionError, onEncryptionError);
    room.on(RoomEvent.Connected, onConnected);

    // Cleanup function - this is why we need useEffect!
    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      room.off(RoomEvent.EncryptionError, onEncryptionError);
      room.off(RoomEvent.Connected, onConnected);
    };
  }, [room, refreshConnectionDetails, idToken, toastAlert]);
  const { mutateAsync: updateCall, isPending: _isUpdating } = useMutation({
    mutationFn: async ({
      callId,
      callStatus,
      callStartedAt,
      callEndedAt,
    }: {
      callId: string;
      callStatus?: 'active' | 'ended';
      callStartedAt?: string;
      callEndedAt?: string;
    }) => {
      if (!callId) {
        throw new Error('Call ID is required');
      }

      const response = await authedRequest(
        `${config.apiUrl}/calls/${callId}/update`,
        'PATCH',
        {
          body: JSON.stringify({
            callStatus,
            callStartedAt,
            callEndedAt,
          }),
        },
        oracleDid,
      );

      return response;
    },
  });
  const updateCallRef = useRef(updateCall);
  updateCallRef.current = updateCall;

  // Unmounting during a call leaves the room (the microphone is released),
  // marks the call ended and stops the E2EE worker.
  const disposedRoomRef = useRef<Room | null>(null);
  useEffect(() => {
    if (disposedRoomRef.current === room) {
      setGeneration((n) => n + 1);
      return;
    }
    return () => {
      disposedRoomRef.current = room;
      const call = currentCallRef.current;
      currentCallRef.current = null;
      void room.disconnect();
      worker?.terminate();
      if (call) {
        updateCallRef
          .current({
            callId: call.callId,
            callStatus: 'ended',
            callEndedAt: new Date().toISOString(),
          })
          .catch((error: unknown) => {
            console.error('Failed to mark the call ended:', error);
          });
      }
    };
  }, [room, worker]);

  // Public API
  const startCall = useCallback(
    async ({
      callId,
      encryptionKey,
    }: {
      callId: string;
      encryptionKey: string;
    }) => {
      if (!callId) {
        throw new Error('Call ID is required');
      }
      if (!encryptionKey) {
        throw new Error('Encryption key is required');
      }

      try {
        // Store call params in ref (no re-render)
        currentCallRef.current = { callId, encryptionKey };

        setSessionStarted(true);
        setIsConnecting(true);

        // E2EE setup
        console.debug('Setting up E2EE with key');
        await keyProvider.setKey(encryptionKey);
        await room.setE2EEEnabled(true);

        // Get connection details
        const connectionDetails = await existingOrRefreshConnectionDetails(
          callId,
          idToken,
        );
        if (!connectionDetails) {
          throw new Error('Connection details not found');
        }

        // Connect to room
        console.debug('Connecting to room', { callId });
        await room.prepareConnection(
          connectionDetails.url,
          connectionDetails.jwt,
        );
        await room.connect(connectionDetails.url, connectionDetails.jwt);
        console.debug('Connected to room', room);

        try {
          // Set up microphone
          const initialSelection = localStorage.getItem(
            `${'audioinput'}_device_id`,
          );
          await room.localParticipant.setMicrophoneEnabled(
            true,
            {
              deviceId: initialSelection ?? undefined,
            },
            {
              preConnectBuffer: true,
            },
          );
        } catch (error) {
          console.error('Error setting up microphone:', error);
        }
        await updateCall({
          callId,
          callStatus: 'active',
          callStartedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error('Start call error:', error);
        setIsConnecting(false);
        setSessionStarted(false);
        setSessionViewVisible(false);
        currentCallRef.current = null;

        if (error instanceof DeviceUnsupportedError) {
          toastAlert({
            title: 'E2EE Not Supported',
            description:
              'Your browser does not support E2EE. Please update to the latest version and try again.',
          });
        } else {
          toastAlert({
            title: 'Connection Error',
            description: `Failed to start call: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        throw error;
      }
    },
    [
      keyProvider,
      room,
      existingOrRefreshConnectionDetails,
      idToken,
      toastAlert,
      config.apiUrl,
      authedRequest,
    ],
  );

  const endCall = useCallback(async () => {
    setSessionStarted(false);
    setSessionViewVisible(false);
    setIsConnecting(false);
    await room.disconnect();
    if (currentCallRef.current?.callId) {
      await updateCall({
        callId: currentCallRef.current.callId ?? '',
        callStatus: 'ended',
        callEndedAt: new Date().toISOString(),
      });
    }
    currentCallRef.current = null;
  }, [room, updateCall, currentCallRef]);

  return {
    room,
    sessionStarted,
    sessionViewVisible,
    startCall,
    endCall,
    isConnecting,
    isReady: sessionViewVisible,
    isConfigReady,
  };
}
