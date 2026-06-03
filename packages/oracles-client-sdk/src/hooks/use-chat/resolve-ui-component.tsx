import {
  type BrowserToolCallEventPayload,
  type RenderComponentEventPayload,
  type ToolCallEventPayload,
} from '@ixo/oracles-events';
import { createElement, type ComponentProps } from 'react';

import {
  type SSEActionCallEventData,
  type SSEErrorEvent,
} from '../../utils/sse-parser.js';
import { type Event } from './resolve-content.js';
import { type ToolCallEvent, type UIComponentProps } from './v2/types.js';
import { getToolName } from '../../utils/get-tool-name.js';

export type UIComponents = {
  ToolCall: React.FC<UIComponentProps<ToolCallEvent> & { key: string }>;
  Error: React.FC<{
    id: string;
    args: Record<string, unknown>;
    status?: 'isRunning' | 'done';
    output?: string;
    isLoading?: boolean;
    event?: Event;
    payload?: unknown;
    key: string;
  }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: React.FC<any>;
};

export const resolveUIComponent = (
  componentsMap: UIComponents,
  component: {
    name: string;
    props: {
      id: string;
      args: unknown;
      status?: 'isRunning' | 'done' | 'error';
      output?: string;
      toolName?: string;
      event?: Event;
      payload?:
        | ToolCallEventPayload
        | RenderComponentEventPayload
        | BrowserToolCallEventPayload
        | SSEErrorEvent
        | SSEActionCallEventData;
      isToolCall?: boolean;
      isAgAction?: boolean;
      error?: string;
    };
  },
): React.ReactElement | undefined => {
  if (!isValidProps(component.props.args)) {
    return undefined;
  }

  // Get the component with fallback logic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Component: React.FC<any>;

  if (component.name in componentsMap) {
    // Use custom component if it exists
    Component = componentsMap[component.name]!;
  } else {
    // Fall back to ToolCall component for unknown tool names
    Component = componentsMap.ToolCall;
  }

  const isRunning = component.props.status === 'isRunning';

  // Create props based on component type
  if (component.name === 'Error') {
    const errorComponentProps = {
      id: component.props.id,
      args: component.props.args,
      status: component.props.status,
      output: component.props.output,
      isLoading: isRunning,
      event: component.props.event,
      payload: component.props.payload,
      key: `${component.name}${component.props.id}`,
    };
    return createElement(Component, errorComponentProps);
  }

  if (component.props.isToolCall) {
    const toolCallComponentProps: UIComponentProps<ToolCallEvent> & {
      key: string;
    } = {
      id: component.props.id,
      args: component.props.args,
      status: component.props.status as 'isRunning' | 'done' | undefined,
      output: component.props.output,
      isLoading: isRunning,
      requestId:
        component.props.payload && 'requestId' in component.props.payload
          ? component.props.payload.requestId
          : '',
      sessionId:
        component.props.payload && 'sessionId' in component.props.payload
          ? component.props.payload.sessionId
          : '',
      toolName: getToolName(component.name, component.props.toolName),
      eventId:
        component.props.payload && 'eventId' in component.props.payload
          ? component.props.payload.eventId
          : '',
      key: `${component.name}${component.props.id}`,
    };
    return createElement(Component, toolCallComponentProps);
  }

  if (component.props.isAgAction) {
    // Use AgActionToolCall if available, otherwise fallback to ToolCall
    const AgActionComponent =
      componentsMap.AgActionToolCall || componentsMap.ToolCall;

    const agActionComponentProps = {
      id: component.props.id,
      actionName: component.name,
      args: component.props.args,
      output: component.props.output,
      status: component.props.status,
      error: component.props.error,
      isLoading: isRunning,
      key: `${component.name}${component.props.id}`,
    };
    return createElement(AgActionComponent, agActionComponentProps);
  }

  // For other components, use generic props
  return createElement(Component, {
    key: `${component.name}${component.props.id}`,
    id: component.props.id,
    ...component.props.args,
    status: component.props.status,
    isLoading: isRunning,
  });
};

const isValidProps = (
  props: unknown,
): props is ComponentProps<UIComponents[keyof UIComponents]> => {
  return typeof props === 'object' && props !== null;
};
