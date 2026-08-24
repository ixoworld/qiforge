import { AIMessage } from '@langchain/core/messages';
import { SqliteSaver } from '../index';
import { checkpointWithMessages, message } from './fixtures';

const SUMMARY_PREFIX = 'Here is a summary of the conversation to date:';

describe('transcript survives summarization', () => {
  it('listThreadMessages returns every message after state is condensed to summary + tail', async () => {
    const saver = SqliteSaver.fromConnString(':memory:', {
      maxCheckpointsPerThread: 2,
    });
    const thread = { configurable: { thread_id: 'thread-1' } };

    // Six turns of cumulative history, like the graph reducer produces.
    const history = Array.from({ length: 6 }, (_, i) =>
      message(
        i % 2 === 0 ? 'human' : 'ai',
        `msg-${i}`,
        `turn ${i}`,
        `2024-04-19T17:19:${String(i).padStart(2, '0')}.000Z`,
      ),
    );
    for (let i = 0; i < history.length; i++) {
      await saver.put(
        thread,
        checkpointWithMessages(i, history.slice(0, i + 1)),
        {
          source: 'loop',
          step: i,
          parents: {},
        },
      );
    }

    // Summarization: state becomes [summary, last two turns].
    const summary = new AIMessage({
      id: 'summary-1',
      content: `${SUMMARY_PREFIX} turns 0-3 condensed`,
      additional_kwargs: {
        lc_source: 'summarization',
        timestamp: '2024-04-19T17:19:06.000Z',
      },
    });
    await saver.put(
      thread,
      checkpointWithMessages(6, [summary, history[4], history[5]]),
      { source: 'loop', step: 6, parents: {} },
    );

    const transcript = await saver.listThreadMessages('thread-1');
    expect(transcript.map((m) => m.content)).toEqual([
      'turn 0',
      'turn 1',
      'turn 2',
      'turn 3',
      'turn 4',
      'turn 5',
      `${SUMMARY_PREFIX} turns 0-3 condensed`,
    ]);

    // Pruning ran (cap 2 + slack) and did not touch the transcript.
    const count = saver.db
      .prepare(`SELECT COUNT(*) FROM checkpoints WHERE thread_id = ?`)
      .pluck()
      .get('thread-1');
    expect(count).toBeLessThanOrEqual(7);
  });
});
