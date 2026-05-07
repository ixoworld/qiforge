import { mergeConfig } from 'vitest/config';
import nestConfig from '@ixo/vitest-config/nest';

export default mergeConfig(nestConfig, {
  test: {
    setupFiles: ['./test-setup.ts'],
  },
});
